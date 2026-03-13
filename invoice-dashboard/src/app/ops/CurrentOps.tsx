"use client";

import dynamic from "next/dynamic";
import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import type { Flight, OpsAlert, MxNote, SwimFlowEvent } from "@/lib/opsApi";
import type { AdvertisedPriceRow } from "@/lib/types";
import { FALLBACK_TAILS, BAKER_FLEET } from "@/lib/maintenanceData";
import type { AircraftPosition, FlightInfoMap } from "@/app/maintenance/MapView";
import { fmtTimeInTz, type TzMode } from "@/lib/airportTimezones";
import { getAirportInfo } from "@/lib/airportCoords";
import { TRIPS } from "@/lib/maintenanceData";
import { buildBestRateByAirport } from "@/lib/fuelLookup";

const OpsMap = dynamic(() => import("./OpsMap"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[500px] bg-gray-100 rounded-xl text-gray-500 text-sm">
      Loading map…
    </div>
  ),
});

/* ── helpers ──────────────────────────────────────── */

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

const FLIGHT_TYPE_COLORS: Record<string, string> = {
  Charter: "bg-blue-100 text-blue-700",
  Revenue: "bg-green-100 text-green-700",
  Positioning: "bg-amber-100 text-amber-700",
  Maintenance: "bg-purple-100 text-purple-700",
  Training: "bg-cyan-100 text-cyan-700",
};

const DEFAULT_TYPES = new Set(["Charter", "Revenue", "Positioning"]);

type TimeRange = "Today" | "Today + Tomorrow" | "Tomorrow" | "Week" | "Month";

function getTimeRange(range: TimeRange): { start: Date; end: Date } {
  // Use local (browser) date boundaries so "Today" = local calendar day
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart.getTime() + 86400000);
  const dayAfterTomorrow = new Date(todayStart.getTime() + 2 * 86400000);

  switch (range) {
    case "Today":
      return { start: todayStart, end: tomorrowStart };
    case "Today + Tomorrow":
      return { start: todayStart, end: dayAfterTomorrow };
    case "Tomorrow":
      return { start: tomorrowStart, end: dayAfterTomorrow };
    case "Week":
      return { start: todayStart, end: new Date(todayStart.getTime() + 7 * 86400000) };
    case "Month":
      return { start: todayStart, end: new Date(todayStart.getTime() + 30 * 86400000) };
  }
}

/** Find the salesperson for a flight by matching tail + origin + dest, or tail + date. */
function findSalesperson(
  tripSalespersons: TripSalesperson[],
  tailNumber: string | null,
  departureIcao: string | null,
  arrivalIcao: string | null,
  scheduledDeparture: string,
): string | null {
  if (!tailNumber) return null;
  // Exact leg match: tail + origin + dest
  for (const t of tripSalespersons) {
    if (
      t.tail_number === tailNumber &&
      t.origin_icao === departureIcao &&
      t.destination_icao === arrivalIcao
    ) {
      return t.salesperson_name;
    }
  }
  // Fallback: tail + same date
  const depDate = scheduledDeparture.split("T")[0];
  for (const t of tripSalespersons) {
    if (t.tail_number === tailNumber && t.scheduled_departure?.split("T")[0] === depDate) {
      return t.salesperson_name;
    }
  }
  return null;
}

/** Map ICAO type codes to fleet display names */
const FLEET_TYPE_LABELS: Record<string, string> = {
  C750: "Citation X",
  CL30: "Challenger 300",
  CL35: "Challenger 350",
};
function getFleetType(icaoType: string | null | undefined): string {
  if (!icaoType) return "Other";
  return FLEET_TYPE_LABELS[icaoType] ?? "Other";
}
/** Group order: Challenger first, then Citation X, then Other */
const FLEET_ORDER = ["Challenger 300", "Challenger 350", "Citation X", "Other"];

const DUTY_FLIGHT_TYPES = new Set(["revenue", "owner", "positioning", "ferry", "charter"]);
const MAX_LEG_DURATION_MIN = 12 * 60;
const MIN_REST_GAP_MS = 8 * 60 * 60 * 1000;
const LEAD_TIME_MS = 60 * 60 * 1000;  // 60min pre-duty (matches DutyTracker)
const POST_TIME_MS = 30 * 60 * 1000;  // 30min post-duty (matches DutyTracker)

type TailDutySummary = {
  flightTimeMin: number;
  restMin: number | null;
};

/** Compute per-tail 24hr flight time and crew rest from flights + FA data.
 *  Uses same 3-day window (yesterday→end of tomorrow) and FA matching as DutyTracker. */
function computeTailDuty(
  flights: Flight[],
  faFlights: FlightInfoMap[],
): Map<string, TailDutySummary> {
  const nowMs = Date.now();
  const WINDOW_MS = 24 * 60 * 60 * 1000;

  // 3-day window: yesterday 0000Z → end of tomorrow 2359Z (matches DutyTracker)
  const todayUtc = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const windowStart = todayUtc - WINDOW_MS;
  const windowEnd = todayUtc + 2 * WINDOW_MS;

  // Group FA data by tail (array per tail, matches DutyTracker)
  const faByTail = new Map<string, FlightInfoMap[]>();
  for (const fi of faFlights) {
    if (!fi.tail) continue;
    if (!faByTail.has(fi.tail)) faByTail.set(fi.tail, []);
    faByTail.get(fi.tail)!.push(fi);
  }

  // Build intervals per tail (only duty-relevant flight types)
  type DutyInterval = { startMs: number; endMs: number; depIcao: string | null; arrIcao: string | null; source: "actual" | "fa-estimate" | "scheduled" };
  const tailIntervals = new Map<string, DutyInterval[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    const ft = (f.flight_type ?? "").toLowerCase();
    if (ft && !DUTY_FLIGHT_TYPES.has(ft)) continue;

    // Match FA data: prefer exact route match, fall back to closest departure time
    const tailFaFlights = faByTail.get(f.tail_number) ?? [];
    let fi: FlightInfoMap | undefined;
    fi = tailFaFlights.find(
      (fa) => fa.origin_icao === f.departure_icao && fa.destination_icao === f.arrival_icao,
    );
    if (!fi && tailFaFlights.length > 0) {
      const schedMs = new Date(f.scheduled_departure).getTime();
      let bestDiff = Infinity;
      for (const fa of tailFaFlights) {
        const faDep = fa.departure_time ?? fa.actual_departure;
        if (!faDep) continue;
        const diff = Math.abs(new Date(faDep).getTime() - schedMs);
        if (diff < bestDiff && diff < 2 * 60 * 60 * 1000) {
          bestDiff = diff;
          fi = fa;
        }
      }
    }

    const actualDep = fi?.actual_departure ?? null;
    const actualArr = fi?.actual_arrival ?? null;
    const estimatedArr = fi?.arrival_time ?? null;

    const depMs = new Date(actualDep ?? f.scheduled_departure).getTime();
    let endMs: number;
    let source: "actual" | "fa-estimate" | "scheduled";
    if (actualArr) {
      source = "actual";
      endMs = new Date(actualArr).getTime();
    } else if (actualDep && !actualArr) {
      source = estimatedArr ? "fa-estimate" : "actual";
      endMs = estimatedArr ? new Date(estimatedArr).getTime() : nowMs;
    } else if (estimatedArr) {
      source = "fa-estimate";
      endMs = new Date(estimatedArr).getTime();
    } else {
      source = "scheduled";
      endMs = f.scheduled_arrival ? new Date(f.scheduled_arrival).getTime() : depMs;
    }

    let durMin = (endMs - depMs) / 60_000;

    // Sanity check: if FA-derived duration is wildly longer than scheduled,
    // FA likely has bad data (timezone issues, wrong flight match). Fall back to ICS.
    // Thresholds match DutyTracker: 1.5x or +90min.
    if (source !== "scheduled") {
      if (f.scheduled_arrival) {
        const schedDur = (new Date(f.scheduled_arrival).getTime() - new Date(f.scheduled_departure).getTime()) / 60_000;
        if (schedDur > 0 && durMin > Math.max(schedDur * 1.5, schedDur + 90)) {
          source = "scheduled";
          endMs = new Date(f.scheduled_arrival).getTime();
          durMin = (endMs - depMs) / 60_000;
        }
      } else if (durMin > 360) {
        // No scheduled arrival to compare — cap FA estimates at 6h (matches DutyTracker)
        source = "scheduled";
        durMin = 360;
        endMs = depMs + durMin * 60_000;
      }
    }

    if (durMin < 0) durMin = 0;
    if (durMin > MAX_LEG_DURATION_MIN) durMin = MAX_LEG_DURATION_MIN;
    endMs = depMs + durMin * 60_000;
    if (durMin <= 0) continue;

    // Filter: only include legs within the 3-day window
    if (endMs < windowStart || depMs > windowEnd) continue;

    if (!tailIntervals.has(f.tail_number)) tailIntervals.set(f.tail_number, []);
    tailIntervals.get(f.tail_number)!.push({ startMs: depMs, endMs, depIcao: f.departure_icao, arrIcao: f.arrival_icao, source });
  }

  const result = new Map<string, TailDutySummary>();

  for (const [tail, intervals] of tailIntervals) {
    intervals.sort((a, b) => a.startMs - b.startMs);
    // Dedup: matches DutyTracker — prefer actual/fa-estimate over scheduled for same route
    const deduped: DutyInterval[] = [];
    for (const leg of intervals) {
      const prev = deduped[deduped.length - 1];
      const sameRoute = prev && prev.depIcao === leg.depIcao && prev.arrIcao === leg.arrIcao;
      if (sameRoute && Math.abs(prev.startMs - leg.startMs) < 5 * 60_000) {
        continue; // skip near-duplicate
      }
      if (leg.source === "scheduled" && deduped.some((d) => d.depIcao === leg.depIcao && d.arrIcao === leg.arrIcao && (d.source === "actual" || d.source === "fa-estimate"))) {
        continue;
      }
      if (leg.source === "actual" || leg.source === "fa-estimate") {
        const schedIdx = deduped.findIndex((d) => d.depIcao === leg.depIcao && d.arrIcao === leg.arrIcao && d.source === "scheduled");
        if (schedIdx !== -1) {
          deduped.splice(schedIdx, 1);
        }
      }
      deduped.push(leg);
    }
    const finalIntervals = deduped;

    // --- Rolling 24hr flight time (Part 135.267: ANY 24 consecutive hours) ---
    const checkPoints = new Set<number>();
    for (const leg of finalIntervals) {
      checkPoints.add(leg.startMs);
      checkPoints.add(leg.endMs);
      checkPoints.add(leg.startMs + WINDOW_MS);
      checkPoints.add(leg.endMs + WINDOW_MS);
    }

    let maxMs = 0;
    for (const wp of checkPoints) {
      const ws = wp - WINDOW_MS;
      let totalMs = 0;
      for (const leg of finalIntervals) {
        const os = Math.max(leg.startMs, ws);
        const oe = Math.min(leg.endMs, wp);
        if (oe > os) totalMs += oe - os;
      }
      if (totalMs > maxMs) maxMs = totalMs;
    }

    // --- Crew rest: find the most recent completed rest period ---
    // Walk backwards to find the last rest gap (≥8h) before a leg that has started.
    // This shows how much rest the crew got before their current/most recent duty period.
    // Rest = dutyOff (prev arrival + 30min post) to dutyOn (next departure - 60min lead)
    // to match DutyTracker's calculation.
    let restMin: number | null = null;
    for (let i = finalIntervals.length - 2; i >= 0; i--) {
      const gapMs = finalIntervals[i + 1].startMs - finalIntervals[i].endMs;
      if (gapMs < MIN_REST_GAP_MS) continue;
      if (finalIntervals[i + 1].startMs <= nowMs) {
        const dutyOffMs = finalIntervals[i].endMs + POST_TIME_MS;
        const dutyOnMs = finalIntervals[i + 1].startMs - LEAD_TIME_MS;
        restMin = Math.max(0, (dutyOnMs - dutyOffMs) / 60_000);
        break;
      }
    }
    // Fallback: if no past rest found, show the upcoming rest
    if (restMin == null) {
      for (let i = 0; i < finalIntervals.length - 1; i++) {
        const gapMs = finalIntervals[i + 1].startMs - finalIntervals[i].endMs;
        if (gapMs >= MIN_REST_GAP_MS && finalIntervals[i + 1].startMs > nowMs) {
          const dutyOffMs = finalIntervals[i].endMs + POST_TIME_MS;
          const dutyOnMs = finalIntervals[i + 1].startMs - LEAD_TIME_MS;
          restMin = Math.max(0, (dutyOnMs - dutyOffMs) / 60_000);
          break;
        }
      }
    }

    result.set(tail, { flightTimeMin: maxMs / 60_000, restMin });
  }

  return result;
}

// Part 135.267(b)(2): 10h limit for two-pilot crew
type StatusLevel = "green" | "amber" | "red";

function dutyLevel(flightTimeMin: number): StatusLevel {
  if (flightTimeMin >= 600) return "red";    // >= 10h — exceeded
  if (flightTimeMin >= 540) return "amber";  // >= 9h (within 1h)
  return "green";
}

function restLevel(restMin: number | null): StatusLevel | null {
  if (restMin == null) return null;
  if (restMin <= 600) return "red";   // <= 10h — below minimum
  if (restMin <= 660) return "amber"; // 10-11h — approaching minimum
  return "green";                     // > 11h — good
}

const LEVEL_COLORS: Record<StatusLevel, string> = {
  green: "text-green-700 bg-green-50",
  amber: "text-amber-700 bg-amber-50",
  red: "text-red-700 bg-red-50",
};

const LEVEL_ICONS: Record<StatusLevel, string> = {
  green: "\u2705",  // green check
  amber: "\u26A0\uFE0F",   // warning
  red: "\uD83D\uDED1",     // stop sign
};

function dutyColor(flightTimeMin: number): string {
  return LEVEL_COLORS[dutyLevel(flightTimeMin)];
}

function restColor(restMin: number | null): string {
  const level = restLevel(restMin);
  if (!level) return "text-gray-400";
  return LEVEL_COLORS[level];
}

/** Delay color for actuals: early/≤15m green, 15-45m amber, >45m red */
function delayColorClass(scheduledIso: string, actualIso: string): string {
  const delayMin = (new Date(actualIso).getTime() - new Date(scheduledIso).getTime()) / 60_000;
  if (delayMin > 45) return "text-red-600";
  if (delayMin > 15) return "text-amber-600";
  return "text-green-600";
}

/** Look up FA data: try route-specific key first, fall back to tail-only if route matches */
function matchFlightInfo(
  map: Map<string, FlightInfoMap>,
  routeKey: string,
  tail: string,
  departureIcao: string | null,
  scheduledDep?: string,
): FlightInfoMap | undefined {
  const byRoute = map.get(routeKey);
  if (byRoute) return byRoute;
  // Tail-only fallback: only use if the FA flight's origin matches AND departure is within 6h
  const byTail = map.get(tail);
  if (byTail && departureIcao && byTail.origin_icao === departureIcao) {
    if (scheduledDep && byTail.departure_time) {
      const schedMs = new Date(scheduledDep).getTime();
      const faDepMs = new Date(byTail.departure_time).getTime();
      if (Math.abs(schedMs - faDepMs) > 6 * 3600_000) return undefined;
    }
    return byTail;
  }
  return undefined;
}

/** Delay color for departure estimates: only show if ≥15min late. Returns null if on-time. */
function depEstColorClass(scheduledIso: string, estIso: string): string | null {
  const delayMin = (new Date(estIso).getTime() - new Date(scheduledIso).getTime()) / 60_000;
  if (delayMin > 30) return "text-red-600 font-semibold";
  if (delayMin > 15) return "text-amber-700 font-semibold";
  return null; // on-time or early — don't show
}

function fmtHM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-200",
  low: "bg-blue-100 text-blue-800 border-blue-200",
};

/* ── component ──────────────────────────────────────── */

type TripSalesperson = {
  trip_id: string;
  tail_number: string;
  scheduled_departure: string | null;
  scheduled_arrival: string | null;
  origin_icao: string | null;
  destination_icao: string | null;
  salesperson_name: string;
  customer: string | null;
};

export type LongTermMxAircraft = {
  tail: string;
  reason: string;
  airport: string | null;
  mxDescription: string | null;
  startDate: string | null;
  endDate: string | null;
};

export default function CurrentOps({ flights, onSwitchToDuty, advertisedPrices = [], mxNotes = [], swimFlow = [] }: { flights: Flight[]; onSwitchToDuty?: (tail?: string) => void; advertisedPrices?: AdvertisedPriceRow[]; mxNotes?: MxNote[]; swimFlow?: SwimFlowEvent[] }) {
  const [enRouteAircraft, setAircraftPosition] = useState<AircraftPosition[]>([]);
  const [faFlightsRaw, setFaFlightsRaw] = useState<FlightInfoMap[]>([]);
  const [flightInfo, setFlightInfo] = useState<Map<string, FlightInfoMap>>(new Map());
  const [tripSalespersons, setTripSalespersons] = useState<TripSalesperson[]>([]);

  // SWIM flight status
  type SwimFlightStatus = { tail_number: string; departure_icao: string | null; arrival_icao: string | null; status: string; event_time: string; etd: string | null; eta: string | null };
  type FeedStatus = { name: string; status: "ok" | "error" | "off"; count: number; updated_at?: string; error?: string };
  const [swimStatus, setSwimStatus] = useState<Map<string, SwimFlightStatus>>(new Map());
  const [feedStatuses, setFeedStatuses] = useState<FeedStatus[]>([]);
  const [faFeedStatus, setFaFeedStatus] = useState<FeedStatus>({ name: "FlightAware", status: "off", count: 0 });
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(DEFAULT_TYPES);
  const [statusFilter, setStatusFilter] = useState<"all" | "scheduled" | "enroute" | "arrived">("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("Today");
  const [expandedFlights, setExpandedFlights] = useState<Set<string>>(new Set());
  const [localAckedIds, setLocalAckedIds] = useState<Set<string>>(new Set());
  const [holdingTails, setHoldingTails] = useState<Set<string>>(new Set());
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [tzMode, setTzMode] = useState<TzMode>("local");
  const [showActual, setShowActual] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "aircraft">("table");

  // Shorthand for formatting times — uses departure or arrival airport TZ
  const fmt = useCallback(
    (iso: string | null | undefined, icao?: string | null) =>
      fmtTimeInTz(iso, icao, true, tzMode),
    [tzMode],
  );

  const isAcked = useCallback(
    (a: OpsAlert) => a.acknowledged_at != null || localAckedIds.has(a.id),
    [localAckedIds],
  );

  const handleAck = useCallback((id: string) => {
    setLocalAckedIds((prev) => new Set(prev).add(id));
    fetch(`/api/ops/alerts/${id}/acknowledge`, { method: "POST" }).catch(() => {});
  }, []);

  // Fetch FlightAware data (primary source for both positions and flight info)
  const fetchFlightInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/flights", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        // Key by tail|origin|dest so each scheduled leg can find its FA match
        const map = new Map<string, FlightInfoMap>();
        const positions: AircraftPosition[] = [];
        for (const fi of data.flights ?? []) {
          const key = `${fi.tail}|${fi.origin_icao ?? ""}|${fi.destination_icao ?? ""}`;
          // Prefer the entry that's actively flying (has position or actual departure)
          const existing = map.get(key);
          const isMoreActive = !existing || fi.latitude != null || fi.actual_departure != null;
          if (isMoreActive) map.set(key, fi);
          // Also store by tail-only for fallback — prefer one with position
          if (!map.has(fi.tail) || (fi.latitude != null && fi.longitude != null)) {
            map.set(fi.tail, fi);
          }
          // Also index by ident (callsign) so lookups work either way
          if (fi.ident && fi.ident !== fi.tail) {
            const identKey = `${fi.ident}|${fi.origin_icao ?? ""}|${fi.destination_icao ?? ""}`;
            if (!map.has(identKey) || fi.latitude != null) map.set(identKey, fi);
            if (!map.has(fi.ident) || (fi.latitude != null && fi.longitude != null)) {
              map.set(fi.ident, fi);
            }
          }
          // Synthesize map positions from en-route flights
          if (fi.latitude != null && fi.longitude != null) {
            positions.push({
              tail: fi.tail,
              lat: fi.latitude,
              lon: fi.longitude,
              alt_baro: fi.altitude ?? null,
              gs: fi.groundspeed ?? null,
              track: fi.heading ?? null,
              baro_rate: null,
              on_ground: false,
              squawk: null,
              flight: fi.ident ?? null,
              seen: null,
              aircraft_type: null,
              description: null,
            });
          }
        }
        setFaFlightsRaw(data.flights ?? []);
        setFlightInfo(map);
        setAircraftPosition(positions);
        setLastUpdate(new Date());
        setFaFeedStatus({ name: "FlightAware", status: "ok", count: (data.flights ?? []).length, updated_at: new Date().toISOString() });
      } else {
        setFaFeedStatus({ name: "FlightAware", status: "error", count: 0, updated_at: new Date().toISOString(), error: `HTTP ${res.status}` });
      }
    } catch (err) {
      setFaFeedStatus({ name: "FlightAware", status: "error", count: 0, updated_at: new Date().toISOString(), error: String(err) });
    }
  }, []);

  // Fetch SWIM flight status
  const fetchSwimStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/swim-status", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        const STATUS_PRIORITY: Record<string, number> = { "En Route": 4, "Filed": 3, "Scheduled": 2, "Arrived": 1, "Cancelled": 0 };
        // JetInsight uses K-prefix for some airports that have different real ICAO codes
        // (e.g. KSJU instead of TJSJ). Generate alternate keys to match.
        const ICAO_ALIASES: Record<string, string> = {
          TJSJ: "KSJU", TIST: "KSTT", TISX: "KSTX", TJBQ: "KBQN", TJPS: "KPSE",
          MYNN: "KNAS", MWCR: "KGCM", TXKF: "KBDA", TAPA: "KANU",
        };
        const map = new Map<string, SwimFlightStatus>();
        for (const s of data.statuses ?? []) {
          // Route-specific key
          const key = `${s.tail_number}|${s.departure_icao ?? ""}|${s.arrival_icao ?? ""}`;
          map.set(key, s);
          // Also store with JetInsight K-prefix aliases
          const altDep = ICAO_ALIASES[s.departure_icao ?? ""];
          const altArr = ICAO_ALIASES[s.arrival_icao ?? ""];
          if (altDep || altArr) {
            const altKey = `${s.tail_number}|${altDep ?? s.departure_icao ?? ""}|${altArr ?? s.arrival_icao ?? ""}`;
            if (!map.has(altKey)) map.set(altKey, s);
          }
          // Tail-only key — prefer the most active status (En Route > Filed > etc.)
          const tailKey = `${s.tail_number}||`;
          const existing = map.get(tailKey);
          if (!existing || (STATUS_PRIORITY[s.status] ?? 0) > (STATUS_PRIORITY[existing.status] ?? 0)) {
            map.set(tailKey, s);
          }
        }
        setSwimStatus(map);
        if (data.feeds) setFeedStatuses(data.feeds);
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch trip-salesperson mappings
  const fetchTripSalespersons = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/trip-salespersons", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setTripSalespersons(data.trips ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  // Poll every 5 minutes
  useEffect(() => {
    fetchFlightInfo();
    fetchSwimStatus();
    fetchTripSalespersons();
    const interval = setInterval(fetchFlightInfo, 150_000); // 2.5 min — server cache is 3min
    const swimInterval = setInterval(fetchSwimStatus, 150_000); // 2.5 min same as FA
    const spInterval = setInterval(fetchTripSalespersons, 300_000);
    return () => { clearInterval(interval); clearInterval(swimInterval); clearInterval(spInterval); };
  }, [fetchFlightInfo, fetchSwimStatus, fetchTripSalespersons]);

  // Get all unique flight types
  const allTypes = useMemo(() => {
    const types = new Set<string>();
    for (const f of flights) {
      if (f.flight_type && f.flight_type !== "Other") types.add(f.flight_type);
    }
    return [...types].sort();
  }, [flights]);

  // Filter flights by time range and visible types, deduplicate, ordered by departure time
  const filteredFlights = useMemo(() => {
    const { start, end } = getTimeRange(timeRange);
    const seen = new Set<string>();
    return flights
      .filter((f) => {
        const type = f.flight_type || "Other";
        if (type === "Other") return false;
        if (!visibleTypes.has(type)) return false;
        const dep = new Date(f.scheduled_departure);
        if (dep < start || dep >= end) return false;
        // Deduplicate: same tail + route + departure time = same leg
        const dedupKey = `${f.tail_number}|${f.departure_icao}|${f.arrival_icao}|${f.scheduled_departure}|${f.flight_type}`;
        if (seen.has(dedupKey)) return false;
        seen.add(dedupKey);
        return true;
      })
      .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
  }, [flights, visibleTypes, timeRange]);

  // Detect legs superseded by FA (route changed after schedule) + inject FA replacement legs
  // Also detect diversions (FA says diverted — original destination gets strikethrough)
  const { displayFlights, supersededMap } = useMemo(() => {
    // Map from flight.id → { actualDest, diverted } for cancelled/diverted rendering
    const superseded = new Map<string, { actualDest: string | null; diverted: boolean }>();
    const replacements: Flight[] = [];
    const addedRoutes = new Set<string>();

    for (const f of filteredFlights) {
      if (!f.tail_number || !f.departure_icao) continue;

      // --- Diversion detection ---
      // If FA matched this leg's route but says it's diverted, mark it
      const routeKey = `${f.tail_number}|${f.departure_icao}|${f.arrival_icao ?? ""}`;
      const routeFi = flightInfo.get(routeKey);
      if (routeFi?.diverted && routeFi.destination_icao && routeFi.destination_icao !== f.arrival_icao) {
        superseded.set(f.id, { actualDest: routeFi.destination_icao, diverted: true });
        continue;
      }

      if (!f.arrival_icao) continue;

      // --- Route change detection ---
      if (flightInfo.has(routeKey)) continue; // Route matches FA — not superseded

      // Check tail's active FA flight
      const tailFi = flightInfo.get(f.tail_number);
      if (!tailFi) continue;
      if (tailFi.origin_icao !== f.departure_icao) continue;
      if (tailFi.destination_icao === f.arrival_icao) continue;

      const isActive = tailFi.actual_departure != null ||
        tailFi.status?.includes("En Route") ||
        (tailFi.status?.includes("Landed") && tailFi.actual_arrival != null);
      if (!isActive) continue;

      const faDepIso = tailFi.departure_time ?? tailFi.actual_departure;
      if (faDepIso) {
        const diff = Math.abs(new Date(faDepIso).getTime() - new Date(f.scheduled_departure).getTime());
        if (diff > 3 * 3600_000) continue;
      }

      superseded.set(f.id, { actualDest: tailFi.destination_icao, diverted: tailFi.diverted });

      // Inject replacement (once per route), skip if already in schedule
      const replRouteKey = `${f.tail_number}|${tailFi.origin_icao}|${tailFi.destination_icao}`;
      if (addedRoutes.has(replRouteKey)) continue;
      const existsInSchedule = filteredFlights.some(
        (ff) => ff.tail_number === f.tail_number &&
          ff.departure_icao === tailFi.origin_icao &&
          ff.arrival_icao === tailFi.destination_icao,
      );
      if (existsInSchedule) continue;

      addedRoutes.add(replRouteKey);
      replacements.push({
        id: `fa-${replRouteKey}`,
        ics_uid: "",
        tail_number: f.tail_number,
        departure_icao: tailFi.origin_icao,
        arrival_icao: tailFi.destination_icao,
        scheduled_departure: faDepIso ?? f.scheduled_departure,
        scheduled_arrival: tailFi.arrival_time ?? null,
        summary: null,
        flight_type: f.flight_type,
        pic: null,
        sic: null,
        pax_count: null,
        jetinsight_url: null,
        alerts: [],
      });
    }

    // Build replacement lookup: cancelled flight id → replacement flight
    const replacementFor = new Map<string, Flight>();
    for (const r of replacements) {
      // Find the cancelled flight this replaces (same tail + origin)
      for (const [fid, info] of superseded) {
        const orig = filteredFlights.find((ff) => ff.id === fid);
        if (orig && orig.tail_number && r.tail_number === orig.tail_number &&
            r.departure_icao === orig.departure_icao && r.arrival_icao === info.actualDest) {
          replacementFor.set(fid, r);
          break;
        }
      }
    }

    // Insert replacements directly after their cancelled leg
    const all: Flight[] = [];
    const inserted = new Set<string>();
    for (const f of filteredFlights) {
      all.push(f);
      const repl = replacementFor.get(f.id);
      if (repl) { all.push(repl); inserted.add(repl.id); }
    }
    // Add any remaining replacements that weren't paired
    for (const r of replacements) {
      if (!inserted.has(r.id)) all.push(r);
    }
    return { displayFlights: all, supersededMap: superseded };
  }, [filteredFlights, flightInfo]);

  // Compute flight status for each displayed flight (used for status filter + rendering)
  const flightStatusMap = useMemo(() => {
    const map = new Map<string, "scheduled" | "enroute" | "arrived">();
    const now = new Date();
    for (const f of displayFlights) {
      const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
      const fi = f.tail_number ? matchFlightInfo(flightInfo, routeKey, f.tail_number, f.departure_icao, f.scheduled_departure) : undefined;
      const arrivalDate = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
      const arrivalPassed = arrivalDate && arrivalDate < now;

      // Check SWIM status first (before FA) — try route-specific, then tail-only fallback
      const swim = swimStatus.get(routeKey) ?? (f.tail_number ? swimStatus.get(`${f.tail_number}||`) : undefined);

      if (fi?.diverted || supersededMap.has(f.id)) {
        map.set(f.id, "arrived"); // treat cancelled/diverted as "arrived" bucket
      } else if (swim?.status === "En Route") {
        map.set(f.id, "enroute");
      } else if (swim?.status === "Arrived") {
        map.set(f.id, "arrived");
      } else if (swim?.status === "Filed") {
        map.set(f.id, "scheduled"); // filed = scheduled bucket
      } else if (fi?.status?.includes("En Route") || (f.tail_number && holdingTails.has(f.tail_number) && fi?.status?.includes("En Route"))) {
        map.set(f.id, "enroute");
      } else if (fi?.status?.includes("Arrived") || fi?.status?.includes("Landed") || fi?.actual_arrival || arrivalPassed) {
        map.set(f.id, "arrived");
      } else {
        map.set(f.id, "scheduled");
      }
    }
    return map;
  }, [displayFlights, flightInfo, swimStatus, supersededMap, holdingTails]);

  // Apply status filter to displayFlights
  const statusFilteredFlights = useMemo(() => {
    if (statusFilter === "all") return displayFlights;
    return displayFlights.filter((f) => flightStatusMap.get(f.id) === statusFilter);
  }, [displayFlights, statusFilter, flightStatusMap]);

  // Build tail → fleet type lookup from FlightAware data
  const tailFleetType = useMemo(() => {
    const map = new Map<string, string>();
    for (const fi of flightInfo.values()) {
      if (fi.tail && fi.aircraft_type && !map.has(fi.tail)) {
        map.set(fi.tail, getFleetType(fi.aircraft_type));
      }
    }
    return map;
  }, [flightInfo]);

  // Long-term maintenance detection
  const longTermMxAircraft = useMemo(() => {
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const result: LongTermMxAircraft[] = [];
    const qualifiedTails = new Set<string>();

    // Collect all known fleet tails
    const allTails = new Set<string>([...FALLBACK_TAILS, ...BAKER_FLEET]);
    for (const f of flights) {
      if (f.tail_number) allTails.add(f.tail_number);
    }

    // 1. Check MX_NOTE alerts with span > 3 days
    for (const note of mxNotes) {
      if (!note.tail_number || qualifiedTails.has(note.tail_number)) continue;
      if (note.start_time && note.end_time) {
        const span = new Date(note.end_time).getTime() - new Date(note.start_time).getTime();
        if (span > THREE_DAYS_MS) {
          qualifiedTails.add(note.tail_number);
          result.push({
            tail: note.tail_number,
            reason: "MX event >3 days",
            airport: note.airport_icao,
            mxDescription: note.subject || note.body,
            startDate: note.start_time,
            endDate: note.end_time,
          });
        }
      }
    }

    // 2. Check MX flights spanning >3 days (same departure/arrival = stationary MX)
    const mxFlightsByTail = new Map<string, Flight[]>();
    for (const f of flights) {
      if (!f.tail_number || qualifiedTails.has(f.tail_number)) continue;
      if (f.flight_type === "Maintenance") {
        if (!mxFlightsByTail.has(f.tail_number)) mxFlightsByTail.set(f.tail_number, []);
        mxFlightsByTail.get(f.tail_number)!.push(f);
      }
    }
    for (const [tail, mxFlights] of mxFlightsByTail) {
      if (qualifiedTails.has(tail)) continue;
      const sorted = [...mxFlights].sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
      if (sorted.length > 0) {
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const endTime = last.scheduled_arrival ?? last.scheduled_departure;
        const span = new Date(endTime).getTime() - new Date(first.scheduled_departure).getTime();
        if (span > THREE_DAYS_MS && first.departure_icao === first.arrival_icao) {
          qualifiedTails.add(tail);
          result.push({
            tail,
            reason: "MX flights >3 days",
            airport: first.departure_icao,
            mxDescription: first.summary,
            startDate: first.scheduled_departure,
            endDate: endTime,
          });
        }
      }
    }

    // 3. Check for tails with zero non-MX flights in next 3 days
    const threeDaysOut = now + THREE_DAYS_MS;
    for (const tail of allTails) {
      if (qualifiedTails.has(tail)) continue;
      const hasNonMxFlight = flights.some(
        (f) =>
          f.tail_number === tail &&
          f.flight_type !== "Maintenance" &&
          new Date(f.scheduled_departure).getTime() >= now &&
          new Date(f.scheduled_departure).getTime() <= threeDaysOut,
      );
      if (!hasNonMxFlight) {
        let lastAirport: string | null = null;
        let lastMxNote: MxNote | undefined;
        for (const f of flights) {
          if (f.tail_number === tail && f.arrival_icao) {
            lastAirport = f.arrival_icao;
          }
        }
        lastMxNote = mxNotes.find((n) => n.tail_number === tail);
        qualifiedTails.add(tail);
        result.push({
          tail,
          reason: "No flights for 3+ days",
          airport: lastMxNote?.airport_icao ?? lastAirport,
          mxDescription: lastMxNote?.subject ?? null,
          startDate: null,
          endDate: null,
        });
      }
    }

    return result;
  }, [flights, mxNotes]);

  // Set of tails in long-term MX (to exclude from normal views)
  const longTermMxTails = useMemo(
    () => new Set(longTermMxAircraft.map((a) => a.tail)),
    [longTermMxAircraft],
  );

  // Flights for the table view — exclude long-term MX tails
  const tableFlights = useMemo(() => {
    return statusFilteredFlights.filter(
      (f) => !f.tail_number || !longTermMxTails.has(f.tail_number),
    );
  }, [statusFilteredFlights, longTermMxTails]);

  // Group filtered flights by fleet type → tail for aircraft card view
  // Exclude long-term MX tails from normal fleet groups
  const flightsByFleetType = useMemo(() => {
    // First group by tail
    const byTail = new Map<string, Flight[]>();
    for (const f of statusFilteredFlights) {
      const tail = f.tail_number || "Unassigned";
      if (tail !== "Unassigned" && longTermMxTails.has(tail)) continue;
      if (!byTail.has(tail)) byTail.set(tail, []);
      byTail.get(tail)!.push(f);
    }
    for (const legs of byTail.values()) {
      legs.sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
    }
    // Group tails by fleet type, sort tails alphabetically within each type
    const groups = new Map<string, [string, Flight[]][]>();
    for (const [tail, legs] of byTail) {
      const fleetType = tailFleetType.get(tail) ?? "Other";
      if (!groups.has(fleetType)) groups.set(fleetType, []);
      groups.get(fleetType)!.push([tail, legs]);
    }
    for (const tails of groups.values()) {
      tails.sort((a, b) => a[0].localeCompare(b[0]));
    }
    // Sort groups by FLEET_ORDER
    return [...groups.entries()].sort(
      (a, b) => (FLEET_ORDER.indexOf(a[0]) === -1 ? 99 : FLEET_ORDER.indexOf(a[0]))
              - (FLEET_ORDER.indexOf(b[0]) === -1 ? 99 : FLEET_ORDER.indexOf(b[0]))
    );
  }, [statusFilteredFlights, tailFleetType, longTermMxTails]);

  function toggleExpanded(flightId: string) {
    setExpandedFlights((prev) => {
      const next = new Set(prev);
      if (next.has(flightId)) next.delete(flightId);
      else next.add(flightId);
      return next;
    });
  }

  function toggleType(type: string) {
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  // Compute parked aircraft positions from schedule + FA data
  const parkedAircraft = useMemo(() => {
    const flyingTails = new Set(enRouteAircraft.map((a) => a.tail));
    const now = new Date();
    const parked: AircraftPosition[] = [];
    // For each tail, find its most likely current location:
    // 1. Last arrived leg (arrival in the past)
    // 2. Next departing leg (departure in the future — they're parked at that airport)
    const tailLocation = new Map<string, { icao: string; time: Date; source: string }>();

    for (const f of flights) {
      if (!f.tail_number) continue;
      if (flyingTails.has(f.tail_number)) continue; // currently airborne

      // Option A: past arrival — aircraft is at arrival airport
      if (f.arrival_icao) {
        const arrTime = new Date(f.scheduled_arrival ?? f.scheduled_departure);
        if (arrTime <= now) {
          const existing = tailLocation.get(f.tail_number);
          if (!existing || arrTime > existing.time) {
            tailLocation.set(f.tail_number, { icao: f.arrival_icao, time: arrTime, source: `Arrived at ${f.arrival_icao}` });
          }
        }
      }

      // Option B: future departure — aircraft is at departure airport
      // Only use this if we don't already have a more recent arrival
      if (f.departure_icao) {
        const depTime = new Date(f.scheduled_departure);
        if (depTime > now) {
          const existing = tailLocation.get(f.tail_number);
          // Use departure airport if no arrival data, or if this departure is sooner (next leg)
          if (!existing) {
            tailLocation.set(f.tail_number, { icao: f.departure_icao, time: depTime, source: `Next dep from ${f.departure_icao}` });
          }
        }
      }
    }

    // Also include fleet tails from TRIPS that have no scheduled flights
    // Use the most recent trip's destination as their parked location
    const allTailsOnMap = new Set([...flyingTails, ...tailLocation.keys()]);
    const tripsByTail = new Map<string, { to: string; tripEnd: string }>();
    for (const trip of TRIPS) {
      if (allTailsOnMap.has(trip.tail)) continue;
      if (trip.status === "Cancelled" || trip.status === "Declined") continue;
      const existing = tripsByTail.get(trip.tail);
      if (!existing || trip.tripEnd > existing.tripEnd) {
        tripsByTail.set(trip.tail, { to: trip.to, tripEnd: trip.tripEnd });
      }
    }
    for (const [tail, { to }] of tripsByTail) {
      const code = to.startsWith("K") ? to.slice(1) : to;
      tailLocation.set(tail, { icao: to, time: new Date(0), source: `Last trip to ${code}` });
    }

    for (const [tail, { icao, source }] of tailLocation) {
      const code = icao.startsWith("K") ? icao.slice(1) : icao;
      const info = getAirportInfo(code) ?? getAirportInfo(icao);
      if (info) {
        parked.push({
          tail,
          lat: info.lat,
          lon: info.lon,
          alt_baro: 0,
          gs: 0,
          track: null,
          baro_rate: null,
          on_ground: true,
          squawk: null,
          flight: null,
          seen: null,
          aircraft_type: null,
          description: source,
        });
      }
    }
    return parked;
  }, [flights, enRouteAircraft]);

  // Combine flying + parked for the map
  const allMapAircraft = useMemo(() => [...enRouteAircraft, ...parkedAircraft], [enRouteAircraft, parkedAircraft]);

  // Per-tail duty summary (24hr flight time + crew rest)
  const tailDuty = useMemo(() => computeTailDuty(flights, faFlightsRaw), [flights, faFlightsRaw]);

  // Best advertised fuel rate per airport
  const bestFuelByAirport = useMemo(() => buildBestRateByAirport(advertisedPrices), [advertisedPrices]);

  // Count airborne vs on-ground
  const airborne = enRouteAircraft.length;
  const onGround = parkedAircraft.length;

  // Collect same-day EDCT alerts across all flights
  const edctAlerts = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);
    const alerts: (OpsAlert & { route: string; fallback_departure?: string })[] = [];
    for (const f of flights) {
      for (const a of f.alerts) {
        if (a.alert_type !== "EDCT") continue;
        if (!showAcknowledged && isAcked(a)) continue;
        // Only show EDCTs for today's flights
        const dep = new Date(a.edct_time ?? a.original_departure_time ?? f.scheduled_departure);
        if (dep < todayStart || dep >= tomorrowStart) continue;
        const route = [f.departure_icao, f.arrival_icao].filter(Boolean).join(" → ") || "Unknown";
        alerts.push({ ...a, route, fallback_departure: f.scheduled_departure ?? undefined });
      }
    }
    return alerts;
  }, [flights, isAcked, showAcknowledged]);

  return (
    <div className="space-y-4">
      {/* ── Status bar ── */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span className="font-medium text-gray-700">{airborne} airborne</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-gray-400" />
            <span className="text-gray-500">{onGround} on ground</span>
          </span>
          <span className="text-gray-400">·</span>
          <span className="text-gray-400">{statusFilteredFlights.length} flights{statusFilter !== "all" ? ` (${statusFilter})` : ""}</span>
        </div>
        {lastUpdate && (
          <span className="ml-auto text-xs text-gray-400">
            Updated {lastUpdate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        )}
      </div>

      {/* ── EDCT + Feed Status side by side ── */}
      <div className="grid grid-cols-2 gap-3">
        {/* EDCT Status */}
        {edctAlerts.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            <span className="font-medium text-green-800">No active EDCTs</span>
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-center gap-2 mb-2 text-sm">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
              <span className="font-semibold text-amber-800">
                {edctAlerts.length} Active EDCT{edctAlerts.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="space-y-1.5">
              {edctAlerts.map((a) => (
                <div key={a.id} className={`flex items-center gap-3 text-sm text-amber-900 ${isAcked(a) ? "opacity-50" : ""}`}>
                  <span className="font-medium">{a.route}</span>
                  {a.tail_number && <span className="text-amber-600">{a.tail_number}</span>}
                  <span className="text-sm">
                    {(a.original_departure_time || a.fallback_departure) && (
                      <span className="text-amber-500 line-through">{fmt(a.original_departure_time ?? a.fallback_departure ?? "", a.airport_icao)}</span>
                    )}
                    {(a.original_departure_time || a.fallback_departure) && <span className="text-amber-400 mx-0.5">→</span>}
                    <span className="text-amber-800 font-bold">{a.edct_time ? fmt(a.edct_time, a.airport_icao) : "—"}</span>
                  </span>
                  {isAcked(a) ? (
                    <span className="ml-auto text-xs text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">Ack'd</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleAck(a.id)}
                      className="ml-auto text-xs text-gray-500 hover:text-green-700 hover:bg-green-50 border border-gray-200 hover:border-green-300 rounded px-1.5 py-0.5 transition-colors"
                    >
                      Ack
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Feed Status */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <div className="flex items-center gap-2 mb-2 text-sm">
            <span className="font-semibold text-gray-700">Feed Status</span>
          </div>
          <div className="space-y-1.5">
            {[...feedStatuses, faFeedStatus].map((feed) => {
              const fmtTime = feed.updated_at ? new Date(feed.updated_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
              const dotColor = feed.status === "ok" ? "bg-green-500" : feed.status === "error" ? "bg-red-500" : "bg-gray-300";
              const textColor = feed.status === "ok" ? "text-green-600" : feed.status === "error" ? "text-red-500" : "text-gray-400";
              return (
                <div key={feed.name} className="flex items-center gap-2 text-sm">
                  <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                  <span className="font-medium text-gray-700">{feed.name}</span>
                  <span className={`text-xs ml-auto ${textColor}`}>
                    {feed.status === "ok" && fmtTime ? fmtTime : feed.status === "error" ? "Error" : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── SWIM Flow Control (GDP, Ground Stops, CTOPs) ── */}
      {swimFlow.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-center gap-2 mb-2 text-sm">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="font-semibold text-red-800">
              {swimFlow.length} Active Flow Control{swimFlow.length !== 1 ? " Events" : " Event"}
            </span>
            <span className="ml-auto text-xs text-red-400">via FAA SWIM</span>
          </div>
          <div className="space-y-1.5">
            {swimFlow.map((ev) => (
              <div key={ev.id} className="flex items-center gap-3 text-sm text-red-900">
                <span className={`px-1.5 py-0.5 rounded text-xs font-bold uppercase ${
                  ev.event_type === "GROUND_STOP" ? "bg-red-200 text-red-800" :
                  ev.event_type === "GDP" ? "bg-amber-200 text-amber-800" :
                  "bg-orange-200 text-orange-800"
                }`}>
                  {ev.event_type.replace(/_/g, " ")}
                </span>
                {ev.airport_icao && <span className="font-medium">{ev.airport_icao}</span>}
                <span className="text-red-700">{ev.subject}</span>
                {ev.expires_at && (
                  <span className="ml-auto text-xs text-red-400">
                    until {new Date(ev.expires_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Map ── */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <OpsMap aircraft={allMapAircraft} flightInfo={flightInfo} onHoldingDetected={setHoldingTails} />
      </div>

      {/* ── Filters row ── */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Time range */}
        <div className="flex items-center gap-1">
          {(["Today", "Today + Tomorrow", "Tomorrow", "Week", "Month"] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                timeRange === r
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <span className="text-gray-300">|</span>

        {/* Timezone selector */}
        <select
          value={tzMode}
          onChange={(e) => setTzMode(e.target.value as TzMode)}
          className="px-3 py-1 text-xs font-medium rounded-full bg-gray-900 text-white border-0 cursor-pointer appearance-none pr-6"
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath fill='white' d='M0 0l4 5 4-5z'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 8px center" }}
        >
          <option value="local">Local Time</option>
          <option value="UTC">UTC / Zulu</option>
          <option value="AST">Atlantic</option>
          <option value="EST">Eastern</option>
          <option value="CST">Central</option>
          <option value="MST">Mountain</option>
          <option value="AZT">Arizona</option>
          <option value="PST">Pacific</option>
          <option value="AKST">Alaska</option>
        </select>

        {/* View mode toggle */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">View:</span>
          <button
            onClick={() => setViewMode("table")}
            className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
              viewMode === "table" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            Table
          </button>
          <button
            onClick={() => setViewMode("aircraft")}
            className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
              viewMode === "aircraft" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            By Aircraft
          </button>
        </div>

        <span className="text-gray-300">|</span>

        {/* Actual times toggle */}
        <button
          onClick={() => setShowActual((v) => !v)}
          className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
            showActual
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
          }`}
        >
          {showActual ? "Actual Times" : "Scheduled Times"}
        </button>

        <span className="text-gray-300">|</span>

        {/* Flight type filters */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Type:</span>
          {allTypes.map((type) => {
            const active = visibleTypes.has(type);
            const colorClass = FLIGHT_TYPE_COLORS[type] || "bg-gray-100 text-gray-700";
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                  active ? colorClass : "bg-gray-100 text-gray-400 opacity-50"
                }`}
              >
                {type}
              </button>
            );
          })}
        </div>

        <span className="text-gray-300">|</span>

        {/* Status filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Status:</span>
          {([["all", "All"], ["scheduled", "Scheduled"], ["enroute", "En Route"], ["arrived", "Arrived"]] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setStatusFilter(val)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                statusFilter === val
                  ? val === "enroute" ? "bg-blue-100 text-blue-700"
                  : val === "arrived" ? "bg-green-100 text-green-700"
                  : val === "scheduled" ? "bg-gray-200 text-gray-700"
                  : "bg-gray-800 text-white"
                  : "bg-gray-100 text-gray-400 opacity-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Aircraft Card View — grouped by fleet type ── */}
      {viewMode === "aircraft" && (
        <div className="space-y-6">
          {flightsByFleetType.map(([fleetType, tails]) => (
            <div key={fleetType}>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-sm font-bold text-gray-800">{fleetType}</h3>
                <span className="text-xs text-gray-400">{tails.length} aircraft</span>
              </div>
              <div className="grid grid-cols-1 gap-4">
                {tails.map(([tail, tailFlights]) => {
                  const duty = tailDuty.get(tail);
                  return (
                    <div key={tail} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                        <span className="inline-flex items-center gap-1.5 font-mono font-bold text-gray-900">
                          {tail}
                          {(() => {
                            const tailFi = flightInfo.get(tail);
                            if (tailFi?.diverted) return (
                              <span className="relative flex h-2.5 w-2.5" title="DIVERTED">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                              </span>
                            );
                            return null;
                          })()}
                        </span>
                        <div className="flex items-center gap-2">
                          {duty && (
                            <>
                              <button
                                onClick={() => onSwitchToDuty?.(tail)}
                                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded cursor-pointer hover:opacity-80 transition-opacity ${dutyColor(duty.flightTimeMin)}`}
                                title="View detailed 10/24 breakdown"
                              >
                                <span className="text-[10px]">{LEVEL_ICONS[dutyLevel(duty.flightTimeMin)]}</span>
                                {fmtHM(duty.flightTimeMin)}
                              </button>
                              {duty.restMin != null && (() => {
                                const rl = restLevel(duty.restMin);
                                if (!rl) return null;
                                return (
                                  <button
                                    onClick={() => onSwitchToDuty?.(tail)}
                                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded cursor-pointer hover:opacity-80 transition-opacity ${LEVEL_COLORS[rl]}`}
                                    title="View detailed crew rest breakdown"
                                  >
                                    <span className="text-[10px]">{LEVEL_ICONS[rl]}</span>
                                    R:{fmtHM(duty.restMin!)}
                                  </button>
                                );
                              })()}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {tailFlights.map((f) => {
                          const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
                          const fi = f.tail_number ? matchFlightInfo(flightInfo, routeKey, f.tail_number, f.departure_icao, f.scheduled_departure) : undefined;
                          const type = f.flight_type || "Other";
                          const typeColor = FLIGHT_TYPE_COLORS[type] || "bg-gray-100 text-gray-700";

                          let status = "Scheduled";
                          let statusColor = "text-gray-500";
                          let isFiled = false;
                          const arrivalDate = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
                          const now = new Date();
                          const arrivalPassed = arrivalDate && arrivalDate < now;
                          // Check SWIM status first — try route-specific, then tail-only
                          const swimRouteMatch = swimStatus.get(routeKey);
                          const swimEntry = swimRouteMatch ?? (f.tail_number ? swimStatus.get(`${f.tail_number}||`) : undefined);
                          if (swimEntry?.status === "Filed") {
                            status = "Scheduled"; isFiled = true; statusColor = "text-gray-500";
                          } else if (swimEntry?.status === "En Route") {
                            status = "En Route"; statusColor = "text-blue-600 font-medium";
                          } else if (swimEntry?.status === "Arrived") {
                            status = "Arrived"; statusColor = "text-green-600 font-medium";
                          } else if (swimEntry?.status === "Diverted") {
                            status = "DIVERTED"; statusColor = "text-red-600 font-bold";
                          } else if (swimEntry?.status === "Cancelled") {
                            status = "Cancelled"; statusColor = "text-red-600 font-medium";
                          } else if (fi?.status) {
                            status = fi.status;
                            if (fi.status.includes("En Route")) statusColor = "text-blue-600 font-medium";
                            if (fi.status.includes("Arrived") || fi.status.includes("Landed")) statusColor = "text-green-600 font-medium";
                            if (fi.status === "Filed") { isFiled = true; statusColor = "text-indigo-600 font-medium"; }
                          } else if (fi?.actual_arrival) {
                            status = "Arrived";
                            statusColor = "text-green-600 font-medium";
                          } else if (status === "Scheduled" && f.tail_number && enRouteAircraft.some((p) => p.tail === f.tail_number)) {
                            status = "En Route";
                            statusColor = "text-blue-600 font-medium";
                          }
                          // If scheduled arrival has passed and still Scheduled/En Route, it arrived
                          if (arrivalPassed && (status === "Scheduled" || status === "En Route")) {
                            status = "Arrived";
                            statusColor = "text-green-600 font-medium";
                          }
                          if (fi?.diverted) { status = "DIVERTED"; statusColor = "text-red-600 font-bold"; }
                          else if (f.tail_number && holdingTails.has(f.tail_number) && status === "En Route") { status = "HOLDING"; statusColor = "text-red-600 font-bold animate-pulse"; }

                          const supersedInfo = supersededMap.get(f.id);
                          const isCancelled = !!supersedInfo;
                          const isFaSourced = f.id.startsWith("fa-");
                          if (isCancelled) {
                            status = supersedInfo.diverted ? "DIVERTED" : "Cancelled";
                            statusColor = "text-red-600 font-medium";
                          }

                          const actualDepIso = isCancelled ? null : (fi?.actual_departure ?? null);
                          const actualArrIso = isCancelled ? null : (fi?.actual_arrival ?? null);

                          return (
                            <div key={f.id} className={`px-4 py-2 text-xs ${isCancelled ? "opacity-50 bg-gray-50" : ""} ${isFaSourced ? "bg-blue-50/40" : ""}`}>
                              <div className="flex items-center gap-3">
                                <span className="font-mono font-medium w-28 shrink-0 text-gray-800">
                                  {f.departure_icao || "?"} →{" "}
                                  {isCancelled ? (
                                    <>
                                      <span className="line-through text-red-400">{f.arrival_icao || "?"}</span>
                                      {supersedInfo.actualDest && (
                                        <span className="text-red-600 font-bold ml-1">{supersedInfo.actualDest}</span>
                                      )}
                                    </>
                                  ) : (f.arrival_icao || "?")}
                                </span>
                                <div className="w-36 shrink-0">
                                  <div className="text-gray-500">
                                    {fmt(f.scheduled_departure, f.departure_icao)}
                                  </div>
                                  {!isCancelled && actualDepIso ? (
                                    <div className={`text-[10px] font-medium ${delayColorClass(f.scheduled_departure, actualDepIso)}`}>
                                      Actual: {fmt(actualDepIso, f.departure_icao)}
                                    </div>
                                  ) : null}
                                </div>
                                <div className="w-36 shrink-0">
                                  <div className="text-gray-500">
                                    {fmt(f.scheduled_arrival, f.arrival_icao)}
                                  </div>
                                  {!isCancelled && actualArrIso && f.scheduled_arrival ? (
                                    <div className={`text-[10px] font-medium ${delayColorClass(f.scheduled_arrival, actualArrIso)}`}>
                                      Actual: {fmt(actualArrIso, f.arrival_icao)}
                                    </div>
                                  ) : !isCancelled && fi?.arrival_time && fi?.actual_departure && !actualArrIso ? (
                                    <div className="text-[10px] text-blue-600 font-medium">
                                      ETA: {fmt(fi.arrival_time, f.arrival_icao)}
                                    </div>
                                  ) : !isCancelled && status === "En Route" && swimRouteMatch?.eta ? (
                                    <div className="text-[10px] text-blue-600 font-medium">
                                      ETA: {fmt(swimRouteMatch.eta, f.arrival_icao)}
                                    </div>
                                  ) : null}
                                </div>
                                <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${typeColor}`}>
                                  {type}
                                </span>
                                <span className={`text-xs ${statusColor}`}>{status}</span>
                                {isFiled && status === "Scheduled" && (
                                  <span className="text-[10px] text-indigo-500">
                                    IFR Filed{swimEntry?.etd ? ` ${fmt(swimEntry.etd, f.departure_icao)}` : ""}
                                  </span>
                                )}
                                {isFaSourced && (
                                  <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-100 text-blue-700">FA</span>
                                )}
                                {!isCancelled && fi?.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100 && (
                                  <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                    <div className="h-full bg-blue-500 rounded-full" style={{ width: `${fi.progress_percent}%` }} />
                                  </div>
                                )}
                                {/* ForeFlight progress fallback — only when displayed status is En Route */}
                                {!isCancelled && status === "En Route" && !(fi?.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100) && swimRouteMatch?.etd && swimRouteMatch?.eta && (() => {
                                  const dep = new Date(swimRouteMatch.etd!).getTime();
                                  const arr = new Date(swimRouteMatch.eta!).getTime();
                                  const total = arr - dep;
                                  const elapsed = Date.now() - dep;
                                  if (total <= 0 || elapsed <= 0) return null;
                                  const pct = Math.min(Math.max(Math.round((elapsed / total) * 100), 1), 99);
                                  return (
                                    <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                                    </div>
                                  );
                                })()}
                                {(() => {
                                  const arrCode = f.arrival_icao?.toUpperCase();
                                  if (!arrCode) return null;
                                  const rate = bestFuelByAirport.get(arrCode) ?? bestFuelByAirport.get(arrCode.length === 4 && arrCode.startsWith("K") ? arrCode.slice(1) : `K${arrCode}`);
                                  if (!rate) return null;
                                  return (
                                    <div className="ml-auto border-l border-gray-200 pl-3 text-right shrink-0">
                                      <div className="text-xs font-semibold text-gray-600">{rate.fbo ?? rate.vendor}</div>
                                      {rate.fbo && <div className="text-[10px] text-gray-400">{rate.vendor}</div>}
                                      <div className="text-xs font-mono font-medium text-gray-900">${rate.price.toFixed(2)}</div>
                                    </div>
                                  );
                                })()}
                                {(() => {
                                  const schedMs = new Date(f.scheduled_departure).getTime();
                                  const now = Date.now();
                                  if (schedMs < now && !fi?.actual_departure && status === "Scheduled") {
                                    const lateMin = Math.round((now - schedMs) / 60_000);
                                    return (
                                      <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${lateMin > 30 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                                        Not airborne +{lateMin}m
                                      </span>
                                    );
                                  }
                                  return null;
                                })()}
                              </div>
                            </div>
                          );
                        })}
                        {(timeRange === "Today + Tomorrow" || timeRange === "Tomorrow") && (() => {
                          const tomorrow = new Date();
                          tomorrow.setDate(tomorrow.getDate() + 1);
                          const tomorrowStr = [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, "0"), String(tomorrow.getDate()).padStart(2, "0")].join("-");
                          const hasTomorrow = tailFlights.some((f) => f.scheduled_departure.startsWith(tomorrowStr));
                          if (!hasTomorrow) {
                            return (
                              <div className="px-4 py-2 text-xs text-gray-400 italic border-t border-dashed border-gray-200">
                                No legs scheduled tomorrow
                              </div>
                            );
                          }
                          return null;
                        })()}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {flightsByFleetType.length === 0 && (
            <div className="text-center text-gray-400 py-8">
              No flights scheduled
            </div>
          )}
        </div>
      )}

      {/* ── Schedule table ── */}
      {viewMode === "table" && (
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <colgroup>
            <col style={{ width: "9%" }} />   {/* Status */}
            <col style={{ width: "7%" }} />   {/* Tail */}
            <col style={{ width: "11%" }} />  {/* Route */}
            <col style={{ width: "13%" }} />  {/* Departure */}
            <col style={{ width: "13%" }} />  {/* Arrival */}
            <col style={{ width: "7%" }} />   {/* Type */}
            <col style={{ width: "5%" }} />   {/* 10/24 */}
            <col style={{ width: "5%" }} />   {/* Rest */}
            <col style={{ width: "5%" }} />   {/* Alerts */}
            <col style={{ width: "9%" }} />   {/* Sales */}
          </colgroup>
          <thead>
            <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Tail</th>
              <th className="px-3 py-3">Route</th>
              <th className="px-3 py-3">Departure</th>
              <th className="px-3 py-3">Arrival</th>
              <th className="px-3 py-3">Type</th>
              <th className="px-3 py-3">10/24</th>
              <th className="px-3 py-3">Rest</th>
              <th className="px-3 py-3">
                <div className="flex flex-col gap-0.5">
                  <span>NOTAMs, PPRs & TFRs</span>
                  <div className="flex rounded border border-gray-200 bg-white p-0.5 w-fit font-normal normal-case tracking-normal">
                    <button
                      type="button"
                      onClick={() => setShowAcknowledged(false)}
                      className={`px-1.5 py-0.5 text-[10px] font-medium rounded transition-colors ${
                        !showAcknowledged
                          ? "bg-slate-800 text-white"
                          : "text-gray-500 hover:text-gray-900"
                      }`}
                    >
                      Unack'd
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAcknowledged(true)}
                      className={`px-1.5 py-0.5 text-[10px] font-medium rounded transition-colors ${
                        showAcknowledged
                          ? "bg-slate-800 text-white"
                          : "text-gray-500 hover:text-gray-900"
                      }`}
                    >
                      All
                    </button>
                  </div>
                </div>
              </th>
              <th className="px-3 py-3">Sales</th>
            </tr>
          </thead>
          <tbody>
            {tableFlights.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                  No flights scheduled for selected filters
                </td>
              </tr>
            ) : (
              tableFlights.map((f) => {
                // Look up FlightAware info by route-specific key first, then fall back to tail-only
                const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
                const fi = f.tail_number
                  ? matchFlightInfo(flightInfo, routeKey, f.tail_number, f.departure_icao, f.scheduled_departure)
                  : undefined;
                const allAlerts = f.alerts ?? [];
                const alerts = showAcknowledged ? allAlerts : allAlerts.filter((a) => !isAcked(a));
                const alertCount = alerts.length;
                const type = f.flight_type || "Other";
                const typeColor = FLIGHT_TYPE_COLORS[type] || "bg-gray-100 text-gray-700";
                const isExpanded = expandedFlights.has(f.id);

                // Determine status
                let status = "Scheduled";
                let statusColor = "text-gray-500";
                let isFiled = false;
                const swimRouteMatch = swimStatus.get(routeKey);
                const swimEntry = swimRouteMatch ?? (f.tail_number ? swimStatus.get(`${f.tail_number}||`) : undefined);

                const arrivalDate = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
                const now = new Date();
                const arrivalPassed = arrivalDate && arrivalDate < now;

                // Check ForeFlight/SWIM status first
                if (swimEntry?.status === "Filed") {
                  status = "Scheduled"; isFiled = true;
                } else if (swimEntry?.status === "En Route") {
                  status = "En Route"; statusColor = "text-blue-600 font-medium";
                } else if (swimEntry?.status === "Arrived") {
                  status = "Arrived"; statusColor = "text-green-600 font-medium";
                } else if (swimEntry?.status === "Cancelled") {
                  status = "Cancelled"; statusColor = "text-red-600 font-medium";
                }

                // FA overrides if it has better data
                if (fi?.actual_arrival) {
                  // FA confirms landed — always takes priority
                  status = "Arrived";
                  statusColor = "text-green-600 font-medium";
                } else if (fi && fi.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100) {
                  // In progress — override stale FA status
                  status = "En Route";
                  statusColor = "text-blue-600 font-medium";
                } else if (fi && fi.latitude != null && fi.longitude != null && !fi.actual_arrival) {
                  // Has position data and hasn't arrived — must be en route
                  status = "En Route";
                  statusColor = "text-blue-600 font-medium";
                } else if (fi?.status) {
                  // Fall back to FA status string
                  status = fi.status;
                  if (fi.status.includes("En Route")) statusColor = "text-blue-600 font-medium";
                  if (fi.status.includes("Arrived") || fi.status.includes("Landed")) statusColor = "text-green-600 font-medium";
                  if (fi.status === "Filed") { isFiled = true; statusColor = "text-indigo-600 font-medium"; }
                } else if (status === "Scheduled" && f.tail_number && enRouteAircraft.some((p) => p.tail === f.tail_number)) {
                  // Aircraft has a live position on the map — it's flying
                  status = "En Route";
                  statusColor = "text-blue-600 font-medium";
                }

                // If scheduled arrival has passed and we're still showing Scheduled, it arrived
                if (arrivalPassed && (status === "Scheduled" || status === "En Route")) {
                  status = "Arrived";
                  statusColor = "text-green-600 font-medium";
                }

                if (fi?.diverted) {
                  status = "DIVERTED";
                  statusColor = "text-red-600 font-bold";
                } else if (f.tail_number && holdingTails.has(f.tail_number) && (status === "En Route")) {
                  status = "HOLDING";
                  statusColor = "text-red-600 font-bold animate-pulse";
                }

                // Check if this leg is superseded by FA (route changed or diverted)
                const supersedInfo = supersededMap.get(f.id);
                const isCancelled = !!supersedInfo;
                const isFaSourced = f.id.startsWith("fa-");
                if (isCancelled) {
                  status = supersedInfo.diverted ? "DIVERTED" : "Cancelled";
                  statusColor = "text-red-600 font-medium";
                }

                const depDate = new Date(f.scheduled_departure);

                // Departure time mismatch: compare FlightAware departure vs ICS scheduled
                const MISMATCH_THRESHOLD_MIN = 15;
                let depMismatchMin: number | null = null;
                if (fi?.departure_time && f.scheduled_departure) {
                  const faDep = new Date(fi.departure_time).getTime();
                  const icsDep = new Date(f.scheduled_departure).getTime();
                  // Only flag if FA route matches this leg (same origin)
                  const routeMatches = !fi.origin_icao || !f.departure_icao || fi.origin_icao === f.departure_icao;
                  if (routeMatches) {
                    const diffMin = Math.round((faDep - icsDep) / 60000);
                    if (Math.abs(diffMin) >= MISMATCH_THRESHOLD_MIN) {
                      depMismatchMin = diffMin;
                    }
                  }
                }

                return (
                  <Fragment key={f.id}>
                    <tr
                      className={`border-t hover:bg-gray-50 ${isCancelled ? "opacity-50 bg-gray-50" : ""} ${isFaSourced ? "bg-blue-50/40" : ""}`}
                    >
                      <td className="px-3 py-2.5 overflow-visible">
                        <div className="flex flex-col gap-0.5">
                          <span className={`text-xs font-medium ${statusColor}`}>{status}</span>
                          {isFiled && status === "Scheduled" && (
                            <span className="text-[10px] text-indigo-500 font-medium">
                              IFR Filed{swimEntry?.etd ? ` ${fmt(swimEntry.etd, f.departure_icao)}` : ""}
                            </span>
                          )}
                          {isFaSourced && (
                            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-100 text-blue-700">
                              FA Source
                            </span>
                          )}
                          {(() => {
                            const schedMs = new Date(f.scheduled_departure).getTime();
                            const nowMs = Date.now();
                            if (schedMs < nowMs && !fi?.actual_departure && status === "Scheduled") {
                              const lateMin = Math.round((nowMs - schedMs) / 60_000);
                              return (
                                <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold rounded-full ${lateMin > 30 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                                  +{lateMin}m late
                                </span>
                              );
                            }
                            return null;
                          })()}
                          {(() => {
                            const edct = alerts.find((a) => a.alert_type === "EDCT");
                            if (!edct?.edct_time) return null;
                            return (
                              <div className="text-[10px] font-medium text-amber-700">
                                EDCT {fmt(edct.edct_time, f.departure_icao)}
                              </div>
                            );
                          })()}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono font-semibold text-gray-900">
                        <span className="inline-flex items-center gap-1.5">
                          {f.tail_number || "—"}
                          {(fi?.diverted || supersedInfo?.diverted) && (
                            <span className="relative flex h-2.5 w-2.5" title="DIVERTED">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="font-mono font-medium">
                          {f.departure_icao || "?"} →{" "}
                          {isCancelled ? (
                            <>
                              <span className="line-through text-red-400">{f.arrival_icao || "?"}</span>
                              {supersedInfo.actualDest && (
                                <span className="text-red-600 font-bold ml-1">{supersedInfo.actualDest}</span>
                              )}
                            </>
                          ) : (f.arrival_icao || "?")}
                        </span>
                        {!isCancelled && fi?.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100 && (
                          <div className="mt-1 flex items-center gap-2">
                            <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full"
                                style={{ width: `${fi.progress_percent}%` }}
                              />
                            </div>
                            {fi.arrival_time && (() => {
                              const remaining = Math.round((new Date(fi.arrival_time).getTime() - Date.now()) / 60000);
                              if (remaining <= 0) return null;
                              const hrs = Math.floor(remaining / 60);
                              const mins = remaining % 60;
                              return (
                                <span className="text-[10px] text-blue-600 font-medium whitespace-nowrap">
                                  {hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`} remaining
                                </span>
                              );
                            })()}
                          </div>
                        )}
                        {/* ForeFlight progress fallback — only when displayed status is En Route */}
                        {!isCancelled && status === "En Route" && !(fi?.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100) && swimRouteMatch?.etd && swimRouteMatch?.eta && (() => {
                          const dep = new Date(swimRouteMatch.etd!).getTime();
                          const arr = new Date(swimRouteMatch.eta!).getTime();
                          const now = Date.now();
                          const total = arr - dep;
                          const elapsed = now - dep;
                          if (total <= 0 || elapsed <= 0) return null;
                          const pct = Math.min(Math.max(Math.round((elapsed / total) * 100), 1), 99);
                          const remaining = Math.round((arr - now) / 60000);
                          if (remaining <= 0) return null;
                          const hrs = Math.floor(remaining / 60);
                          const mins = remaining % 60;
                          return (
                            <div className="mt-1 flex items-center gap-2">
                              <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-[10px] text-blue-600 font-medium whitespace-nowrap">
                                {hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`} remaining
                              </span>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600">
                        <div>{fmt(f.scheduled_departure, f.departure_icao)}</div>
                        {!isCancelled && fi?.actual_departure ? (
                          <div className={`text-[10px] font-medium mt-0.5 ${delayColorClass(f.scheduled_departure, fi.actual_departure)}`}>
                            Actual: {fmt(fi.actual_departure, f.departure_icao)}
                          </div>
                        ) : !isCancelled ? (() => {
                          const estColor = fi?.departure_time ? depEstColorClass(f.scheduled_departure, fi.departure_time) : null;
                          return estColor ? (
                            <div className={`text-[10px] font-medium mt-0.5 ${estColor}`}>
                              Est: {fmt(fi!.departure_time!, f.departure_icao)}
                            </div>
                          ) : null;
                        })() : null}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600">
                        <div>{fmt(f.scheduled_arrival, f.arrival_icao)}</div>
                        {!isCancelled && fi?.actual_arrival && f.scheduled_arrival ? (
                          <div className={`text-[10px] font-medium mt-0.5 ${delayColorClass(f.scheduled_arrival, fi.actual_arrival)}`}>
                            Actual: {fmt(fi.actual_arrival, f.arrival_icao)}
                          </div>
                        ) : !isCancelled && fi?.arrival_time && fi?.actual_departure && !fi?.actual_arrival ? (
                          <div className="text-[10px] text-blue-600 font-medium mt-0.5">
                            ETA: {fmt(fi.arrival_time, f.arrival_icao)}
                          </div>
                        ) : !isCancelled && status === "En Route" && swimRouteMatch?.eta ? (
                          <div className="text-[10px] text-blue-600 font-medium mt-0.5">
                            ETA: {fmt(swimRouteMatch.eta, f.arrival_icao)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${typeColor}`}>
                          {type}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {(() => {
                          const duty = f.tail_number ? tailDuty.get(f.tail_number) : null;
                          if (!duty) return <span className="text-xs text-gray-300">--</span>;
                          const level = dutyLevel(duty.flightTimeMin);
                          return (
                            <button
                              onClick={() => onSwitchToDuty?.(f.tail_number ?? undefined)}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono font-medium rounded cursor-pointer hover:opacity-80 transition-opacity ${LEVEL_COLORS[level]}`}
                              title="View detailed 10/24 breakdown"
                            >
                              <span className="text-[10px]">{LEVEL_ICONS[level]}</span>
                              {fmtHM(duty.flightTimeMin)}
                            </button>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5">
                        {(() => {
                          const duty = f.tail_number ? tailDuty.get(f.tail_number) : null;
                          if (!duty || duty.restMin == null) return <span className="text-xs text-gray-300">--</span>;
                          const level = restLevel(duty.restMin);
                          if (!level) return <span className="text-xs text-gray-300">--</span>;
                          return (
                            <button
                              onClick={() => onSwitchToDuty?.(f.tail_number ?? undefined)}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono font-medium rounded cursor-pointer hover:opacity-80 transition-opacity ${LEVEL_COLORS[level]}`}
                              title="View detailed crew rest breakdown"
                            >
                              <span className="text-[10px]">{LEVEL_ICONS[level]}</span>
                              {fmtHM(duty.restMin)}
                            </button>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5">
                        {alertCount > 0 && (
                          <button
                            onClick={() => toggleExpanded(f.id)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200 transition-colors cursor-pointer"
                          >
                            <span className={`inline-block transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                              &#9656;
                            </span>
                            {alertCount}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {(() => {
                          const LIVE = ["Revenue", "Owner", "Charter"];
                          if (!LIVE.includes(type)) return null;
                          const sp = findSalesperson(tripSalespersons, f.tail_number, f.departure_icao, f.arrival_icao, f.scheduled_departure);
                          if (!sp) return null;
                          return <span className="text-xs text-gray-700">{sp}</span>;
                        })()}
                      </td>
                    </tr>
                    {isExpanded && alerts.map((alert) => (
                      <tr key={alert.id} className={`border-t border-dashed border-gray-100 ${isAcked(alert) ? "bg-gray-50/40 opacity-60" : "bg-red-50/40"}`}>
                        <td colSpan={10} className="px-4 py-3">
                          <div className={`rounded-lg border p-3 text-xs ${isAcked(alert) ? "bg-gray-50 text-gray-700 border-gray-200" : SEVERITY_COLORS[alert.severity] || "bg-gray-50 text-gray-700 border-gray-200"}`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="space-y-1 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold uppercase tracking-wide">{alert.alert_type.replace(/_/g, " ")}</span>
                                  <span className="opacity-60">·</span>
                                  <span className="capitalize">{alert.severity}</span>
                                  {alert.airport_icao && (
                                    <>
                                      <span className="opacity-60">·</span>
                                      <span className="font-mono">{alert.airport_icao}</span>
                                    </>
                                  )}
                                </div>
                                {alert.subject && (
                                  <div className="font-medium text-sm">{alert.subject}</div>
                                )}
                                {alert.body && (
                                  <div className="whitespace-pre-wrap opacity-80 max-h-32 overflow-y-auto">{alert.body}</div>
                                )}
                                {alert.edct_time && (
                                  <div className="font-medium">
                                    {alert.original_departure_time && <span className="line-through opacity-60 mr-1">{fmt(alert.original_departure_time, alert.airport_icao)}</span>}
                                    {alert.original_departure_time && <span className="opacity-50 mr-1">→</span>}
                                    EDCT: {fmt(alert.edct_time, alert.airport_icao)}
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-col items-end gap-1 shrink-0">
                                <span className="text-[10px] opacity-50 whitespace-nowrap">
                                  {fmt(alert.created_at)}
                                </span>
                                {isAcked(alert) ? (
                                  <span className="text-xs text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">Ack'd</span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleAck(alert.id)}
                                    className="text-xs text-gray-500 hover:text-green-700 hover:bg-green-50 border border-gray-200 hover:border-green-300 rounded px-1.5 py-0.5 transition-colors"
                                  >
                                    Ack
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      )}

    </div>
  );
}
