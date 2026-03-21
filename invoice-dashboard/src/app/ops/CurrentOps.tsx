"use client";

import dynamic from "next/dynamic";
import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import type { Flight, OpsAlert, MxNote, SwimFlowEvent } from "@/lib/opsApi";
import type { AdvertisedPriceRow } from "@/lib/types";
import { FALLBACK_TAILS, BAKER_FLEET } from "@/lib/maintenanceData";
import type { AircraftPosition, FlightInfoMap } from "@/app/maintenance/MapView";
import { fmtTimeInTz, type TzMode } from "@/lib/airportTimezones";
import { getAirportInfo, findNearestAirport } from "@/lib/airportCoords";
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
const MAX_LEG_DURATION_MIN = 8 * 60; // cap any single leg at 8h (longest Baker legs are ~5h)
const MIN_REST_GAP_MS = 8 * 60 * 60 * 1000;
const LEAD_TIME_MS = 60 * 60 * 1000;  // 60min pre-duty (matches DutyTracker)
const POST_TIME_MS = 30 * 60 * 1000;  // 30min post-duty (matches DutyTracker)

type DutyInterval = { startMs: number; endMs: number; depIcao: string | null; arrIcao: string | null; source: "actual" | "fa-estimate" | "scheduled" };

type TailDutySummary = {
  flightTimeMin: number;
  restMin: number | null;
  restStartMs: number | null;
  // For EDCT computation: today's DP off time and tomorrow's DP on time
  todayDpOffMs: number | null;
  tomorrowDpOnMs: number | null;
  intervals: DutyInterval[]; // deduped intervals for EDCT recalculation
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
    // Skip synthetic EDCT-orphan flights (not real ICS legs)
    if (f.id.startsWith("edct-orphan-")) continue;
    const ft = (f.flight_type ?? "").toLowerCase();
    if (ft && !DUTY_FLIGHT_TYPES.has(ft)) continue;

    // Match FA data: direct ID match first, then route+time heuristics as fallback
    const tailFaFlights = faByTail.get(f.tail_number) ?? [];
    let fi: FlightInfoMap | undefined;
    const schedMs = new Date(f.scheduled_departure).getTime();

    // 1. Direct ID match (if ICS flight has fa_flight_id linked)
    if (f.fa_flight_id) {
      fi = tailFaFlights.find(fa => fa.fa_flight_id === f.fa_flight_id);
    }

    // 2. Fallback: exact route match within 6h
    if (!fi) {
      fi = tailFaFlights.find((fa) => {
        if (fa.origin_icao !== f.departure_icao || fa.destination_icao !== f.arrival_icao) return false;
        const faDep = fa.departure_time ?? fa.actual_departure;
        if (!faDep) return true;
        return Math.abs(new Date(faDep).getTime() - schedMs) < 6 * 60 * 60 * 1000;
      });
    }

    // 3. Fallback: closest departure time within 2h
    if (!fi && tailFaFlights.length > 0) {
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
    // Only use FA arrival data if the destination matches (chained flights have wrong arrival)
    const fiDestMatch = fi && fi.destination_icao === f.arrival_icao;
    const actualArr = fiDestMatch ? (fi?.actual_arrival ?? null) : null;
    const estimatedArr = fiDestMatch ? (fi?.arrival_time ?? null) : null;
    // FA departure_time = best available (actual > estimated > scheduled)
    const faDep = fi?.departure_time ?? null;

    // Use FA departure when available — matches DutyTracker logic
    const depMs = new Date(actualDep ?? faDep ?? f.scheduled_departure).getTime();
    let endMs: number;
    let source: "actual" | "fa-estimate" | "scheduled";
    if (actualArr) {
      source = "actual";
      endMs = new Date(actualArr).getTime();
    } else if (actualDep && !actualArr) {
      source = estimatedArr ? "fa-estimate" : "actual";
      endMs = estimatedArr ? new Date(estimatedArr).getTime() : nowMs;
    } else if (faDep && estimatedArr) {
      source = "fa-estimate";
      endMs = new Date(estimatedArr).getTime();
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
    // Fix overlapping legs: push later leg's departure to previous leg's arrival
    deduped.sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < deduped.length; i++) {
      if (deduped[i].startMs < deduped[i - 1].endMs) {
        deduped[i].startMs = deduped[i - 1].endMs;
        const newDur = Math.max(0, (deduped[i].endMs - deduped[i].startMs) / 60_000);
        deduped[i].endMs = deduped[i].startMs + Math.min(newDur, MAX_LEG_DURATION_MIN) * 60_000;
      }
    }
    const finalIntervals = deduped;

    // --- Rolling 24hr flight time (Part 135.267: ANY 24 consecutive hours) ---
    // Only consider windows that include at least one future/in-progress leg.
    // Past-only windows can't be changed — don't alert on them.
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
      // Only flag windows containing a future/in-progress leg
      const hasFutureLeg = finalIntervals.some(l => l.endMs >= nowMs && l.startMs < wp && l.endMs > ws);
      if (!hasFutureLeg) continue;
      let totalMs = 0;
      for (const leg of finalIntervals) {
        const os = Math.max(leg.startMs, ws);
        const oe = Math.min(leg.endMs, wp);
        if (oe > os) totalMs += oe - os;
      }
      if (totalMs > maxMs) maxMs = totalMs;
    }

    // --- Crew rest: tonight's rest (after today's duty, before tomorrow's) ---
    // Group intervals into duty periods, find today's DP, show rest after it.
    let restMin: number | null = null;
    let restStartMs: number | null = null;
    let todayDpOffMs: number | null = null;
    let tomorrowDpOnMs: number | null = null;
    {
      // Group into duty periods (split at gaps >= 8h)
      const dps: { onMs: number; offMs: number }[] = [];
      let dpStart = finalIntervals[0].startMs;
      let dpEnd = finalIntervals[0].endMs;
      for (let i = 1; i < finalIntervals.length; i++) {
        if (finalIntervals[i].startMs - dpEnd >= MIN_REST_GAP_MS) {
          dps.push({ onMs: dpStart - LEAD_TIME_MS, offMs: dpEnd + POST_TIME_MS });
          dpStart = finalIntervals[i].startMs;
          dpEnd = finalIntervals[i].endMs;
        } else {
          dpEnd = finalIntervals[i].endMs;
        }
      }
      dps.push({ onMs: dpStart - LEAD_TIME_MS, offMs: dpEnd + POST_TIME_MS });

      // Find today's DP: first DP with legs departing on today's UTC date
      const todayUtcEnd = todayUtc + 24 * 60 * 60 * 1000;
      let todayIdx = -1;
      for (let d = 0; d < dps.length; d++) {
        const dpFirstDep = dps[d].onMs + LEAD_TIME_MS;
        const dpLastArr = dps[d].offMs - POST_TIME_MS;
        for (const iv of finalIntervals) {
          if (iv.startMs >= dpFirstDep - 60_000 && iv.endMs <= dpLastArr + 60_000 &&
              iv.startMs >= todayUtc && iv.startMs < todayUtcEnd) {
            todayIdx = d;
            break;
          }
        }
        if (todayIdx >= 0) break;
      }
      // Fallback: DP still on duty (offMs > now)
      if (todayIdx === -1) {
        for (let d = dps.length - 1; d >= 0; d--) {
          if (dps[d].offMs > nowMs) { todayIdx = d; break; }
        }
      }

      if (todayIdx >= 0) {
        todayDpOffMs = dps[todayIdx].offMs;
        // Primary: rest between today's DP and tomorrow's DP
        if (todayIdx < dps.length - 1) {
          tomorrowDpOnMs = dps[todayIdx + 1].onMs;
          restMin = Math.max(0, (tomorrowDpOnMs - todayDpOffMs) / 60_000);
          restStartMs = todayDpOffMs;
        }
        // Fallback: if no tomorrow DP, show last night's rest (before today's DP)
        else if (todayIdx > 0) {
          const prevOff = dps[todayIdx - 1].offMs;
          const todayOn = dps[todayIdx].onMs;
          restMin = Math.max(0, (todayOn - prevOff) / 60_000);
          restStartMs = prevOff;
        }
      }
    }

    result.set(tail, { flightTimeMin: maxMs / 60_000, restMin, restStartMs, todayDpOffMs, tomorrowDpOnMs, intervals: finalIntervals });
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

/** Look up FA data: try bucketed route key first, then unbucketed, then tail-only.
 *  All paths reject stale FA data (>90min from scheduled departure) to avoid
 *  blending data between legs of the same aircraft. */
function matchFlightInfo(
  map: Map<string, FlightInfoMap>,
  routeKey: string,
  tail: string,
  departureIcao: string | null,
  scheduledDep?: string,
  arrivalIcao?: string | null,
): FlightInfoMap | undefined {
  const STALE_MS = 90 * 60_000; // 90 minutes
  const isStale = (fi: FlightInfoMap) => {
    if (!scheduledDep) return false;
    const faDep = fi.actual_departure ?? fi.departure_time;
    if (!faDep) return false;
    return Math.abs(new Date(faDep).getTime() - new Date(scheduledDep).getTime()) > STALE_MS;
  };
  // 1. Try bucketed route key (tail|dep|arr|bucket)
  if (scheduledDep) {
    const h = new Date(scheduledDep).getUTCHours();
    const bucket = String(Math.floor(h / 3));
    const bucketed = map.get(`${routeKey}|${bucket}`);
    if (bucketed && !isStale(bucketed)) return bucketed;
  }
  // 2. Try unbucketed route key (tail|dep|arr) — catches cases where FA dep drifted to adjacent bucket
  const byRoute = map.get(routeKey);
  if (byRoute && !isStale(byRoute)) return byRoute;
  // Tail-only fallback removed — was the source of cross-leg status bleed.
  // Flights without a route match will correctly show as "Scheduled" until
  // the FA poll cron or webhook links them via fa_flight_id.
  return undefined;
}

/** Check if a SWIM entry is stale relative to a scheduled departure.
 *  Returns true if the SWIM event is from a previous flight (>3h from scheduled departure).
 *  Returns false if swim is undefined (no data = not stale, caller uses ?. to guard). */
function isSwimStale(
  swim: { event_time?: string; actual_departure?: string | null } | undefined,
  scheduledDep: string,
): boolean {
  if (!swim) return false;
  const ref = swim.actual_departure ?? swim.event_time;
  if (!ref) return false;
  return Math.abs(new Date(ref).getTime() - new Date(scheduledDep).getTime()) > 3 * 3600_000;
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

/** Find the active (unacknowledged) EDCT alert for a flight */
function getActiveEdct(f: Flight): OpsAlert | null {
  return f.alerts?.find(a => a.alert_type === "EDCT" && a.edct_time && !a.acknowledged_at) ?? null;
}

/** EDCT source: SWIM vs ForeFlight */
function edctSourceTag(alert: OpsAlert): string {
  return (alert.source_message_id ?? "").startsWith("swim-edct-") ? "SWIM" : "FF";
}

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

// Lookahead hours needed per time range
const RANGE_LOOKAHEAD: Record<TimeRange, number> = {
  "Today": 48, "Today + Tomorrow": 48, "Tomorrow": 48, "Week": 168, "Month": 744,
};

export default function CurrentOps({ flights: initialFlights, onSwitchToDuty, advertisedPrices = [], mxNotes = [], swimFlow = [] }: { flights: Flight[]; onSwitchToDuty?: (tail?: string) => void; advertisedPrices?: AdvertisedPriceRow[]; mxNotes?: MxNote[]; swimFlow?: SwimFlowEvent[] }) {
  const [extendedFlights, setExtendedFlights] = useState<Flight[] | null>(null);
  const [extendedLoading, setExtendedLoading] = useState(false);
  const [loadedLookahead, setLoadedLookahead] = useState(48); // server sends 48h
  const flights = extendedFlights ?? initialFlights;

  const [enRouteAircraft, setAircraftPosition] = useState<AircraftPosition[]>([]);
  const [faFlightsRaw, setFaFlightsRaw] = useState<FlightInfoMap[]>([]);
  const [flightInfo, setFlightInfo] = useState<Map<string, FlightInfoMap>>(new Map());
  const [tripSalespersons, setTripSalespersons] = useState<TripSalesperson[]>([]);

  // Flight remarks (day-of notes)
  type FlightRemark = { id: string; flight_id: string; remark: string; created_by: string | null; updated_at: string };
  const [remarks, setRemarks] = useState<Map<string, FlightRemark>>(new Map());
  const [editingRemarkId, setEditingRemarkId] = useState<string | null>(null);
  const [remarkDraft, setRemarkDraft] = useState("");

  // SWIM flight status
  type SwimFlightStatus = { tail_number: string; departure_icao: string | null; arrival_icao: string | null; status: string; event_time: string; etd: string | null; eta: string | null; actual_departure: string | null; actual_arrival: string | null; latitude?: number | null; longitude?: number | null; groundspeed_kt?: number | null };
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
  // Strips today's date prefix so "Mar 14, 15:12 PDT" → "15:12 PDT" when today is Mar 14
  const fmt = useCallback(
    (iso: string | null | undefined, icao?: string | null) => {
      const full = fmtTimeInTz(iso, icao, true, tzMode);
      const todayPrefix = new Date().toLocaleString("en-US", { month: "short", day: "numeric" });
      if (full.startsWith(todayPrefix + ", ")) {
        return full.slice(todayPrefix.length + 2);
      }
      return full;
    },
    [tzMode],
  );

  // EDCT time formatter: time only when same calendar day as scheduled departure
  const fmtEdctTime = useCallback(
    (edctIso: string, schedIso: string, icao?: string | null): string => {
      const edctFull = fmtTimeInTz(edctIso, icao, true, tzMode);
      const schedFull = fmtTimeInTz(schedIso, icao, true, tzMode);
      const edctComma = edctFull.indexOf(", ");
      const schedComma = schedFull.indexOf(", ");
      if (edctComma > 0 && schedComma > 0) {
        const edctDate = edctFull.slice(0, edctComma);
        const schedDate = schedFull.slice(0, schedComma);
        if (edctDate === schedDate) {
          return edctFull.slice(edctComma + 2); // time + tz only
        }
      }
      return edctFull; // different day — show full
    },
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

  const handleAckAll = useCallback((flightId: string, alertIds: string[]) => {
    setLocalAckedIds((prev) => {
      const next = new Set(prev);
      for (const id of alertIds) next.add(id);
      return next;
    });
    fetch("/api/ops/alerts/acknowledge-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flight_id: flightId }),
    }).catch(() => {});
  }, []);

  // Fetch FlightAware data (primary source for both positions and flight info)
  const fetchFlightInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/flights", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        // JetInsight uses K-prefix or non-standard codes for some airports
        const FA_ALIASES: Record<string, string> = {
          TJSJ: "KSJU", TIST: "KSTT", TISX: "KSTX", TJBQ: "KBQN", TJPS: "KPSE",
          MYNN: "KNAS", MWCR: "KGCM", TXKF: "KBDA", TAPA: "KANU",
          TUPJ: "MBPV",  // Beef Island / Tortola BVI
        };
        // Key by tail|origin|dest|depBucket so same-route legs don't collide.
        // depBucket is the 3h window the FA departure falls into, so legs >3h apart
        // each get their own slot in the map.
        const bucketHours = (iso: string | null | undefined): string => {
          if (!iso) return "";
          const h = new Date(iso).getUTCHours();
          return String(Math.floor(h / 3));          // 0-7 (eight 3-h buckets per day)
        };
        const map = new Map<string, FlightInfoMap>();
        const positions: AircraftPosition[] = [];
        for (const fi of data.flights ?? []) {
          const bucket = bucketHours(fi.departure_time ?? fi.actual_departure);
          const key = `${fi.tail}|${fi.origin_icao ?? ""}|${fi.destination_icao ?? ""}|${bucket}`;
          // Prefer the entry that's actively flying (has position or actual departure)
          const existing = map.get(key);
          const isMoreActive = !existing || fi.latitude != null || fi.actual_departure != null;
          if (isMoreActive) map.set(key, fi);
          // Also store without bucket for backward-compat route lookups (matchFlightInfo
          // tries bucketed key first, then falls back to unbucketed)
          const unbucketedKey = `${fi.tail}|${fi.origin_icao ?? ""}|${fi.destination_icao ?? ""}`;
          if (!map.has(unbucketedKey) || isMoreActive) map.set(unbucketedKey, fi);
          // Index all alias combinations (origin/dest independently)
          const altOrig = FA_ALIASES[fi.origin_icao ?? ""];
          const altDest = FA_ALIASES[fi.destination_icao ?? ""];
          if (altOrig || altDest) {
            const origins = [fi.origin_icao ?? ""];
            const dests = [fi.destination_icao ?? ""];
            if (altOrig) origins.push(altOrig);
            if (altDest) dests.push(altDest);
            for (const o of origins) {
              for (const d of dests) {
                const k = `${fi.tail}|${o}|${d}|${bucket}`;
                if (!map.has(k) || isMoreActive) map.set(k, fi);
                const kUnbucketed = `${fi.tail}|${o}|${d}`;
                if (!map.has(kUnbucketed) || isMoreActive) map.set(kUnbucketed, fi);
              }
            }
          }
          // Also store by tail-only for fallback — prefer en-route flights with positions
          const hasLanded = fi.actual_arrival != null;
          const existingEntry = map.get(fi.tail);
          const existingLanded = existingEntry?.actual_arrival != null;
          const fiDepMs = fi.departure_time ? new Date(fi.departure_time).getTime() : 0;
          const exDepMs = existingEntry?.departure_time ? new Date(existingEntry.departure_time).getTime() : 0;
          const fiHasPosition = fi.latitude != null && fi.longitude != null;
          const exHasPosition = existingEntry?.latitude != null && existingEntry?.longitude != null;
          const fiIsEnRoute = fi.status === "En Route" || fi.status === "Diverted";
          const exIsEnRoute = existingEntry?.status === "En Route" || existingEntry?.status === "Diverted";
          if (!existingEntry
            // En-route with position always wins over scheduled/landed
            || (fiIsEnRoute && fiHasPosition && !exIsEnRoute)
            // Don't let a scheduled flight replace an en-route one
            || (!exIsEnRoute && !hasLanded && fiHasPosition)
            || (existingLanded && !hasLanded && fiDepMs >= exDepMs)
            || (fiDepMs > exDepMs && !hasLanded && !exIsEnRoute)) {
            map.set(fi.tail, fi);
          }
          // Also index by ident (callsign) so lookups work either way
          if (fi.ident && fi.ident !== fi.tail) {
            const identKey = `${fi.ident}|${fi.origin_icao ?? ""}|${fi.destination_icao ?? ""}|${bucket}`;
            if (!map.has(identKey) || fi.latitude != null) map.set(identKey, fi);
            const identKeyUnbucketed = `${fi.ident}|${fi.origin_icao ?? ""}|${fi.destination_icao ?? ""}`;
            if (!map.has(identKeyUnbucketed) || fi.latitude != null) map.set(identKeyUnbucketed, fi);
            if (!map.has(fi.ident) || (fi.latitude != null && fi.longitude != null)) {
              map.set(fi.ident, fi);
            }
          }
          // Index by fa_flight_id for direct lookup from ICS flights
          if (fi.fa_flight_id) {
            map.set(`fa:${fi.fa_flight_id}`, fi);
          }
          // Synthesize map positions from en-route flights only
          // Skip: flights that have landed, or ghost flights (departed >6h ago, no landing)
          const faDepMs = fi.actual_departure ? new Date(fi.actual_departure).getTime() : null;
          const isGhostFlight = faDepMs && !fi.actual_arrival && (Date.now() - faDepMs > 6 * 3600_000);
          if (fi.latitude != null && fi.longitude != null && !hasLanded && !isGhostFlight) {
            // Determine on_ground from FA status and altitude
            const faStatus = (fi.status ?? "").toLowerCase();
            const isAirborne = faStatus.includes("en route") || faStatus.includes("diverted")
              || (fi.altitude != null && fi.altitude > 200)
              || (fi.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100);
            positions.push({
              tail: fi.tail,
              lat: fi.latitude,
              lon: fi.longitude,
              alt_baro: fi.altitude ?? null,
              gs: fi.groundspeed ?? null,
              track: fi.heading ?? null,
              baro_rate: null,
              on_ground: !isAirborne,
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

  // Fetch flight remarks
  const fetchRemarks = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/remarks", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        const map = new Map<string, FlightRemark>();
        for (const [fid, r] of Object.entries(data.remarks ?? {})) {
          map.set(fid, r as FlightRemark);
        }
        setRemarks(map);
      }
    } catch { /* ignore */ }
  }, []);

  const saveRemark = useCallback(async (flightId: string, text: string) => {
    try {
      const res = await fetch("/api/ops/remarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flight_id: flightId, remark: text }),
      });
      if (res.ok) {
        // Optimistic update
        if (text.trim() === "") {
          setRemarks((prev) => { const m = new Map(prev); m.delete(flightId); return m; });
        } else {
          setRemarks((prev) => {
            const m = new Map(prev);
            m.set(flightId, { id: "", flight_id: flightId, remark: text.trim(), created_by: null, updated_at: new Date().toISOString() });
            return m;
          });
        }
      }
    } catch { /* ignore */ }
    setEditingRemarkId(null);
  }, []);

  // Poll every 5 minutes (with jitter to prevent thundering herd across clients)
  useEffect(() => {
    fetchFlightInfo();
    fetchSwimStatus();
    fetchTripSalespersons();
    fetchRemarks();
    const jitter = () => 300_000 + Math.random() * 30_000; // 5 min + 0-30s jitter
    let i1: ReturnType<typeof setTimeout>, i2: ReturnType<typeof setTimeout>,
        i3: ReturnType<typeof setTimeout>, i4: ReturnType<typeof setTimeout>;
    const loop = (fn: () => void) => { const tick = () => { fn(); id = setTimeout(tick, jitter()); }; let id = setTimeout(tick, jitter()); return () => clearTimeout(id); };
    const c1 = loop(fetchFlightInfo);
    const c2 = loop(fetchSwimStatus);
    const c3 = loop(fetchTripSalespersons);
    const c4 = loop(fetchRemarks);
    return () => { c1(); c2(); c3(); c4(); };
  }, [fetchFlightInfo, fetchSwimStatus, fetchTripSalespersons, fetchRemarks]);

  // Lazy-load extended flights when switching to Week/Month
  useEffect(() => {
    const needed = RANGE_LOOKAHEAD[timeRange];
    if (needed <= loadedLookahead) return; // already have enough data
    let cancelled = false;
    setExtendedLoading(true);
    fetch(`/api/ops/flights?lookahead_hours=${needed}&lookback_hours=48`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.flights) {
          setExtendedFlights(data.flights);
          setLoadedLookahead(needed);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setExtendedLoading(false); });
    return () => { cancelled = true; };
  }, [timeRange, loadedLookahead]);

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
    // Map from flight.id → { actualDest, diverted, diverting } for cancelled/diverted rendering
    const superseded = new Map<string, { actualDest: string | null; diverted: boolean; diverting: boolean }>();
    const replacements: Flight[] = [];
    const addedRoutes = new Set<string>();

    for (const f of filteredFlights) {
      if (!f.tail_number || !f.departure_icao) continue;

      // --- Diversion detection ---
      // If FA matched this leg's route but says it's diverted, find diversion airport
      // from last known position (FA's destination stays as the original filed dest)
      const routeKey = `${f.tail_number}|${f.departure_icao}|${f.arrival_icao ?? ""}`;
      // Fall back to tail-level FA entry only if diverted AND departure time is within 3h of scheduled
      const tailFallback = (() => {
        const tfi = f.tail_number ? flightInfo.get(f.tail_number) : undefined;
        if (!tfi?.diverted) return undefined;
        const faDepIso = tfi.departure_time ?? tfi.actual_departure;
        if (faDepIso) {
          const diff = Math.abs(new Date(faDepIso).getTime() - new Date(f.scheduled_departure).getTime());
          if (diff > 3 * 3600_000) return undefined; // Stale FA entry from a different day/flight
        }
        return tfi;
      })();
      const routeFi = flightInfo.get(routeKey) ?? tailFallback;
      if (routeFi?.diverted) {
        // FA often doesn't populate actual_arrival for diverted flights.
        // Also check progress and ETA as landed signals.
        const hasLanded = routeFi.actual_arrival != null
          || (routeFi.progress_percent != null && routeFi.progress_percent >= 100)
          || (routeFi.arrival_time != null && new Date(routeFi.arrival_time).getTime() < Date.now());
        // Normalize ICAO codes for comparison (3-letter US → K-prefix)
        const normIcao = (c: string | null | undefined) => c ? (c.length === 3 && /^[A-Z]/.test(c) ? `K${c}` : c) : null;
        const faDest = normIcao(routeFi.destination_icao);
        const schedDest = normIcao(f.arrival_icao);

        if (hasLanded) {
          // Landed: compare FA destination vs scheduled arrival
          if (faDest && schedDest && faDest === schedDest) {
            // False alarm — landed at scheduled airport. Skip supersededMap entirely.
            continue;
          }
          // Confirmed diversion — landed at different airport
          superseded.set(f.id, { actualDest: faDest, diverted: true, diverting: false });
        } else {
          // Airborne: FA says diverted but not yet landed — soft "diverting" state
          let divertedTo: string | null = null;
          if (routeFi.latitude != null && routeFi.longitude != null) {
            const nearest = findNearestAirport(routeFi.latitude, routeFi.longitude);
            if (nearest) {
              let code = nearest.code;
              if (code.length === 3 && /^[A-Z]/.test(code)) code = `K${code}`;
              const depNorm = normIcao(f.departure_icao);
              const arrNorm = schedDest;
              if (code !== depNorm && code !== arrNorm) {
                divertedTo = code;
              }
            }
          }
          superseded.set(f.id, { actualDest: divertedTo, diverted: false, diverting: true });
        }
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

      // Two-tier diversion: check if landed + dest matches scheduled
      const normIcaoB = (c: string | null | undefined) => c ? (c.length === 3 && /^[A-Z]/.test(c) ? `K${c}` : c) : null;
      let routeDiverted = false;
      let routeDiverting = false;
      if (tailFi.diverted) {
        const hasLanded = tailFi.actual_arrival != null
          || (tailFi.progress_percent != null && tailFi.progress_percent >= 100)
          || (tailFi.arrival_time != null && new Date(tailFi.arrival_time).getTime() < Date.now());
        const faDest = normIcaoB(tailFi.destination_icao);
        const schedDest = normIcaoB(f.arrival_icao);
        if (hasLanded && faDest && schedDest && faDest === schedDest) {
          // False alarm — landed at scheduled airport, skip supersededMap
          continue;
        }
        routeDiverted = hasLanded;
        routeDiverting = !hasLanded;
      }
      superseded.set(f.id, { actualDest: tailFi.destination_icao, diverted: routeDiverted, diverting: routeDiverting });

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
        fa_flight_id: null,
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
      // Primary: direct fa_flight_id match
      let fi: FlightInfoMap | undefined;
      let idMatched = false;
      if (f.fa_flight_id && flightInfo.has(`fa:${f.fa_flight_id}`)) {
        fi = flightInfo.get(`fa:${f.fa_flight_id}`);
        idMatched = true;
      }
      // Secondary: route-key match (for flights not yet linked)
      if (!fi && f.tail_number) {
        const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
        fi = matchFlightInfo(flightInfo, routeKey, f.tail_number, f.departure_icao, f.scheduled_departure, f.arrival_icao);
      }

      const arrivalDate = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
      // For ID-matched flights, always trust ETA; for route-matched, require dest match
      const faEta = fi && (idMatched || fi.destination_icao === f.arrival_icao) && fi.arrival_time ? new Date(fi.arrival_time) : null;
      const arrivalPassed = (arrivalDate && arrivalDate < now) || (faEta && faEta < now);

      // Check SWIM status — route-specific only for "En Route" to avoid bleeding across legs
      const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
      const swimRoute = swimStatus.get(routeKey);
      const swim = swimRoute ?? (f.tail_number ? swimStatus.get(`${f.tail_number}||`) : undefined);
      const swimRouteStale = isSwimStale(swimRoute, f.scheduled_departure);
      const swimEntryStale = isSwimStale(swim, f.scheduled_departure);
      // ID-matched flights are always "route matched" — the FA leg IS this leg
      const fiRouteMatch = idMatched || (fi && fi.destination_icao === f.arrival_icao);

      // FA is primary source; SWIM supplements when FA hasn't detected takeoff yet
      const schedArrPassed = arrivalDate && arrivalDate < now;
      const arrOvMin = arrivalDate && schedArrPassed ? (now.getTime() - arrivalDate.getTime()) / 60_000 : 0;
      // "Late" / "No Departure" flights (15min–2h overdue with no FA dep) stay in "scheduled" filter
      const noDepConds = !fi?.actual_departure && !fi?.actual_arrival
        && !fi?.status?.includes("En Route") && !fi?.status?.includes("Landed");
      const isLateOrNoDep = arrOvMin >= 15 && arrOvMin <= 120 && noDepConds;
      if (fi?.diverted || supersededMap.has(f.id)) {
        map.set(f.id, "arrived");
      } else if (fiRouteMatch && (fi?.actual_arrival || fi?.status?.includes("Arrived") || fi?.status?.includes("Landed"))) {
        map.set(f.id, "arrived");
      } else if (isLateOrNoDep) {
        map.set(f.id, "scheduled"); // Late / No Departure — keep in scheduled filter
      } else if (arrivalPassed) {
        map.set(f.id, "arrived");
      } else if (fiRouteMatch && fi?.status?.includes("En Route")) {
        map.set(f.id, "enroute");
      } else if (fiRouteMatch && fi?.actual_departure && !fi?.actual_arrival
        && new Date(fi.actual_departure) < now && (!faEta || faEta > now)
        && !fi?.status?.includes("Scheduled") && !fi?.status?.includes("Cancelled")) {
        map.set(f.id, "enroute"); // LADD: FA has actual departure + not scheduled/cancelled
      } else if (!swimRouteStale && swimRoute?.status === "En Route") {
        map.set(f.id, "enroute"); // SWIM detected takeoff (works with or without FA route match)
      } else if (!fiRouteMatch && !swimEntryStale && swim?.status === "Arrived") {
        map.set(f.id, "arrived");
      } else if (fi?.status?.includes("Arrived") || fi?.status?.includes("Landed") || fi?.actual_arrival) {
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

  // Flow control affected airports — for SWIM badge in flight table
  const flowAffectedAirports = useMemo(() => {
    const set = new Set<string>();
    for (const ev of swimFlow) {
      if (ev.airport_icao) {
        set.add(ev.airport_icao);
        const norm = ev.airport_icao.startsWith("K") && ev.airport_icao.length === 4 ? ev.airport_icao.slice(1) : ev.airport_icao;
        set.add(norm);
        if (!ev.airport_icao.startsWith("K") && ev.airport_icao.length === 3) set.add("K" + ev.airport_icao);
      }
    }
    return set;
  }, [swimFlow]);

  // Per-tail FA last-known location (most recent landed flight's destination)
  const tailFaLocation = useMemo(() => {
    const normIcao = (c: string | null | undefined) => c ? (c.length === 3 && /^[A-Z]/.test(c) ? `K${c}` : c) : null;
    const map = new Map<string, { icao: string; landedAt: string | null }>();
    const flyingTails = new Set(enRouteAircraft.map((a) => a.tail));
    for (const fi of faFlightsRaw) {
      if (!fi.tail || flyingTails.has(fi.tail)) continue;
      // Only consider flights that have actually landed
      const hasLanded = fi.actual_arrival != null
        || (fi.status?.includes("Landed") || fi.status?.includes("Arrived"))
        || (fi.progress_percent != null && fi.progress_percent >= 100);
      if (!hasLanded || !fi.destination_icao) continue;
      // Only trust FA data from the last 24 hours
      const landedTime = fi.actual_arrival ?? fi.arrival_time;
      if (landedTime && Date.now() - new Date(landedTime).getTime() > 24 * 3600_000) continue;
      const existing = map.get(fi.tail);
      const existingTime = existing?.landedAt ? new Date(existing.landedAt).getTime() : 0;
      const thisTime = landedTime ? new Date(landedTime).getTime() : 0;
      if (!existing || thisTime > existingTime) {
        map.set(fi.tail, { icao: normIcao(fi.destination_icao) ?? fi.destination_icao, landedAt: landedTime });
      }
    }
    return map;
  }, [faFlightsRaw, enRouteAircraft]);

  // Per-tail duty summary (24hr flight time + crew rest)
  const tailDuty = useMemo(() => computeTailDuty(flights, faFlightsRaw), [flights, faFlightsRaw]);

  // EDCT-adjusted duty: compute per-tail using normal intervals + EDCT shifts
  // EDCT shifts today's duty off later → compresses tonight's rest.
  // Tomorrow's duty on stays the same (EDCT doesn't affect tomorrow's flights).
  const tailDutyEdct = useMemo(() => {
    const hasAnyEdct = flights.some(f => getActiveEdct(f) != null);
    if (!hasAnyEdct) return null;

    const result = new Map<string, TailDutySummary>();
    const WINDOW_MS = 24 * 60 * 60 * 1000;

    for (const [tail, normalDuty] of tailDuty) {
      const tailFlights = flights.filter(f => f.tail_number === tail);
      const hasEdct = tailFlights.some(f => getActiveEdct(f) != null);
      if (!hasEdct) continue; // skip tails without EDCTs

      // Build EDCT-shifted intervals from normal intervals
      const edctIntervals = normalDuty.intervals.map(iv => ({ ...iv }));
      for (const iv of edctIntervals) {
        // Skip legs that have actually departed — EDCT is moot once airborne
        if (iv.source === "actual" && iv.startMs < Date.now()) continue;
        // Find the flight that matches this interval
        const matchedFlight = tailFlights.find(f =>
          f.departure_icao === iv.depIcao &&
          f.arrival_icao === iv.arrIcao &&
          Math.abs(new Date(f.scheduled_departure).getTime() - iv.startMs) < 2 * 60 * 60 * 1000
        );
        if (!matchedFlight) continue;
        const edct = getActiveEdct(matchedFlight);
        if (!edct?.edct_time) continue;
        const deltaMs = new Date(edct.edct_time).getTime() - new Date(matchedFlight.scheduled_departure).getTime();
        if (deltaMs <= 0) continue;
        iv.startMs += deltaMs;
        iv.endMs += deltaMs;
      }
      // Cascade: push subsequent legs forward if gap < 30 min (minimum turnaround)
      const MIN_TURN_MS = 30 * 60_000;
      edctIntervals.sort((a, b) => a.startMs - b.startMs);
      for (let i = 1; i < edctIntervals.length; i++) {
        const gap = edctIntervals[i].startMs - edctIntervals[i - 1].endMs;
        if (gap < MIN_TURN_MS) {
          const shift = MIN_TURN_MS - gap;
          edctIntervals[i].startMs += shift;
          edctIntervals[i].endMs += shift;
        }
      }

      // EDCT rolling 24hr max (forward-looking only)
      const nowMsEdct = Date.now();
      const checkPoints = new Set<number>();
      for (const leg of edctIntervals) {
        checkPoints.add(leg.startMs);
        checkPoints.add(leg.endMs);
        checkPoints.add(leg.startMs + WINDOW_MS);
        checkPoints.add(leg.endMs + WINDOW_MS);
      }
      let maxMs = 0;
      for (const wp of checkPoints) {
        const ws = wp - WINDOW_MS;
        const hasFutureLeg = edctIntervals.some(l => l.endMs >= nowMsEdct && l.startMs < wp && l.endMs > ws);
        if (!hasFutureLeg) continue;
        let totalMs = 0;
        for (const leg of edctIntervals) {
          const os = Math.max(leg.startMs, ws);
          const oe = Math.min(leg.endMs, wp);
          if (oe > os) totalMs += oe - os;
        }
        if (totalMs > maxMs) maxMs = totalMs;
      }

      // EDCT rest: use EDCT-shifted today's duty off + NORMAL tomorrow's duty on
      // This correctly shows compressed rest (EDCT delays → finish later → less rest)
      let edctRestMin: number | null = null;
      let edctRestStartMs: number | null = null;
      if (normalDuty.tomorrowDpOnMs != null) {
        // Find EDCT today's DP off: group EDCT intervals into DPs, find today's
        const todayUtcDate = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
        const todayUtcEnd = todayUtcDate + 24 * 60 * 60 * 1000;
        // Find the last EDCT interval that departs today (or was part of today's original DP)
        let edctTodayLastArr = 0;
        for (const iv of edctIntervals) {
          // Use original intervals to determine which legs belong to "today's duty"
          const origIv = normalDuty.intervals.find(o => o.depIcao === iv.depIcao && o.arrIcao === iv.arrIcao);
          const origDep = origIv?.startMs ?? iv.startMs;
          if (origDep >= todayUtcDate && origDep < todayUtcEnd) {
            edctTodayLastArr = Math.max(edctTodayLastArr, iv.endMs);
          }
        }
        if (edctTodayLastArr > 0) {
          const edctOff = edctTodayLastArr + POST_TIME_MS;
          edctRestMin = Math.max(0, (normalDuty.tomorrowDpOnMs - edctOff) / 60_000);
          edctRestStartMs = edctOff;
        }
      }
      // Fallback: if no tomorrow DP, use same rest as normal (EDCT doesn't matter)
      if (edctRestMin == null && normalDuty.restMin != null && normalDuty.tomorrowDpOnMs == null) {
        edctRestMin = normalDuty.restMin;
        edctRestStartMs = normalDuty.restStartMs;
      }

      result.set(tail, {
        flightTimeMin: maxMs / 60_000,
        restMin: edctRestMin,
        restStartMs: edctRestStartMs,
        todayDpOffMs: null,
        tomorrowDpOnMs: null,
        intervals: edctIntervals,
      });
    }

    return result;
  }, [flights, tailDuty]);

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
                  {(() => {
                    // Extract the filed identifier (KOW callsign or N-number) from subject
                    const filedAs = a.subject?.match(/\((KOW\d+|N\d+[A-Z]*)\)/i)?.[1]
                      ?? a.subject?.match(/EDCT\s+(KOW\d+|N\d+[A-Z]*)/i)?.[1]
                      ?? null;
                    const tail = a.tail_number;
                    const showFiledAs = filedAs && tail && filedAs.toUpperCase() !== tail.toUpperCase();
                    return tail ? (
                      <span className="text-amber-600">
                        {tail}{showFiledAs && <span className="text-amber-400 text-xs ml-0.5">({filedAs})</span>}
                      </span>
                    ) : filedAs ? (
                      <span className="text-amber-600">{filedAs}</span>
                    ) : null;
                  })()}
                  <span className={`text-[10px] font-bold rounded px-1 py-0.5 ${
                    (a.source_message_id ?? "").startsWith("swim-edct-")
                      ? "bg-blue-100 text-blue-700"
                      : "bg-amber-100 text-amber-700"
                  }`}>{(a.source_message_id ?? "").startsWith("swim-edct-") ? "SWIM" : "FF"}</span>
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
      {swimFlow.length > 0 && (() => {
        // Cross-reference flow events against Baker flights
        const normalizeIcao = (icao: string) => icao.startsWith("K") && icao.length === 4 ? icao.slice(1) : icao;
        const flowAirportSet = new Set<string>();
        for (const ev of swimFlow) {
          if (ev.airport_icao) {
            flowAirportSet.add(ev.airport_icao);
            flowAirportSet.add(normalizeIcao(ev.airport_icao));
            if (!ev.airport_icao.startsWith("K") && ev.airport_icao.length === 3) flowAirportSet.add("K" + ev.airport_icao);
          }
        }
        const affectedFlightsByAirport = new Map<string, typeof flights>();
        for (const f of flights) {
          for (const icao of [f.departure_icao, f.arrival_icao].filter(Boolean) as string[]) {
            const norm = normalizeIcao(icao);
            const kIcao = icao.startsWith("K") ? icao : "K" + icao;
            if (flowAirportSet.has(icao) || flowAirportSet.has(norm) || flowAirportSet.has(kIcao)) {
              const key = norm;
              if (!affectedFlightsByAirport.has(key)) affectedFlightsByAirport.set(key, []);
              affectedFlightsByAirport.get(key)!.push(f);
            }
          }
        }
        const flowAffectsAirport = (icao: string | null) => {
          if (!icao) return false;
          const norm = normalizeIcao(icao);
          return affectedFlightsByAirport.has(norm) || affectedFlightsByAirport.has(icao);
        };
        const affectedFlow = swimFlow.filter(ev => flowAffectsAirport(ev.airport_icao));
        const unaffectedFlow = swimFlow.filter(ev => !flowAffectsAirport(ev.airport_icao));

        const formatSubject = (subject: string) => subject.replace(/\((\d+\.?\d*)\s*min avg delay\)/, (_, m) => {
          const mins = parseFloat(m);
          return mins >= 60 ? `(~${(mins / 60).toFixed(1)} hr avg delay)` : `(~${Math.round(mins)} min avg delay)`;
        });

        const airportLabel = (icao: string | null) => {
          if (!icao) return null;
          const code = icao.startsWith("K") && icao.length === 4 ? icao.slice(1) : icao;
          const info = getAirportInfo(code) ?? getAirportInfo(icao);
          return info ? `${code} (${info.name})` : icao;
        };

        const getAffectedTails = (icao: string | null) => {
          if (!icao) return [];
          const norm = normalizeIcao(icao);
          const af = affectedFlightsByAirport.get(norm) ?? affectedFlightsByAirport.get(icao) ?? [];
          return [...new Set(af.map(f => f.tail_number).filter(Boolean) as string[])];
        };

        const renderFlowEvent = (ev: SwimFlowEvent) => (
          <div key={ev.id} className="flex items-start gap-3 text-sm text-red-900">
            <span className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-bold uppercase ${
              ev.event_type === "GROUND_STOP" ? "bg-red-200 text-red-800" :
              ev.event_type === "GDP" ? "bg-amber-200 text-amber-800" :
              "bg-orange-200 text-orange-800"
            }`}>
              {ev.event_type.replace(/_/g, " ")}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {ev.airport_icao && <span className="font-semibold">{airportLabel(ev.airport_icao)}</span>}
                <span className="text-red-700">{formatSubject(ev.subject?.replace(/^[A-Z_ ]+ at [A-Z]{3,4}\s*/, "") ?? "")}</span>
              </div>
              {(() => {
                const tails = getAffectedTails(ev.airport_icao);
                return tails.length > 0 ? (
                  <div className="text-xs text-red-600 mt-0.5">
                    Affects: {tails.map(t => <span key={t} className="font-mono font-semibold mr-1.5">{t}</span>)}
                  </div>
                ) : null;
              })()}
            </div>
            {ev.expires_at && (
              <span className="shrink-0 text-xs text-red-400">
                until {new Date(ev.expires_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}
              </span>
            )}
          </div>
        );

        return (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            {affectedFlow.length > 0 && (
              <>
                <div className="flex items-center gap-2 mb-2 text-sm">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="font-semibold text-red-800">
                    {affectedFlow.length} Flow Event{affectedFlow.length !== 1 ? "s" : ""} Affecting Baker Flights
                  </span>
                  <span className="ml-auto text-xs text-red-400">via FAA SWIM</span>
                </div>
                <div className="space-y-2">
                  {affectedFlow.map(renderFlowEvent)}
                </div>
              </>
            )}
            {unaffectedFlow.length > 0 && (
              <details className={affectedFlow.length > 0 ? "mt-3 border-t border-red-200 pt-2" : ""}>
                <summary className="cursor-pointer text-xs text-red-400 hover:text-red-600 select-none">
                  {affectedFlow.length === 0 && <span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block mr-2" />}
                  {unaffectedFlow.length} other flow event{unaffectedFlow.length !== 1 ? "s" : ""} (no Baker flights affected)
                </summary>
                <div className="space-y-1.5 mt-2">
                  {unaffectedFlow.map(renderFlowEvent)}
                </div>
              </details>
            )}
          </div>
        );
      })()}

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
              {r}{extendedLoading && timeRange === r && RANGE_LOOKAHEAD[r] > loadedLookahead ? "…" : ""}
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
                          {/* Diversion dots disabled — FA diverted flag too unreliable */}
                        </span>
                        <div className="flex items-center gap-2">
                          {duty && (() => {
                            const edctDuty = tailDutyEdct?.get(tail);
                            const dutyDiffers = edctDuty && Math.abs(edctDuty.flightTimeMin - duty.flightTimeMin) > 5;
                            // Only show EDCT rest when it measures the same rest period (start times within 2h).
                            // EDCT delays can create phantom 8h+ gaps that get treated as rest periods — suppress those.
                            // EDCT rest: only show when shorter (EDCT delays compress tonight's rest)
                            const restDiffers = edctDuty && edctDuty.restMin != null && duty.restMin != null
                              && duty.restMin - edctDuty.restMin > 5;
                            return (
                              <>
                                <div className="flex flex-col items-end gap-0.5">
                                  <button
                                    onClick={() => onSwitchToDuty?.(tail)}
                                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded cursor-pointer hover:opacity-80 transition-opacity ${dutyColor(duty.flightTimeMin)}`}
                                    title="View detailed 10/24 breakdown"
                                  >
                                    <span className="text-[10px]">{LEVEL_ICONS[dutyLevel(duty.flightTimeMin)]}</span>
                                    {fmtHM(duty.flightTimeMin)}
                                  </button>
                                  {dutyDiffers && (() => {
                                    const el = dutyLevel(edctDuty.flightTimeMin);
                                    return (
                                      <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono font-medium rounded ${LEVEL_COLORS[el]}`}>
                                        <span className="text-[9px]">{LEVEL_ICONS[el]}</span>
                                        {fmtHM(edctDuty.flightTimeMin)} <span className="opacity-70">(EDCT)</span>
                                      </span>
                                    );
                                  })()}
                                </div>
                                {duty.restMin != null && (() => {
                                  const rl = restLevel(duty.restMin);
                                  if (!rl) return null;
                                  return (
                                    <div className="flex flex-col items-end gap-0.5">
                                      <button
                                        onClick={() => onSwitchToDuty?.(tail)}
                                        className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded cursor-pointer hover:opacity-80 transition-opacity ${LEVEL_COLORS[rl]}`}
                                        title="View detailed crew rest breakdown"
                                      >
                                        <span className="text-[10px]">{LEVEL_ICONS[rl]}</span>
                                        R:{fmtHM(duty.restMin!)}
                                      </button>
                                      {restDiffers && (() => {
                                        const erl = restLevel(edctDuty.restMin!);
                                        if (!erl) return null;
                                        return (
                                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono font-medium rounded ${LEVEL_COLORS[erl]}`}>
                                            <span className="text-[9px]">{LEVEL_ICONS[erl]}</span>
                                            R:{fmtHM(edctDuty.restMin!)} <span className="opacity-70">(EDCT)</span>
                                          </span>
                                        );
                                      })()}
                                    </div>
                                  );
                                })()}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {tailFlights.map((f) => {
                          // Primary: direct fa_flight_id match
                          let fi: FlightInfoMap | undefined;
                          let idMatched = false;
                          if (f.fa_flight_id && flightInfo.has(`fa:${f.fa_flight_id}`)) {
                            fi = flightInfo.get(`fa:${f.fa_flight_id}`);
                            idMatched = true;
                          }
                          if (!fi && f.tail_number) {
                            const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
                            fi = matchFlightInfo(flightInfo, routeKey, f.tail_number, f.departure_icao, f.scheduled_departure, f.arrival_icao);
                          }
                          const type = f.flight_type || "Other";
                          const typeColor = FLIGHT_TYPE_COLORS[type] || "bg-gray-100 text-gray-700";

                          let status = "Scheduled";
                          let statusColor = "text-gray-500";
                          let isFiled = false;
                          const arrivalDate = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
                          const now = new Date();
                          const fiRouteMatch = idMatched || (fi && fi.destination_icao === f.arrival_icao);
                          const faEta = fiRouteMatch && fi?.arrival_time ? new Date(fi.arrival_time) : null;
                          const arrivalPassed = (arrivalDate && arrivalDate < now) || (faEta && faEta < now);
                          // "No Departure" uses only the scheduled arrival — FA ETA being in the past
                          // just means FA's estimate was wrong, not that the plane didn't depart.
                          const schedArrPassed = arrivalDate && arrivalDate < now;
                          // Check SWIM status — route-specific for "En Route", tail fallback for others
                          const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
                          const swimRouteMatch = swimStatus.get(routeKey);
                          const swimEntry = swimRouteMatch ?? (f.tail_number ? swimStatus.get(`${f.tail_number}||`) : undefined);
                          const swimRouteStale = isSwimStale(swimRouteMatch, f.scheduled_departure);
                          const swimEntryStale = isSwimStale(swimEntry, f.scheduled_departure);
                          // Position mismatch: FA says aircraft is NOT at departure airport
                          const posNorm = (c: string | null | undefined) => c ? (c.length === 3 && /^[A-Z]/.test(c) ? `K${c}` : c) : null;
                          const faLoc = f.tail_number ? tailFaLocation.get(f.tail_number) : null;
                          const atDeparture = !faLoc || posNorm(faLoc.icao) === posNorm(f.departure_icao);
                          const faAtDest = faLoc && f.arrival_icao && posNorm(faLoc.icao) === posNorm(f.arrival_icao);

                          // FA primary; SWIM supplements when FA hasn't detected takeoff yet
                          // Timeline after scheduled arrival passes (FA has no actual dep/arr):
                          //   +15min → "Late"  |  +60min → "No Departure"  |  +2h → assume "Arrived"
                          const arrMs = arrivalDate ? arrivalDate.getTime() : 0;
                          const arrOverdueMin = arrMs > 0 && schedArrPassed ? (now.getTime() - arrMs) / 60_000 : 0;
                          const noDepStale = arrOverdueMin > 120;
                          const noDepConditions = !fi?.actual_departure && !fi?.actual_arrival
                            && !fi?.status?.includes("En Route") && !fi?.status?.includes("Landed");
                          if (fiRouteMatch && (fi?.actual_arrival || fi?.status?.includes("Arrived") || fi?.status?.includes("Landed"))) {
                            status = "Arrived"; statusColor = "text-green-600 font-medium";
                          } else if (arrOverdueMin >= 60 && !noDepStale && fiRouteMatch && noDepConditions && !faAtDest) {
                            status = "No Departure"; statusColor = "text-orange-600 font-bold";
                          } else if (arrOverdueMin >= 60 && !noDepStale && !fiRouteMatch && faLoc && !fi?.actual_departure && !faAtDest) {
                            status = "No Departure"; statusColor = "text-orange-600 font-bold";
                          } else if (arrOverdueMin >= 15 && !noDepStale && fiRouteMatch && noDepConditions && !faAtDest) {
                            status = "Late"; statusColor = "text-amber-600 font-bold";
                          } else if (arrOverdueMin >= 15 && !noDepStale && !fiRouteMatch && faLoc && !fi?.actual_departure && !faAtDest) {
                            status = "Late"; statusColor = "text-amber-600 font-bold";
                          } else if (arrivalPassed) {
                            status = "Arrived"; statusColor = "text-green-600 font-medium";
                          } else if (fiRouteMatch && fi?.status?.includes("En Route")) {
                            status = "En Route"; statusColor = "text-blue-600 font-medium";
                          } else if (fiRouteMatch && fi?.actual_departure && !fi?.actual_arrival
                            && new Date(fi.actual_departure) < now && (!faEta || faEta > now)
                            && !fi?.status?.includes("Scheduled") && !fi?.status?.includes("Cancelled")) {
                            status = "En Route"; statusColor = "text-blue-600 font-medium";
                          } else if (!swimRouteStale && swimRouteMatch?.status === "En Route") {
                            status = "En Route"; statusColor = "text-blue-600 font-medium";
                          } else if (fiRouteMatch && fi?.status === "Filed") {
                            isFiled = true; statusColor = "text-indigo-600 font-medium";
                          } else if (!fiRouteMatch && !swimEntryStale && swimEntry?.status === "Arrived") {
                            status = "Arrived"; statusColor = "text-green-600 font-medium";
                          } else if (!fiRouteMatch && !swimEntryStale && swimEntry?.status === "Diverted") {
                            status = "DIVERTED"; statusColor = "text-red-600 font-bold";
                          } else if (!fiRouteMatch && !swimEntryStale && swimEntry?.status === "Filed") {
                            status = "Scheduled"; isFiled = true; statusColor = "text-gray-500";
                          } else if (fi?.actual_arrival) {
                            status = "Arrived"; statusColor = "text-green-600 font-medium";
                          }
                          // Diversion display disabled — FA diverted flag too unreliable (re-enable later)
                          if (f.tail_number && holdingTails.has(f.tail_number) && status === "En Route") { status = "HOLDING"; statusColor = "text-red-600 font-bold animate-pulse"; }

                          const supersedInfo = supersededMap.get(f.id);
                          const isCancelled = !!supersedInfo && !supersedInfo.diverting && !supersedInfo.diverted;
                          const isFaSourced = f.id.startsWith("fa-");
                          if (isCancelled) {
                            status = supersedInfo.diverted ? "DIVERTED" : "Cancelled";
                            statusColor = supersedInfo.diverted ? "text-red-600 font-bold" : "text-red-600 font-medium";
                          }

                          const actualDepIso = isCancelled ? null : (fi?.actual_departure ?? (!swimEntryStale ? swimEntry?.actual_departure : null) ?? null);
                          const actualArrIso = isCancelled ? null : (fi?.actual_arrival ?? (!swimEntryStale ? swimEntry?.actual_arrival : null) ?? null);


                          return (
                            <div key={f.id} className={`px-4 py-2 text-xs ${isCancelled ? "opacity-50 bg-gray-50" : ""} ${isFaSourced ? "bg-blue-50/40" : ""}`}>
                              <div className="flex items-center gap-3">
                                <div className="w-28 shrink-0">
                                  <span className="font-mono font-medium text-gray-800">
                                    {f.departure_icao || "?"} →{" "}
                                    {isCancelled ? (
                                      <>
                                        <span className="line-through text-red-400">{f.arrival_icao || "?"}</span>
                                        {supersedInfo!.actualDest && (
                                          <span className="text-red-600 font-bold ml-1">{supersedInfo!.actualDest}</span>
                                        )}
                                      </>
                                    ) : (f.arrival_icao || "?")}
                                  </span>
                                  {/* Position mismatch: aircraft not at departure airport per FA */}
                                  {(() => {
                                    if (isCancelled || !f.tail_number || !f.departure_icao) return null;
                                    if (status !== "Scheduled" && status !== "No Departure" && status !== "Late" && !isFiled) return null;
                                    if (!faLoc || atDeparture) return null;
                                    return (
                                      <div className="text-[10px] font-medium text-orange-600 leading-tight">
                                        Aircraft at {faLoc.icao}
                                      </div>
                                    );
                                  })()}
                                </div>
                                <div className="w-36 shrink-0">
                                  <div className="text-gray-500">
                                    {fmt(f.scheduled_departure, f.departure_icao)}
                                  </div>
                                  {!isCancelled && actualDepIso ? (
                                    <div className={`text-[10px] font-medium ${delayColorClass(f.scheduled_departure, actualDepIso)}`}>
                                      Actual: {fmt(actualDepIso, f.departure_icao)}
                                    </div>
                                  ) : (() => {
                                    const edctAlert = getActiveEdct(f);
                                    if (edctAlert && !isCancelled) {
                                      return (
                                        <div className="text-[10px] font-medium text-amber-700">
                                          EDCT: {fmtEdctTime(edctAlert.edct_time!, f.scheduled_departure, f.departure_icao)}
                                          <span className="ml-1 px-1 py-px rounded bg-amber-100 text-amber-600 text-[9px] font-medium">{edctSourceTag(edctAlert)}</span>
                                        </div>
                                      );
                                    }
                                    // Show FA estimated departure only when LATER than scheduled (≥5min)
                                    // If FA says earlier than scheduled, ignore it — nobody's departing early
                                    if (!isCancelled && fi?.departure_time && !fi.actual_departure) {
                                      const faDepMs = new Date(fi.departure_time).getTime();
                                      const schedMs = new Date(f.scheduled_departure).getTime();
                                      const diffMin = Math.round((faDepMs - schedMs) / 60_000);
                                      if (diffMin >= 5) {
                                        return (
                                          <div className={`text-[10px] font-medium ${diffMin > 15 ? "text-red-600" : "text-amber-600"}`}>
                                            FA Est: {fmt(fi.departure_time, f.departure_icao)}
                                          </div>
                                        );
                                      }
                                    }
                                    return null;
                                  })()}
                                </div>
                                <div className="w-36 shrink-0">
                                  <div className="text-gray-500">
                                    {fmt(f.scheduled_arrival, f.arrival_icao)}
                                  </div>
                                  {!isCancelled && actualArrIso && f.scheduled_arrival ? (
                                    <div className={`text-[10px] font-medium ${delayColorClass(f.scheduled_arrival, actualArrIso)}`}>
                                      Actual: {fmt(actualArrIso, f.arrival_icao)}
                                    </div>
                                  ) : !isCancelled && fiRouteMatch && fi?.arrival_time && (fi?.actual_departure || fi?.departure_time) && !actualArrIso ? (
                                    <div className="text-[10px] text-blue-600 font-medium">
                                      ETA: {fmt(
                                        f.scheduled_arrival && new Date(fi.arrival_time).getTime() < new Date(f.scheduled_arrival).getTime()
                                          ? f.scheduled_arrival : fi.arrival_time,
                                        f.arrival_icao,
                                      )}
                                    </div>
                                  ) : !isCancelled && status === "En Route" && !swimRouteStale && swimRouteMatch?.eta ? (
                                    <div className="text-[10px] text-blue-600 font-medium">
                                      ETA: {fmt(swimRouteMatch.eta, f.arrival_icao)}
                                    </div>
                                  ) : (() => {
                                    const edctAlert = getActiveEdct(f);
                                    if (!edctAlert || !f.scheduled_arrival || isCancelled) return null;
                                    const deltaMs = new Date(edctAlert.edct_time!).getTime() - new Date(f.scheduled_departure).getTime();
                                    const edctEtaIso = new Date(new Date(f.scheduled_arrival).getTime() + deltaMs).toISOString();
                                    return (
                                      <div className="text-[10px] font-medium text-amber-700">
                                        EDCT ETA: {fmtEdctTime(edctEtaIso, f.scheduled_departure, f.arrival_icao)}
                                      </div>
                                    );
                                  })()}
                                </div>
                                <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${typeColor}`}>
                                  {type}
                                </span>
                                {(() => {
                                  const edctAlert = getActiveEdct(f);
                                  if (status === "Scheduled") {
                                    return (
                                      <div className="flex flex-col">
                                        <span className={`text-xs ${statusColor}`}>{status}</span>
                                        {edctAlert && (
                                          <span className="text-[10px] font-medium text-amber-600">EDCT</span>
                                        )}
                                        {isFiled && (
                                          <span className="text-[10px] text-indigo-500 whitespace-nowrap">
                                            IFR Filed{swimEntry?.etd ? ` ${fmt(swimEntry.etd, f.departure_icao)}` : ""}
                                          </span>
                                        )}
                                      </div>
                                    );
                                  }
                                  if (edctAlert && status === "En Route") {
                                    return (
                                      <span className="text-xs">
                                        <span className={statusColor}>{status}</span>
                                        <span className="ml-1 text-[10px] text-amber-600 font-medium">EDCT</span>
                                      </span>
                                    );
                                  }
                                  return <span className={`text-xs ${statusColor}`}>{status}</span>;
                                })()}
                                {isFaSourced && (
                                  <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-100 text-blue-700">FA</span>
                                )}
                                {/* Time-based progress bar for en route flights */}
                                {!isCancelled && status === "En Route" && (() => {
                                  const depStr = (!swimRouteStale ? swimRouteMatch?.etd : null) ?? fi?.actual_departure ?? fi?.departure_time ?? (!swimEntryStale ? swimEntry?.actual_departure : null);
                                  let arrStr = (fiRouteMatch ? fi?.arrival_time : null) ?? (!swimRouteStale ? swimRouteMatch?.eta : null) ?? (!swimEntryStale ? swimEntry?.eta : null);
                                  if (!arrStr && f.scheduled_arrival && f.scheduled_departure && depStr) {
                                    const delayMs = new Date(depStr).getTime() - new Date(f.scheduled_departure).getTime();
                                    arrStr = new Date(new Date(f.scheduled_arrival).getTime() + delayMs).toISOString();
                                  }
                                  if (!depStr || !arrStr) return null;
                                  const dep = new Date(depStr).getTime();
                                  const arr = new Date(arrStr).getTime();
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
                              {/* Remark row */}
                              {editingRemarkId === f.id ? (
                                <div className="px-4 pb-2">
                                  <input
                                    type="text"
                                    autoFocus
                                    className="w-full text-xs border border-blue-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
                                    maxLength={500}
                                    placeholder="Add a remark..."
                                    value={remarkDraft}
                                    onChange={(e) => setRemarkDraft(e.target.value)}
                                    onBlur={() => saveRemark(f.id, remarkDraft)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") { e.preventDefault(); saveRemark(f.id, remarkDraft); }
                                      if (e.key === "Escape") setEditingRemarkId(null);
                                    }}
                                  />
                                </div>
                              ) : remarks.get(f.id) ? (
                                <div
                                  className="px-4 pb-2 text-xs text-gray-500 italic cursor-pointer hover:text-gray-700"
                                  onClick={() => { setEditingRemarkId(f.id); setRemarkDraft(remarks.get(f.id)?.remark ?? ""); }}
                                  title="Click to edit"
                                >
                                  {remarks.get(f.id)!.remark}
                                </div>
                              ) : (
                                <div
                                  className="px-4 pb-1 cursor-pointer group"
                                  onClick={() => { setEditingRemarkId(f.id); setRemarkDraft(""); }}
                                >
                                  <span className="text-[10px] text-gray-300 group-hover:text-gray-400 italic">+ remark</span>
                                </div>
                              )}
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
      <div className="rounded-xl border border-gray-200 bg-white overflow-x-auto">
        <table className="w-full table-fixed text-sm min-w-[1100px]">
          <colgroup>
            <col style={{ width: "6%" }} />   {/* Status */}
            <col style={{ width: "6%" }} />   {/* Tail */}
            <col style={{ width: "10%" }} />  {/* Route */}
            <col style={{ width: "9%" }} />   {/* Departure */}
            <col style={{ width: "9%" }} />   {/* Arrival */}
            <col style={{ width: "6%" }} />   {/* Type */}
            <col style={{ width: "5%" }} />   {/* 10/24 */}
            <col style={{ width: "5%" }} />   {/* Rest */}
            <col style={{ width: "7%" }} />   {/* Alerts */}
            <col style={{ width: "7%" }} />   {/* Sales */}
            <col style={{ width: "12%" }} />  {/* Remarks */}
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
                  <span className="whitespace-nowrap">Alerts</span>
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
              <th className="px-3 py-3">Remarks</th>
            </tr>
          </thead>
          <tbody>
            {tableFlights.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-gray-400">
                  No flights scheduled for selected filters
                </td>
              </tr>
            ) : (
              tableFlights.map((f) => {
                // Primary: direct fa_flight_id match
                let fi: FlightInfoMap | undefined;
                let idMatched = false;
                if (f.fa_flight_id && flightInfo.has(`fa:${f.fa_flight_id}`)) {
                  fi = flightInfo.get(`fa:${f.fa_flight_id}`);
                  idMatched = true;
                }
                if (!fi && f.tail_number) {
                  const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
                  fi = matchFlightInfo(flightInfo, routeKey, f.tail_number, f.departure_icao, f.scheduled_departure, f.arrival_icao);
                }
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
                const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
                const swimRouteMatch = swimStatus.get(routeKey);
                const swimEntry = swimRouteMatch ?? (f.tail_number ? swimStatus.get(`${f.tail_number}||`) : undefined);
                const swimRouteStale = isSwimStale(swimRouteMatch, f.scheduled_departure);
                const swimEntryStale = isSwimStale(swimEntry, f.scheduled_departure);

                const arrivalDate = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
                const now = new Date();
                const fiRouteMatch = idMatched || (fi && fi.destination_icao === f.arrival_icao);
                const faEta = fiRouteMatch && fi?.arrival_time ? new Date(fi.arrival_time) : null;
                const arrivalPassed = (arrivalDate && arrivalDate < now) || (faEta && faEta < now);
                // "No Departure" uses only scheduled arrival — FA ETA in the past just means stale estimate
                const schedArrPassed2 = arrivalDate && arrivalDate < now;

                // Position mismatch: FA says aircraft is NOT at departure airport
                const posNorm2 = (c: string | null | undefined) => c ? (c.length === 3 && /^[A-Z]/.test(c) ? `K${c}` : c) : null;
                const faLoc2 = f.tail_number ? tailFaLocation.get(f.tail_number) : null;
                const faAtDest2 = faLoc2 && f.arrival_icao && posNorm2(faLoc2.icao) === posNorm2(f.arrival_icao);

                // FA primary; SWIM supplements when FA hasn't detected takeoff yet
                // Timeline: +15min → "Late"  |  +60min → "No Departure"  |  +2h → assume "Arrived"
                const arrMs2 = arrivalDate ? arrivalDate.getTime() : 0;
                const arrOverdueMin2 = arrMs2 > 0 && schedArrPassed2 ? (now.getTime() - arrMs2) / 60_000 : 0;
                const noDepStale2 = arrOverdueMin2 > 120;
                const noDepConditions2 = !fi?.actual_departure && !fi?.actual_arrival
                  && !fi?.status?.includes("En Route") && !fi?.status?.includes("Landed");
                if (fiRouteMatch && (fi?.actual_arrival || fi?.status?.includes("Arrived") || fi?.status?.includes("Landed"))) {
                  status = "Arrived"; statusColor = "text-green-600 font-medium";
                } else if (arrOverdueMin2 >= 60 && !noDepStale2 && fiRouteMatch && noDepConditions2 && !faAtDest2) {
                  status = "No Departure"; statusColor = "text-orange-600 font-bold";
                } else if (arrOverdueMin2 >= 60 && !noDepStale2 && !fiRouteMatch && faLoc2 && !fi?.actual_departure && !faAtDest2) {
                  status = "No Departure"; statusColor = "text-orange-600 font-bold";
                } else if (arrOverdueMin2 >= 15 && !noDepStale2 && fiRouteMatch && noDepConditions2 && !faAtDest2) {
                  status = "Late"; statusColor = "text-amber-600 font-bold";
                } else if (arrOverdueMin2 >= 15 && !noDepStale2 && !fiRouteMatch && faLoc2 && !fi?.actual_departure && !faAtDest2) {
                  status = "Late"; statusColor = "text-amber-600 font-bold";
                } else if (arrivalPassed) {
                  status = "Arrived"; statusColor = "text-green-600 font-medium";
                } else if (fiRouteMatch && fi?.status?.includes("En Route")) {
                  status = "En Route"; statusColor = "text-blue-600 font-medium";
                } else if (fiRouteMatch && fi?.actual_departure && !fi?.actual_arrival
                  && new Date(fi.actual_departure) < now && (!faEta || faEta > now)
                  && !fi?.status?.includes("Scheduled") && !fi?.status?.includes("Cancelled")) {
                  status = "En Route"; statusColor = "text-blue-600 font-medium";
                } else if (!swimRouteStale && swimRouteMatch?.status === "En Route") {
                  status = "En Route"; statusColor = "text-blue-600 font-medium";
                } else if (fiRouteMatch && fi?.status === "Filed") {
                  status = fi.status; isFiled = true; statusColor = "text-indigo-600 font-medium";
                } else if (!fiRouteMatch && !swimEntryStale && swimEntry?.status === "Arrived") {
                  status = "Arrived"; statusColor = "text-green-600 font-medium";
                } else if (!fiRouteMatch && !swimEntryStale && swimEntry?.status === "Cancelled") {
                  status = "Cancelled"; statusColor = "text-red-600 font-medium";
                } else if (!fiRouteMatch && !swimEntryStale && swimEntry?.status === "Filed") {
                  status = "Scheduled"; isFiled = true;
                } else if (fi?.actual_arrival) {
                  status = "Arrived"; statusColor = "text-green-600 font-medium";
                }

                // Diversion display disabled — FA diverted flag too unreliable (re-enable later)
                if (f.tail_number && holdingTails.has(f.tail_number) && (status === "En Route")) {
                  status = "HOLDING";
                  statusColor = "text-red-600 font-bold animate-pulse";
                }

                // Check if this leg is superseded by FA (route changed only, not diverted)
                const supersedInfo = supersededMap.get(f.id);
                const isCancelled = !!supersedInfo && !supersedInfo.diverting && !supersedInfo.diverted;
                const isFaSourced = f.id.startsWith("fa-");
                if (isCancelled) {
                  status = "Cancelled";
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
                    // Only flag delays (positive diff), not early estimates
                    if (diffMin >= MISMATCH_THRESHOLD_MIN) {
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
                          {(() => {
                            const edctAlert = getActiveEdct(f);
                            if (status === "Scheduled") {
                              return (
                                <>
                                  <span className={`text-xs font-medium ${statusColor}`}>{status}</span>
                                  {edctAlert && (
                                    <span className="text-[10px] font-medium text-amber-600">EDCT</span>
                                  )}
                                  {isFiled && (
                                    <span className="text-[10px] text-indigo-500 font-medium whitespace-nowrap">
                                      IFR Filed{swimEntry?.etd ? ` ${fmt(swimEntry.etd, f.departure_icao)}` : ""}
                                    </span>
                                  )}
                                </>
                              );
                            }
                            if (edctAlert && status === "En Route") {
                              return (
                                <>
                                  <span className={`text-xs font-medium ${statusColor}`}>{status}</span>
                                  <span className="text-[10px] text-amber-600 font-medium">EDCT</span>
                                </>
                              );
                            }
                            return <span className={`text-xs font-medium ${statusColor}`}>{status}</span>;
                          })()}
                          {isFaSourced && (
                            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-100 text-blue-700">
                              FA Source
                            </span>
                          )}
                          {flowAffectedAirports.size > 0 && [f.departure_icao, f.arrival_icao].some(icao => {
                            if (!icao) return false;
                            const norm = icao.startsWith("K") && icao.length === 4 ? icao.slice(1) : icao;
                            return flowAffectedAirports.has(icao) || flowAffectedAirports.has(norm) || flowAffectedAirports.has("K" + norm);
                          }) && (
                            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-red-100 text-red-700">
                              SWIM
                            </span>
                          )}
                          {(() => {
                            const schedMs = new Date(f.scheduled_departure).getTime();
                            const nowMs = Date.now();
                            if (schedMs < nowMs && !fi?.actual_departure && status === "Scheduled" && !getActiveEdct(f)) {
                              const lateMin = Math.round((nowMs - schedMs) / 60_000);
                              return (
                                <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold rounded-full ${lateMin > 30 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                                  +{lateMin}m late
                                </span>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono font-semibold text-gray-900">
                        <span className="inline-flex items-center gap-1.5">
                          {f.tail_number || "—"}
                          {/* Diversion dots disabled — FA diverted flag too unreliable */}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="font-mono font-medium">
                          {f.departure_icao || "?"} →{" "}
                          {isCancelled ? (
                            <>
                              <span className="line-through text-red-400">{f.arrival_icao || "?"}</span>
                              {supersedInfo!.actualDest && (
                                <span className="text-red-600 font-bold ml-1">{supersedInfo!.actualDest}</span>
                              )}
                            </>
                          ) : (f.arrival_icao || "?")}
                        </span>
                        {/* Position mismatch: aircraft not at departure airport per FA */}
                        {(status === "No Departure" || status === "Late") && faLoc2 && posNorm2(faLoc2.icao) !== posNorm2(f.departure_icao) && (
                          <div className="text-[10px] font-medium text-orange-600 leading-tight">
                            Aircraft at {faLoc2.icao}
                          </div>
                        )}
                        {/* Time-based progress bar + remaining for en route flights */}
                        {!isCancelled && status === "En Route" && (() => {
                          const depStr = (!swimRouteStale ? swimRouteMatch?.etd : null) ?? fi?.actual_departure ?? fi?.departure_time ?? (!swimEntryStale ? swimEntry?.actual_departure : null);
                          let arrStr = (fiRouteMatch ? fi?.arrival_time : null) ?? (!swimRouteStale ? swimRouteMatch?.eta : null) ?? (!swimEntryStale ? swimEntry?.eta : null);
                          if (!arrStr && f.scheduled_arrival && f.scheduled_departure && depStr) {
                            const delayMs = new Date(depStr).getTime() - new Date(f.scheduled_departure).getTime();
                            arrStr = new Date(new Date(f.scheduled_arrival).getTime() + delayMs).toISOString();
                          }
                          if (!depStr || !arrStr) return null;
                          const dep = new Date(depStr).getTime();
                          const arr = new Date(arrStr).getTime();
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
                        {!isCancelled && (fi?.actual_departure ?? (!swimEntryStale ? swimEntry?.actual_departure : null)) ? (
                          <div className={`text-[10px] font-medium mt-0.5 ${delayColorClass(f.scheduled_departure, (fi?.actual_departure ?? swimEntry?.actual_departure)!)}`}>
                            Actual: {fmt((fi?.actual_departure ?? swimEntry?.actual_departure)!, f.departure_icao)}
                          </div>
                        ) : !isCancelled ? (() => {
                          const edctAlert = getActiveEdct(f);
                          const faEstDiff = fi?.departure_time ? Math.round((new Date(fi.departure_time).getTime() - new Date(f.scheduled_departure).getTime()) / 60_000) : 0;
                          // Only show FA estimate if it's LATER than scheduled (≥5min delay)
                          const showFaEst = fi?.departure_time && faEstDiff >= 5;
                          return (
                            <>
                              {edctAlert && (
                                <div className="text-[10px] font-medium mt-0.5 text-amber-700">
                                  EDCT: {fmtEdctTime(edctAlert.edct_time!, f.scheduled_departure, f.departure_icao)}
                                  <span className="ml-1 px-1 py-px rounded bg-amber-100 text-amber-600 text-[9px] font-medium">{edctSourceTag(edctAlert)}</span>
                                </div>
                              )}
                              {showFaEst && (
                                <div className={`text-[10px] font-medium mt-0.5 ${faEstDiff > 15 ? "text-red-600" : "text-amber-600"}`}>
                                  FA Est: {fmt(fi!.departure_time!, f.departure_icao)}
                                </div>
                              )}
                            </>
                          );
                        })() : null}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600">
                        <div>{fmt(f.scheduled_arrival, f.arrival_icao)}</div>
                        {!isCancelled && (fi?.actual_arrival ?? (!swimEntryStale ? swimEntry?.actual_arrival : null)) && f.scheduled_arrival ? (
                          <div className={`text-[10px] font-medium mt-0.5 ${delayColorClass(f.scheduled_arrival, (fi?.actual_arrival ?? swimEntry?.actual_arrival)!)}`}>
                            Actual: {fmt((fi?.actual_arrival ?? swimEntry?.actual_arrival)!, f.arrival_icao)}
                          </div>
                        ) : !isCancelled && fiRouteMatch && fi?.arrival_time && (fi?.actual_departure || fi?.departure_time) && !fi?.actual_arrival ? (
                          <div className="text-[10px] text-blue-600 font-medium mt-0.5">
                            ETA: {fmt(
                              f.scheduled_arrival && new Date(fi.arrival_time).getTime() < new Date(f.scheduled_arrival).getTime()
                                ? f.scheduled_arrival : fi.arrival_time,
                              f.arrival_icao,
                            )}
                          </div>
                        ) : !isCancelled && status === "En Route" && !swimRouteStale && swimRouteMatch?.eta ? (
                          <div className="text-[10px] text-blue-600 font-medium mt-0.5">
                            ETA: {fmt(swimRouteMatch.eta, f.arrival_icao)}
                          </div>
                        ) : !isCancelled && status === "En Route" && f.scheduled_arrival && f.scheduled_departure ? (() => {
                          // Fallback ETA: scheduled arrival shifted by actual departure delay
                          const actualDep = fi?.actual_departure ?? (!swimEntryStale ? swimEntry?.actual_departure : null);
                          const delayMs = actualDep ? new Date(actualDep).getTime() - new Date(f.scheduled_departure).getTime() : 0;
                          const fallbackEta = new Date(new Date(f.scheduled_arrival).getTime() + delayMs).toISOString();
                          return (
                            <div className="text-[10px] text-blue-600 font-medium mt-0.5">
                              ETA: {fmt(fallbackEta, f.arrival_icao)}
                            </div>
                          );
                        })() : (() => {
                          const edctAlert = getActiveEdct(f);
                          if (!edctAlert || !f.scheduled_arrival || isCancelled) return null;
                          const deltaMs = new Date(edctAlert.edct_time!).getTime() - new Date(f.scheduled_departure).getTime();
                          const edctEtaIso = new Date(new Date(f.scheduled_arrival).getTime() + deltaMs).toISOString();
                          return (
                            <div className="text-[10px] font-medium mt-0.5 text-amber-700">
                              EDCT ETA: {fmtEdctTime(edctEtaIso, f.scheduled_departure, f.arrival_icao)}
                            </div>
                          );
                        })()}
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
                          const edctDuty = f.tail_number && tailDutyEdct ? tailDutyEdct.get(f.tail_number) : null;
                          const edctDiffers = edctDuty && Math.abs(edctDuty.flightTimeMin - duty.flightTimeMin) > 5;
                          return (
                            <div className="flex flex-col gap-0.5">
                              <button
                                onClick={() => onSwitchToDuty?.(f.tail_number ?? undefined)}
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono font-medium rounded cursor-pointer hover:opacity-80 transition-opacity ${LEVEL_COLORS[level]}`}
                                title="View detailed 10/24 breakdown"
                              >
                                <span className="text-[10px]">{LEVEL_ICONS[level]}</span>
                                {fmtHM(duty.flightTimeMin)}
                              </button>
                              {edctDiffers && (() => {
                                const el = dutyLevel(edctDuty.flightTimeMin);
                                return (
                                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded ${LEVEL_COLORS[el]}`}>
                                    <span className="text-[10px]">{LEVEL_ICONS[el]}</span>
                                    {fmtHM(edctDuty.flightTimeMin)} <span className="text-[9px] opacity-70">(EDCT)</span>
                                  </span>
                                );
                              })()}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5">
                        {(() => {
                          const duty = f.tail_number ? tailDuty.get(f.tail_number) : null;
                          if (!duty || duty.restMin == null) return <span className="text-xs text-gray-300">--</span>;
                          const level = restLevel(duty.restMin);
                          if (!level) return <span className="text-xs text-gray-300">--</span>;
                          const edctDuty = f.tail_number && tailDutyEdct ? tailDutyEdct.get(f.tail_number) : null;
                          // EDCT rest: only show when shorter
                          const edctDiffers = edctDuty && edctDuty.restMin != null && duty.restMin != null
                            && duty.restMin - edctDuty.restMin > 5;
                          return (
                            <div className="flex flex-col gap-0.5">
                              <button
                                onClick={() => onSwitchToDuty?.(f.tail_number ?? undefined)}
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono font-medium rounded cursor-pointer hover:opacity-80 transition-opacity ${LEVEL_COLORS[level]}`}
                                title="View detailed crew rest breakdown"
                              >
                                <span className="text-[10px]">{LEVEL_ICONS[level]}</span>
                                {fmtHM(duty.restMin)}
                              </button>
                              {edctDiffers && (() => {
                                const el = restLevel(edctDuty.restMin!);
                                if (!el) return null;
                                return (
                                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded ${LEVEL_COLORS[el]}`}>
                                    <span className="text-[10px]">{LEVEL_ICONS[el]}</span>
                                    {fmtHM(edctDuty.restMin!)} <span className="text-[9px] opacity-70">(EDCT)</span>
                                  </span>
                                );
                              })()}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
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
                          {isExpanded && alerts.some((a) => !isAcked(a)) && (
                            <button
                              type="button"
                              onClick={() => handleAckAll(f.id, alerts.filter((a) => !isAcked(a)).map((a) => a.id))}
                              className="text-[10px] text-gray-500 hover:text-green-700 hover:bg-green-50 border border-gray-200 hover:border-green-300 rounded px-1.5 py-0.5 transition-colors whitespace-nowrap"
                            >
                              Ack All
                            </button>
                          )}
                        </div>
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
                      <td className="px-2 py-2.5">
                        {editingRemarkId === f.id ? (
                          <input
                            type="text"
                            autoFocus
                            className="w-full text-xs border border-blue-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
                            maxLength={500}
                            value={remarkDraft}
                            onChange={(e) => setRemarkDraft(e.target.value)}
                            onBlur={() => saveRemark(f.id, remarkDraft)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); saveRemark(f.id, remarkDraft); }
                              if (e.key === "Escape") setEditingRemarkId(null);
                            }}
                          />
                        ) : (
                          <div
                            className="text-xs text-gray-600 cursor-pointer hover:bg-gray-100 rounded px-1.5 py-1 min-h-[24px] truncate"
                            title={remarks.get(f.id)?.remark ?? "Click to add remark"}
                            onClick={() => { setEditingRemarkId(f.id); setRemarkDraft(remarks.get(f.id)?.remark ?? ""); }}
                          >
                            {remarks.get(f.id)?.remark || <span className="text-gray-300 italic">—</span>}
                          </div>
                        )}
                      </td>
                    </tr>
                    {isExpanded && alerts.map((alert) => (
                      <tr key={alert.id} className={`border-t border-dashed border-gray-100 ${isAcked(alert) ? "bg-gray-50/40 opacity-60" : "bg-red-50/40"}`}>
                        <td colSpan={11} className="px-4 py-3">
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
