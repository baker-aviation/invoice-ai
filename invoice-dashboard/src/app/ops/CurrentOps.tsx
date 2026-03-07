"use client";

import dynamic from "next/dynamic";
import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import type { Flight, OpsAlert } from "@/lib/opsApi";
import type { AdsbAircraft, FlightInfoMap } from "@/app/maintenance/MapView";
import { fmtTimeInTz } from "@/lib/airportTimezones";
import { getAirportInfo } from "@/lib/airportCoords";
import { TRIPS } from "@/lib/maintenanceData";

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

type TimeRange = "Today" | "Tomorrow" | "Week" | "Month";

function getTimeRange(range: TimeRange): { start: Date; end: Date } {
  // Use local (browser) date boundaries so "Today" = local calendar day
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart.getTime() + 86400000);
  const dayAfterTomorrow = new Date(todayStart.getTime() + 2 * 86400000);

  switch (range) {
    case "Today":
      return { start: todayStart, end: tomorrowStart };
    case "Tomorrow":
      return { start: tomorrowStart, end: dayAfterTomorrow };
    case "Week":
      return { start: todayStart, end: new Date(todayStart.getTime() + 7 * 86400000) };
    case "Month":
      return { start: todayStart, end: new Date(todayStart.getTime() + 30 * 86400000) };
  }
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
const MIN_REST_GAP_MS = 6 * 60 * 60 * 1000;

type TailDutySummary = {
  flightTimeMin: number;
  restMin: number | null;
};

/** Compute per-tail 24hr flight time and crew rest from flights + FA data */
function computeTailDuty(
  flights: Flight[],
  faMap: Map<string, FlightInfoMap>,
): Map<string, TailDutySummary> {
  const nowMs = Date.now();
  const WINDOW_MS = 24 * 60 * 60 * 1000;

  // Build intervals per tail (only duty-relevant flight types)
  const tailIntervals = new Map<string, { startMs: number; endMs: number }[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    const ft = (f.flight_type ?? "").toLowerCase();
    if (ft && !DUTY_FLIGHT_TYPES.has(ft)) continue;

    const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
    const fi = faMap.get(routeKey);

    const actualDep = fi?.actual_departure ?? null;
    const actualArr = fi?.actual_arrival ?? null;
    const estimatedArr = fi?.arrival_time ?? null;

    const depMs = new Date(actualDep ?? f.scheduled_departure).getTime();
    let endMs: number;
    if (actualArr) {
      endMs = new Date(actualArr).getTime();
    } else if (actualDep && !actualArr) {
      endMs = estimatedArr ? new Date(estimatedArr).getTime() : nowMs;
    } else if (estimatedArr) {
      endMs = new Date(estimatedArr).getTime();
    } else {
      endMs = f.scheduled_arrival ? new Date(f.scheduled_arrival).getTime() : depMs;
    }

    let durMin = (endMs - depMs) / 60_000;
    if (durMin < 0) durMin = 0;
    if (durMin > MAX_LEG_DURATION_MIN) durMin = MAX_LEG_DURATION_MIN;
    endMs = depMs + durMin * 60_000;
    if (durMin <= 0) continue;

    if (!tailIntervals.has(f.tail_number)) tailIntervals.set(f.tail_number, []);
    tailIntervals.get(f.tail_number)!.push({ startMs: depMs, endMs });
  }

  const result = new Map<string, TailDutySummary>();

  for (const [tail, intervals] of tailIntervals) {
    intervals.sort((a, b) => a.startMs - b.startMs);

    // --- Rolling 24hr flight time (Part 135.267: ANY 24 consecutive hours) ---
    const checkPoints = new Set<number>();
    for (const leg of intervals) {
      checkPoints.add(leg.startMs);
      checkPoints.add(leg.endMs);
      checkPoints.add(leg.startMs + WINDOW_MS);
      checkPoints.add(leg.endMs + WINDOW_MS);
    }

    let maxMs = 0;
    for (const windowEnd of checkPoints) {
      const windowStart = windowEnd - WINDOW_MS;
      let totalMs = 0;
      for (const leg of intervals) {
        const os = Math.max(leg.startMs, windowStart);
        const oe = Math.min(leg.endMs, windowEnd);
        if (oe > os) totalMs += oe - os;
      }
      if (totalMs > maxMs) maxMs = totalMs;
    }

    // --- Crew rest ---
    let restMin: number | null = null;
    for (let i = 0; i < intervals.length - 1; i++) {
      const gapMs = intervals[i + 1].startMs - intervals[i].endMs;
      if (gapMs < MIN_REST_GAP_MS) continue;
      if (intervals[i + 1].startMs > nowMs) {
        restMin = gapMs / 60_000;
        break;
      }
    }
    // Fallback
    if (restMin == null) {
      const pastLegs = intervals.filter((l) => l.endMs <= nowMs);
      const futureLeg = intervals.find((l) => l.startMs > nowMs);
      if (pastLegs.length > 0 && futureLeg) {
        const gap = futureLeg.startMs - pastLegs[pastLegs.length - 1].endMs;
        if (gap >= MIN_REST_GAP_MS) restMin = gap / 60_000;
      }
    }

    result.set(tail, { flightTimeMin: maxMs / 60_000, restMin });
  }

  return result;
}

// Part 135.267(b)(2): 10h limit for two-pilot crew
function dutyColor(flightTimeMin: number): string {
  if (flightTimeMin >= 600) return "text-red-700 bg-red-50"; // >= 10h — exceeded
  if (flightTimeMin >= 540) return "text-amber-700 bg-amber-50"; // >= 9h (within 1h)
  return "text-green-700 bg-green-50";
}

function restColor(restMin: number | null): string {
  if (restMin == null) return "text-gray-400";
  if (restMin < 10 * 60) return "text-red-700 bg-red-50"; // < 10h required min
  if (restMin < 11 * 60) return "text-amber-700 bg-amber-50"; // < 11h (within 1h)
  return "text-green-700 bg-green-50";
}

/** Delay color: early/≤15m green, 15-45m amber, >45m red */
function delayColorClass(scheduledIso: string, actualIso: string): string {
  const delayMin = (new Date(actualIso).getTime() - new Date(scheduledIso).getTime()) / 60_000;
  if (delayMin > 45) return "text-red-600";
  if (delayMin > 15) return "text-amber-600";
  return "text-green-600";
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

export default function CurrentOps({ flights }: { flights: Flight[] }) {
  const [adsbAircraft, setAdsbAircraft] = useState<AdsbAircraft[]>([]);
  const [flightInfo, setFlightInfo] = useState<Map<string, FlightInfoMap>>(new Map());
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(DEFAULT_TYPES);
  const [timeRange, setTimeRange] = useState<TimeRange>("Today");
  const [expandedFlights, setExpandedFlights] = useState<Set<string>>(new Set());
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [useUtc, setUseUtc] = useState(false);
  const [showActual, setShowActual] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "aircraft">("table");

  // Shorthand for formatting times — uses departure or arrival airport TZ
  const fmt = useCallback(
    (iso: string | null | undefined, icao?: string | null) =>
      fmtTimeInTz(iso, icao, !useUtc),
    [useUtc],
  );

  // Fetch FlightAware data (primary source for both positions and flight info)
  const fetchFlightInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/flights", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        // Key by tail|origin|dest so each scheduled leg can find its FA match
        const map = new Map<string, FlightInfoMap>();
        const positions: AdsbAircraft[] = [];
        for (const fi of data.flights ?? []) {
          const key = `${fi.tail}|${fi.origin_icao ?? ""}|${fi.destination_icao ?? ""}`;
          map.set(key, fi);
          // Also store by tail-only for fallback
          if (!map.has(fi.tail) || (fi.latitude != null && fi.longitude != null)) {
            map.set(fi.tail, fi);
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
        setFlightInfo(map);
        setAdsbAircraft(positions);
        setLastUpdate(new Date());
      }
    } catch { /* ignore */ }
  }, []);

  // Poll every 60 seconds
  useEffect(() => {
    fetchFlightInfo();
    const interval = setInterval(fetchFlightInfo, 60_000);
    return () => clearInterval(interval);
  }, [fetchFlightInfo]);

  // Get all unique flight types
  const allTypes = useMemo(() => {
    const types = new Set<string>();
    for (const f of flights) {
      if (f.flight_type) types.add(f.flight_type);
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
        if (!visibleTypes.has(type)) return false;
        const dep = new Date(f.scheduled_departure);
        if (dep < start || dep >= end) return false;
        // Deduplicate: same tail + route + departure time = same leg
        const dedupKey = `${f.tail_number}|${f.departure_icao}|${f.arrival_icao}|${f.scheduled_departure}`;
        if (seen.has(dedupKey)) return false;
        seen.add(dedupKey);
        return true;
      })
      .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
  }, [flights, visibleTypes, timeRange]);

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

  // Group filtered flights by fleet type → tail for aircraft card view
  const flightsByFleetType = useMemo(() => {
    // First group by tail
    const byTail = new Map<string, Flight[]>();
    for (const f of filteredFlights) {
      const tail = f.tail_number || "Unassigned";
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
  }, [filteredFlights, tailFleetType]);

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
    const flyingTails = new Set(adsbAircraft.map((a) => a.tail));
    const now = new Date();
    const parked: AdsbAircraft[] = [];
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
  }, [flights, adsbAircraft]);

  // Combine flying + parked for the map
  const allMapAircraft = useMemo(() => [...adsbAircraft, ...parkedAircraft], [adsbAircraft, parkedAircraft]);

  // Per-tail duty summary (24hr flight time + crew rest)
  const tailDuty = useMemo(() => computeTailDuty(flights, flightInfo), [flights, flightInfo]);

  // Count airborne vs on-ground
  const airborne = adsbAircraft.length;
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
        // Only show EDCTs for today's flights
        const dep = new Date(a.edct_time ?? a.original_departure_time ?? f.scheduled_departure);
        if (dep < todayStart || dep >= tomorrowStart) continue;
        const route = [f.departure_icao, f.arrival_icao].filter(Boolean).join(" → ") || "Unknown";
        alerts.push({ ...a, route, fallback_departure: f.scheduled_departure ?? undefined });
      }
    }
    return alerts;
  }, [flights]);

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
          <span className="text-gray-400">{filteredFlights.length} flights scheduled</span>
        </div>
        {lastUpdate && (
          <span className="ml-auto text-xs text-gray-400">
            Updated {lastUpdate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        )}
      </div>

      {/* ── EDCT Status ── */}
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
              <div key={a.id} className="flex items-center gap-3 text-sm text-amber-900">
                <span className="font-medium">{a.route}</span>
                {a.tail_number && <span className="text-amber-600">{a.tail_number}</span>}
                <span className="text-sm">
                  {(a.original_departure_time || a.fallback_departure) && (
                    <span className="text-amber-500 line-through">{fmt(a.original_departure_time ?? a.fallback_departure ?? "", a.airport_icao)}</span>
                  )}
                  {(a.original_departure_time || a.fallback_departure) && <span className="text-amber-400 mx-0.5">→</span>}
                  <span className="text-amber-800 font-bold">{a.edct_time ? fmt(a.edct_time, a.airport_icao) : "—"}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Map ── */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <OpsMap adsbAircraft={allMapAircraft} flightInfo={flightInfo} />
      </div>

      {/* ── Filters row ── */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Time range */}
        <div className="flex items-center gap-1">
          {(["Today", "Tomorrow", "Week", "Month"] as TimeRange[]).map((r) => (
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

        {/* Timezone toggle */}
        <button
          onClick={() => setUseUtc((v) => !v)}
          className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
            useUtc
              ? "bg-indigo-100 text-indigo-700"
              : "bg-gray-900 text-white"
          }`}
        >
          {useUtc ? "UTC / Zulu" : "Local Time"}
        </button>

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
                        <span className="font-mono font-bold text-gray-900">{tail}</span>
                        <div className="flex items-center gap-2">
                          {duty && (
                            <>
                              <span className={`px-1.5 py-0.5 text-[10px] font-mono font-medium rounded ${dutyColor(duty.flightTimeMin)}`} title="24hr flight time">
                                {fmtHM(duty.flightTimeMin)}
                              </span>
                              {duty.restMin != null && (
                                <span className={`px-1.5 py-0.5 text-[10px] font-mono font-medium rounded ${restColor(duty.restMin)}`} title="Crew rest">
                                  R:{fmtHM(duty.restMin)}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {tailFlights.map((f) => {
                          const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
                          const fi = f.tail_number ? (flightInfo.get(routeKey) ?? undefined) : undefined;
                          const type = f.flight_type || "Other";
                          const typeColor = FLIGHT_TYPE_COLORS[type] || "bg-gray-100 text-gray-700";

                          let status = "Scheduled";
                          let statusColor = "text-gray-500";
                          const arrivalDate = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
                          const now = new Date();
                          const arrivalPassed = arrivalDate && arrivalDate < now;
                          if (fi?.status) {
                            status = fi.status;
                            if (fi.status.includes("En Route")) statusColor = "text-blue-600 font-medium";
                            if (fi.status.includes("Arrived") || fi.status.includes("Landed")) statusColor = "text-green-600 font-medium";
                          } else if (fi?.actual_arrival) {
                            status = "Arrived";
                            statusColor = "text-green-600 font-medium";
                          } else if (arrivalPassed && !fi) {
                            status = "Arrived";
                            statusColor = "text-green-600 font-medium";
                          }
                          if (fi?.diverted) { status = "DIVERTED"; statusColor = "text-red-600 font-bold"; }

                          const actualDepIso = fi?.actual_departure ?? null;
                          const actualArrIso = fi?.actual_arrival ?? null;

                          return (
                            <div key={f.id} className="px-4 py-2 text-xs">
                              <div className="flex items-center gap-3">
                                <span className="font-mono font-medium text-gray-800 w-28 shrink-0">
                                  {f.departure_icao || "?"} → {f.arrival_icao || "?"}
                                </span>
                                <div className="w-36 shrink-0">
                                  <div className="text-gray-500">
                                    {fmt(f.scheduled_departure, f.departure_icao)}
                                  </div>
                                  {actualDepIso && (
                                    <div className={`text-[10px] font-medium ${delayColorClass(f.scheduled_departure, actualDepIso)}`}>
                                      Actual: {fmt(actualDepIso, f.departure_icao)}
                                    </div>
                                  )}
                                </div>
                                <div className="w-36 shrink-0">
                                  <div className="text-gray-500">
                                    {fmt(f.scheduled_arrival, f.arrival_icao)}
                                  </div>
                                  {actualArrIso && f.scheduled_arrival ? (
                                    <div className={`text-[10px] font-medium ${delayColorClass(f.scheduled_arrival, actualArrIso)}`}>
                                      Actual: {fmt(actualArrIso, f.arrival_icao)}
                                    </div>
                                  ) : fi?.arrival_time && !actualArrIso ? (
                                    <div className="text-[10px] text-blue-600 font-medium">
                                      ETA: {fmt(fi.arrival_time, f.arrival_icao)}
                                    </div>
                                  ) : null}
                                </div>
                                <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${typeColor}`}>
                                  {type}
                                </span>
                                <span className={`text-xs ${statusColor}`}>{status}</span>
                                {fi?.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100 && (
                                  <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                    <div className="h-full bg-blue-500 rounded-full" style={{ width: `${fi.progress_percent}%` }} />
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
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
          <thead>
            <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Tail</th>
              <th className="px-4 py-3">Route</th>
              <th className="px-4 py-3">Departure</th>
              <th className="px-4 py-3">Arrival</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3">24hr Flight</th>
              <th className="px-4 py-3">Crew Rest</th>
            </tr>
          </thead>
          <tbody>
            {filteredFlights.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                  No flights scheduled for selected filters
                </td>
              </tr>
            ) : (
              filteredFlights.map((f) => {
                const adsb = adsbAircraft.find((a) => a.tail === f.tail_number);
                // Look up FlightAware info by route-specific key first, then fall back to tail-only
                const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
                const fi = f.tail_number
                  ? (flightInfo.get(routeKey) ?? undefined)
                  : undefined;
                const alerts = f.alerts ?? [];
                const alertCount = alerts.length;
                const type = f.flight_type || "Other";
                const typeColor = FLIGHT_TYPE_COLORS[type] || "bg-gray-100 text-gray-700";
                const isExpanded = expandedFlights.has(f.id);

                // Determine status
                let status = "Scheduled";
                let statusColor = "text-gray-500";

                const arrivalDate = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
                const now = new Date();
                const arrivalPassed = arrivalDate && arrivalDate < now;

                if (fi?.status) {
                  // FlightAware matched this leg — trust its status (handles delays)
                  status = fi.status;
                  if (fi.status.includes("En Route")) statusColor = "text-blue-600 font-medium";
                  if (fi.status.includes("Arrived") || fi.status.includes("Landed")) statusColor = "text-green-600 font-medium";
                } else if (fi && !fi.actual_arrival && fi.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100) {
                  // FA matched, no explicit status but in progress
                  status = "En Route";
                  statusColor = "text-blue-600 font-medium";
                } else if (fi?.actual_arrival) {
                  // FA says landed
                  status = "Arrived";
                  statusColor = "text-green-600 font-medium";
                } else if (arrivalPassed && !fi) {
                  // No FA data, but scheduled arrival is past — assume arrived
                  status = "Arrived";
                  statusColor = "text-green-600 font-medium";
                }

                if (fi?.diverted) {
                  status = "DIVERTED";
                  statusColor = "text-red-600 font-bold";
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
                      className="border-t hover:bg-gray-50"
                    >
                      <td className="px-4 py-2.5 font-mono font-semibold text-gray-900">
                        {f.tail_number || "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono font-medium">
                          {f.departure_icao || "?"} → {f.arrival_icao || "?"}
                        </span>
                        {fi?.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100 && (
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
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">
                        <div>{fmt(f.scheduled_departure, f.departure_icao)}</div>
                        {fi?.actual_departure && (
                          <div className={`text-[10px] font-medium mt-0.5 ${delayColorClass(f.scheduled_departure, fi.actual_departure)}`}>
                            Actual: {fmt(fi.actual_departure, f.departure_icao)}
                          </div>
                        )}
                        {!fi?.actual_departure && depMismatchMin !== null && fi?.departure_time && (
                          <div className="mt-0.5 text-[10px] font-semibold text-amber-700">
                            FA Est: {fmt(fi.departure_time, f.departure_icao)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">
                        <div>{fmt(f.scheduled_arrival, f.arrival_icao)}</div>
                        {fi?.actual_arrival && f.scheduled_arrival ? (
                          <div className={`text-[10px] font-medium mt-0.5 ${delayColorClass(f.scheduled_arrival, fi.actual_arrival)}`}>
                            Actual: {fmt(fi.actual_arrival, f.arrival_icao)}
                          </div>
                        ) : fi?.arrival_time && !fi?.actual_arrival && status !== "Arrived" ? (
                          <div className="text-[10px] text-blue-600 font-medium mt-0.5">
                            ETA: {fmt(fi.arrival_time, f.arrival_icao)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${typeColor}`}>
                          {type}
                        </span>
                      </td>
                      <td className={`px-4 py-2.5 text-xs ${statusColor}`}>
                        {status}
                      </td>
                      <td className="px-4 py-2.5">
                        {alertCount > 0 && (
                          <button
                            onClick={() => toggleExpanded(f.id)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200 transition-colors cursor-pointer"
                          >
                            <span className={`inline-block transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                              &#9656;
                            </span>
                            {alertCount} alert{alertCount > 1 ? "s" : ""}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {(() => {
                          const duty = f.tail_number ? tailDuty.get(f.tail_number) : null;
                          if (!duty) return <span className="text-xs text-gray-300">--</span>;
                          return (
                            <span className={`inline-block px-1.5 py-0.5 text-xs font-mono font-medium rounded ${dutyColor(duty.flightTimeMin)}`}>
                              {fmtHM(duty.flightTimeMin)}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-2.5">
                        {(() => {
                          const duty = f.tail_number ? tailDuty.get(f.tail_number) : null;
                          if (!duty || duty.restMin == null) return <span className="text-xs text-gray-300">--</span>;
                          return (
                            <span className={`inline-block px-1.5 py-0.5 text-xs font-mono font-medium rounded ${restColor(duty.restMin)}`}>
                              {fmtHM(duty.restMin)}
                            </span>
                          );
                        })()}
                      </td>
                    </tr>
                    {isExpanded && alerts.map((alert) => (
                      <tr key={alert.id} className="border-t border-dashed border-gray-100 bg-red-50/40">
                        <td colSpan={9} className="px-4 py-3">
                          <div className={`rounded-lg border p-3 text-xs ${SEVERITY_COLORS[alert.severity] || "bg-gray-50 text-gray-700 border-gray-200"}`}>
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
                              <span className="text-[10px] opacity-50 whitespace-nowrap shrink-0">
                                {fmt(alert.created_at)}
                              </span>
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
