"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  ReferenceLine,
  Tooltip,
} from "recharts";
import type { Flight } from "@/lib/opsApi";
import type { FlightInfoMap } from "@/app/maintenance/MapView";
import { fmtTimeInTz } from "@/lib/airportTimezones";

/* ── Constants ──────────────────────────────────────── */

const POLL_INTERVAL_MS = 60_000;
const MAX_DUTY_HOURS_SCALE = 10; // progress bar scale (hours)
// Part 135.267(b)(2): 10h limit for two-pilot crew in any 24 consecutive hours
const FLIGHT_TIME_RED_MIN = 600; // 10 hours — hard limit
const FLIGHT_TIME_YELLOW_MIN = 540; // 9 hours — caution (within 1hr of limit)
const REST_RED_HOURS = 10; // minimum required rest
const REST_YELLOW_HOURS = 11; // within 1hr of minimum
const MAX_LEG_DURATION_MIN = 12 * 60; // cap any single leg at 12h (sanity)
const MIN_REST_GAP_MS = 6 * 60 * 60 * 1000; // 6h minimum for crew rest
const LEAD_TIME_MIN = 60; // duty starts 60min before first leg
const POST_TIME_MIN = 30; // duty ends 30min after last leg
const LEAD_POST_TOTAL_MS = (LEAD_TIME_MIN + POST_TIME_MIN) * 60_000;

// Only include revenue/charter and positioning legs for duty tracking
const DUTY_FLIGHT_TYPES = new Set(["revenue", "owner", "positioning", "ferry", "charter"]);

/* ── Types ──────────────────────────────────────────── */

type LegInterval = {
  departure_icao: string | null;
  arrival_icao: string | null;
  startMs: number;
  endMs: number;
  durationMin: number;
  source: "actual" | "fa-estimate" | "scheduled";
  depIso: string;   // departure time used (actual or scheduled)
  arrIso: string;   // arrival time used (actual, estimate, or scheduled)
};

type WindowLeg = LegInterval & {
  overlapMin: number;
  runningTotalMin: number;
  breachesAt?: number;
};

type ChartPoint = { timeMs: number; hours: number };

type TailFlightTime = {
  tail: string;
  maxRolling24hrMin: number;
  windowLegs: WindowLeg[];
  suggestion: string | null;
  // Duty period summary for all legs in the rolling window
  dutyOnMs: number | null;
  dutyOffMs: number | null;
  dutyMinutes: number | null;
  totalFlightMinutes: number; // sum of all block times (not just overlap)
  chartPoints: ChartPoint[];
};

type TailCrewRest = {
  tail: string;
  lastLanding: string | null;
  lastLandingIcao: string | null;
  lastLandingSource: "actual" | "fa-estimate" | "scheduled";
  nextDeparture: string | null;
  nextDepartureIcao: string | null;
  nextDepartureSource: "actual" | "fa-estimate" | "scheduled";
  restMinutes: number | null;
  // Duty period fields (with lead/post applied)
  dutyOnMs: number | null;   // first leg departure - lead time
  dutyOffMs: number | null;  // last leg arrival + post time
  dutyMinutes: number | null; // dutyOff - dutyOn
  flightMinutes: number | null; // sum of actual block times in duty period before rest
  restStartMs: number | null; // dutyOff (last landing + post)
  restStopMs: number | null;  // dutyOn of next period (next departure - lead)
};

type DelayAlert = {
  tail: string;
  type: "rest" | "flight-time";
  message: string;
  severity: "red" | "amber";
};

type SubTab = "today" | "future";

/* ── Helpers ──────────────────────────────────────────── */

function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function sourceLabel(src: "actual" | "fa-estimate" | "scheduled"): string {
  if (src === "actual") return "Actual";
  if (src === "fa-estimate") return "FA Est";
  return "Sched";
}

function sourceBadgeClass(src: "actual" | "fa-estimate" | "scheduled"): string {
  if (src === "actual") return "bg-green-100 text-green-700";
  if (src === "fa-estimate") return "bg-blue-100 text-blue-700";
  return "bg-gray-100 text-gray-500";
}

function findWorstWindow(
  legs: LegInterval[],
): { maxMin: number; windowEndMs: number } {
  if (legs.length === 0) return { maxMin: 0, windowEndMs: Date.now() };

  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const checkPoints = new Set<number>();
  for (const leg of legs) {
    checkPoints.add(leg.startMs);
    checkPoints.add(leg.endMs);
    checkPoints.add(leg.startMs + WINDOW_MS);
    checkPoints.add(leg.endMs + WINDOW_MS);
  }

  let maxTotalMs = 0;
  let bestEnd = legs[0].endMs;

  for (const windowEnd of checkPoints) {
    const windowStart = windowEnd - WINDOW_MS;
    let totalMs = 0;
    for (const leg of legs) {
      const os = Math.max(leg.startMs, windowStart);
      const oe = Math.min(leg.endMs, windowEnd);
      if (oe > os) totalMs += oe - os;
    }
    if (totalMs > maxTotalMs) {
      maxTotalMs = totalMs;
      bestEnd = windowEnd;
    }
  }

  return { maxMin: maxTotalMs / 60_000, windowEndMs: bestEnd };
}

/** Build rolling-24h chart points for a set of legs.
 *  Steps every 15 min from first departure to 24h past last arrival (or until decay hits 0). */
function buildRolling24Chart(legs: LegInterval[]): ChartPoint[] {
  if (legs.length === 0) return [];
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const STEP_MS = 15 * 60 * 1000;

  const minMs = Math.min(...legs.map((l) => l.startMs));
  const maxMs = Math.max(...legs.map((l) => l.endMs));
  const scanEnd = maxMs + WINDOW_MS;

  const points: ChartPoint[] = [];
  let t = minMs;
  while (t <= scanEnd) {
    const wStart = t - WINDOW_MS;
    let totalMs = 0;
    for (const leg of legs) {
      const os = Math.max(leg.startMs, wStart);
      const oe = Math.min(leg.endMs, t);
      if (oe > os) totalMs += oe - os;
    }
    const hours = totalMs / 3_600_000;
    points.push({ timeMs: t, hours });
    if (t > maxMs && hours < 0.01) break; // stop once fully decayed
    t += STEP_MS;
  }
  return points;
}

/** Check if a rest gap's next departure falls within today+tomorrow (local time) */
function isWithin48h(ms: number): boolean {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoff = todayStart.getTime() + 2 * 86400000;
  return ms < cutoff;
}

/** Check if the worst window overlaps today+tomorrow (local time) */
function windowOverlaps48h(windowEndMs: number): boolean {
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoff = todayStart.getTime() + 2 * 86400000;
  const windowStartMs = windowEndMs - WINDOW_MS;
  return windowStartMs < cutoff && windowEndMs > todayStart.getTime();
}

/* ── Component ──────────────────────────────────────── */

export default function DutyTracker({ flights }: { flights: Flight[] }) {
  const [faData, setFaData] = useState<FlightInfoMap[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [useUtc, setUseUtc] = useState(false);
  const [subTab, setSubTab] = useState<SubTab>("today");

  const fmt = useCallback(
    (iso: string | null | undefined, icao?: string | null) =>
      fmtTimeInTz(iso, icao, !useUtc),
    [useUtc],
  );

  const fetchFaData = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/flights", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setFaData(data.flights ?? []);
        setLastUpdate(new Date());
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchFaData();
    const interval = setInterval(fetchFaData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchFaData]);

  const faMap = useMemo(() => {
    const map = new Map<string, FlightInfoMap>();
    for (const fi of faData) {
      const key = `${fi.tail}|${fi.origin_icao ?? ""}|${fi.destination_icao ?? ""}`;
      map.set(key, fi);
    }
    return map;
  }, [faData]);

  /* ── Build leg intervals per tail ── */
  const intervalsByTail = useMemo(() => {
    const result = new Map<string, LegInterval[]>();
    const now = Date.now();

    for (const f of flights) {
      if (!f.tail_number) continue;
      const ft = (f.flight_type ?? "").toLowerCase();
      if (ft && !DUTY_FLIGHT_TYPES.has(ft)) continue;

      const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
      const fi = faMap.get(routeKey);

      const actualDep = fi?.actual_departure ?? null;
      const actualArr = fi?.actual_arrival ?? null;
      const estimatedArr = fi?.arrival_time ?? null;

      const depIso = actualDep ?? f.scheduled_departure;
      const depMs = new Date(depIso).getTime();

      let source: "actual" | "fa-estimate" | "scheduled";
      let endMs: number;

      if (actualArr) {
        source = "actual";
        endMs = new Date(actualArr).getTime();
      } else if (actualDep && !actualArr) {
        source = estimatedArr ? "fa-estimate" : "actual";
        endMs = estimatedArr ? new Date(estimatedArr).getTime() : now;
      } else if (estimatedArr) {
        source = "fa-estimate";
        endMs = new Date(estimatedArr).getTime();
      } else {
        source = "scheduled";
        endMs = f.scheduled_arrival ? new Date(f.scheduled_arrival).getTime() : depMs;
      }

      let durationMin = (endMs - depMs) / 60_000;
      if (durationMin < 0) durationMin = 0;
      if (durationMin > MAX_LEG_DURATION_MIN) durationMin = MAX_LEG_DURATION_MIN;
      endMs = depMs + durationMin * 60_000;

      if (durationMin <= 0) continue;

      const arrIso = new Date(endMs).toISOString();

      if (!result.has(f.tail_number)) result.set(f.tail_number, []);
      result.get(f.tail_number)!.push({
        departure_icao: f.departure_icao,
        arrival_icao: f.arrival_icao,
        startMs: depMs,
        endMs,
        durationMin,
        source,
        depIso,
        arrIso,
      });
    }

    for (const legs of result.values()) {
      legs.sort((a, b) => a.startMs - b.startMs);
    }
    return result;
  }, [flights, faMap]);

  /* ── Rolling 24hr flight time per tail ── */
  const flightTimeData = useMemo((): TailFlightTime[] => {
    const result: TailFlightTime[] = [];
    const WINDOW_MS = 24 * 60 * 60 * 1000;

    for (const [tail, legs] of intervalsByTail) {
      const validLegs = legs.filter((l) => l.durationMin > 0);
      const { maxMin, windowEndMs } = findWorstWindow(validLegs);
      const windowStartMs = windowEndMs - WINDOW_MS;

      const windowLegs: WindowLeg[] = [];
      let runningTotal = 0;
      let breachLegIdx = -1;

      for (const leg of validLegs) {
        const overlapStart = Math.max(leg.startMs, windowStartMs);
        const overlapEnd = Math.min(leg.endMs, windowEndMs);
        if (overlapEnd <= overlapStart) continue;

        const overlapMin = (overlapEnd - overlapStart) / 60_000;
        const prevTotal = runningTotal;
        runningTotal += overlapMin;

        const wl: WindowLeg = { ...leg, overlapMin, runningTotalMin: runningTotal };

        if (prevTotal < FLIGHT_TIME_YELLOW_MIN && runningTotal >= FLIGHT_TIME_YELLOW_MIN) {
          breachLegIdx = windowLegs.length;
          wl.breachesAt = FLIGHT_TIME_YELLOW_MIN;
        }
        if (prevTotal < FLIGHT_TIME_RED_MIN && runningTotal >= FLIGHT_TIME_RED_MIN) {
          breachLegIdx = windowLegs.length;
          wl.breachesAt = FLIGHT_TIME_RED_MIN;
        }

        windowLegs.push(wl);
      }

      let suggestion: string | null = null;
      if (breachLegIdx >= 0 && breachLegIdx + 1 < windowLegs.length) {
        const sl = windowLegs[breachLegIdx + 1];
        suggestion = `Consider sliding ${sl.departure_icao ?? "?"}-${sl.arrival_icao ?? "?"} to reduce 24hr total`;
      } else if (breachLegIdx >= 0) {
        const sl = windowLegs[breachLegIdx];
        suggestion = `Consider sliding ${sl.departure_icao ?? "?"}-${sl.arrival_icao ?? "?"} to reduce 24hr total`;
      }

      // Compute duty period stats for window legs
      let dutyOnMs: number | null = null;
      let dutyOffMs: number | null = null;
      let dutyMinutes: number | null = null;
      const totalFlightMinutes = windowLegs.reduce((sum, wl) => sum + wl.durationMin, 0);

      if (windowLegs.length > 0) {
        const firstDep = Math.min(...windowLegs.map((wl) => wl.startMs));
        const lastArr = Math.max(...windowLegs.map((wl) => wl.endMs));
        dutyOnMs = firstDep - LEAD_TIME_MIN * 60_000;
        dutyOffMs = lastArr + POST_TIME_MIN * 60_000;
        dutyMinutes = (dutyOffMs - dutyOnMs) / 60_000;
      }

      const chartPoints = buildRolling24Chart(validLegs);

      result.push({ tail, maxRolling24hrMin: maxMin, windowLegs, suggestion, dutyOnMs, dutyOffMs, dutyMinutes, totalFlightMinutes, chartPoints, _windowEndMs: windowEndMs } as TailFlightTime & { _windowEndMs: number });
    }

    result.sort((a, b) => b.maxRolling24hrMin - a.maxRolling24hrMin);
    return result;
  }, [intervalsByTail]);

  /* ── Crew rest per tail (find ALL rest gaps >= 6h) ── */
  const crewRestData = useMemo((): TailCrewRest[] => {
    const result: TailCrewRest[] = [];
    const now = Date.now();

    for (const [tail, legs] of intervalsByTail) {
      const sorted = [...legs].sort((a, b) => a.startMs - b.startMs);

      // Helper: build a rest entry from the gap between sorted[gapBeforeIdx] and sorted[gapBeforeIdx+1]
      // Also computes duty period stats for legs before the gap (same duty period)
      function buildRestEntry(beforeIdx: number, afterIdx: number): TailCrewRest {
        const lastLeg = sorted[beforeIdx];
        const nextLeg = sorted[afterIdx];

        // Duty period 1: all consecutive legs before the rest gap
        // Walk backwards from beforeIdx to find where this duty period starts
        let dpStartIdx = beforeIdx;
        for (let j = beforeIdx; j > 0; j--) {
          const prevGap = sorted[j].startMs - sorted[j - 1].endMs;
          if (prevGap >= MIN_REST_GAP_MS) break;
          dpStartIdx = j - 1;
        }

        const dpLegs = sorted.slice(dpStartIdx, beforeIdx + 1);
        const dpFirstDep = dpLegs[0].startMs;
        const dpLastArr = dpLegs[dpLegs.length - 1].endMs;
        const dutyOnMs = dpFirstDep - LEAD_TIME_MIN * 60_000;
        const dutyOffMs = dpLastArr + POST_TIME_MIN * 60_000;
        const dutyMinutes = (dutyOffMs - dutyOnMs) / 60_000;
        const flightMinutes = dpLegs.reduce((sum, l) => sum + l.durationMin, 0);

        // Rest: from duty off to next duty on
        const restStartMs = dutyOffMs;
        const restStopMs = nextLeg.startMs - LEAD_TIME_MIN * 60_000;
        const restMs = restStopMs - restStartMs;

        return {
          tail,
          lastLanding: new Date(lastLeg.endMs).toISOString(),
          lastLandingIcao: lastLeg.arrival_icao,
          lastLandingSource: lastLeg.source,
          nextDeparture: new Date(nextLeg.startMs).toISOString(),
          nextDepartureIcao: nextLeg.departure_icao,
          nextDepartureSource: nextLeg.source === "actual" ? "actual" : "scheduled",
          restMinutes: Math.max(0, restMs / 60_000),
          dutyOnMs,
          dutyOffMs,
          dutyMinutes,
          flightMinutes,
          restStartMs,
          restStopMs,
        };
      }

      // Find all gaps >= 6h, pick the active one (straddles now or first future)
      let best: TailCrewRest | null = null;

      for (let i = 0; i < sorted.length - 1; i++) {
        const gapMs = sorted[i + 1].startMs - sorted[i].endMs;
        if (gapMs < MIN_REST_GAP_MS) continue;
        if (sorted[i + 1].startMs > now) {
          best = buildRestEntry(i, i + 1);
          break;
        }
      }

      if (!best && sorted.length > 0) {
        const pastLegs = sorted.filter((l) => l.endMs <= now);
        const futureLeg = sorted.find((l) => l.startMs > now);
        if (pastLegs.length > 0 && futureLeg) {
          const lastPastIdx = sorted.indexOf(pastLegs[pastLegs.length - 1]);
          const futureIdx = sorted.indexOf(futureLeg);
          const gapMs = futureLeg.startMs - pastLegs[pastLegs.length - 1].endMs;
          if (gapMs >= MIN_REST_GAP_MS) {
            best = buildRestEntry(lastPastIdx, futureIdx);
          }
        }
      }

      result.push(best ?? {
        tail, lastLanding: null, lastLandingIcao: null, lastLandingSource: "scheduled",
        nextDeparture: null, nextDepartureIcao: null, nextDepartureSource: "scheduled",
        restMinutes: null,
        dutyOnMs: null, dutyOffMs: null, dutyMinutes: null, flightMinutes: null,
        restStartMs: null, restStopMs: null,
      });
    }

    result.sort((a, b) => {
      if (a.restMinutes == null && b.restMinutes == null) return 0;
      if (a.restMinutes == null) return 1;
      if (b.restMinutes == null) return -1;
      return a.restMinutes - b.restMinutes;
    });
    return result;
  }, [intervalsByTail]);

  /* ── Delay cascade alerts ── */
  const delayAlerts = useMemo((): DelayAlert[] => {
    const alerts: DelayAlert[] = [];
    const now = Date.now();

    for (const [tail, legs] of intervalsByTail) {
      const sorted = [...legs].sort((a, b) => a.startMs - b.startMs);

      // Find in-flight or recently departed legs that are delayed
      for (let i = 0; i < sorted.length; i++) {
        const leg = sorted[i];
        // Only check legs that have actual data and are delayed
        if (leg.source !== "actual" && leg.source !== "fa-estimate") continue;
        if (leg.endMs < now - 3600_000) continue; // skip legs that ended >1h ago

        // Check if delay on this leg cascades to violate rest for next gap
        // Rest = raw gap minus lead (60m) and post (30m) duty buffers
        if (i + 1 < sorted.length) {
          const nextLeg = sorted[i + 1];
          const gapMs = nextLeg.startMs - leg.endMs;
          const actualRestMs = gapMs - LEAD_POST_TOTAL_MS;
          const actualRestMin = actualRestMs / 60_000;
          // If there's a rest gap that is supposed to be >= 10h but will now be < 10h
          if (gapMs >= MIN_REST_GAP_MS && actualRestMin < REST_RED_HOURS * 60) {
            alerts.push({
              tail,
              type: "rest",
              severity: "red",
              message: `${tail}: Current delay reduces crew rest before ${nextLeg.departure_icao ?? "?"} departure to ${fmtDuration(Math.max(0, actualRestMin))} (min ${REST_RED_HOURS}h required, includes ${LEAD_TIME_MIN}m lead + ${POST_TIME_MIN}m post)`,
            });
          } else if (gapMs >= MIN_REST_GAP_MS && actualRestMin < REST_YELLOW_HOURS * 60) {
            alerts.push({
              tail,
              type: "rest",
              severity: "amber",
              message: `${tail}: Current timing leaves only ${fmtDuration(actualRestMin)} crew rest before ${nextLeg.departure_icao ?? "?"} departure`,
            });
          }
        }
      }

      // Check if current actual flight times push 24hr total near/over limit
      const validLegs = sorted.filter((l) => l.durationMin > 0);
      const { maxMin } = findWorstWindow(validLegs);
      const hasActualData = validLegs.some((l) => l.source === "actual" || l.source === "fa-estimate");
      if (hasActualData && maxMin >= FLIGHT_TIME_RED_MIN) {
        alerts.push({
          tail,
          type: "flight-time",
          severity: "red",
          message: `${tail}: 24hr flight time at ${fmtDuration(maxMin)} — exceeds 10h limit (Part 135.267)`,
        });
      } else if (hasActualData && maxMin >= FLIGHT_TIME_YELLOW_MIN) {
        alerts.push({
          tail,
          type: "flight-time",
          severity: "amber",
          message: `${tail}: 24hr flight time at ${fmtDuration(maxMin)} — approaching 10h limit`,
        });
      }
    }

    // Sort: red first, then amber
    alerts.sort((a, b) => (a.severity === "red" ? 0 : 1) - (b.severity === "red" ? 0 : 1));
    return alerts;
  }, [intervalsByTail]);

  /* ── Filter data by sub-tab ── */
  // "today" = show all tails (full picture for today & tomorrow)
  // "future" = only show tails with alerts/conflicts beyond 48h
  const filteredFlightTime = useMemo(() => {
    if (subTab === "today") return flightTimeData;
    return flightTimeData.filter((t) => {
      const entry = t as TailFlightTime & { _windowEndMs?: number };
      if (!entry._windowEndMs) return false;
      return !windowOverlaps48h(entry._windowEndMs) && t.maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN;
    });
  }, [flightTimeData, subTab]);

  const filteredCrewRest = useMemo(() => {
    if (subTab === "today") return crewRestData;
    return crewRestData.filter((t) => {
      if (!t.nextDeparture) return false;
      const depMs = new Date(t.nextDeparture).getTime();
      return !isWithin48h(depMs) && t.restMinutes != null && t.restMinutes < REST_YELLOW_HOURS * 60;
    });
  }, [crewRestData, subTab]);

  /* ── Alert counts ── */
  const flightTimeAlerts = flightTimeData.filter((t) => t.maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN).length;
  const restAlerts = crewRestData.filter((t) => t.restMinutes != null && t.restMinutes < REST_YELLOW_HOURS * 60).length;

  /* ── Time formatter helper ── */
  const fmtZulu = useCallback((ms: number) => {
    const d = new Date(ms);
    const hh = d.getUTCHours().toString().padStart(2, "0");
    const mm = d.getUTCMinutes().toString().padStart(2, "0");
    return `${hh}${mm}Z`;
  }, []);

  /* ── Render ────────────────────────────────────────── */
  return (
    <div className="space-y-6">
      {/* ── Header row ── */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-4">
          <span className="font-medium text-gray-700">
            {intervalsByTail.size} tail{intervalsByTail.size !== 1 ? "s" : ""} tracked
          </span>
          {flightTimeAlerts > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700">
              {flightTimeAlerts} duty alert{flightTimeAlerts !== 1 ? "s" : ""}
            </span>
          )}
          {restAlerts > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700">
              {restAlerts} rest alert{restAlerts !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* Sub-tab toggle */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setSubTab("today")}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                subTab === "today" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}
            >
              Today &amp; Tomorrow
            </button>
            <button
              onClick={() => setSubTab("future")}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                subTab === "future" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}
            >
              Future Conflicts
            </button>
          </div>

          <button
            onClick={() => setUseUtc((v) => !v)}
            className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
              useUtc ? "bg-indigo-100 text-indigo-700" : "bg-gray-900 text-white"
            }`}
          >
            {useUtc ? "UTC / Zulu" : "Local Time"}
          </button>
          {lastUpdate && (
            <span className="text-xs text-gray-400">
              Updated{" "}
              {lastUpdate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      {/* ── Delay Cascade Alerts ── */}
      {delayAlerts.length > 0 && (
        <div className="space-y-2">
          {delayAlerts.map((a, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 rounded-lg border px-4 py-2.5 text-sm ${
                a.severity === "red"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              }`}
            >
              <span className={`w-2 h-2 mt-1.5 rounded-full shrink-0 ${
                a.severity === "red" ? "bg-red-500" : "bg-amber-500"
              }`} />
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Section 1: Rolling 24hr Flight Time ── */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
          Rolling 24hr Flight Time
          <span className="ml-2 text-[10px] font-normal text-gray-400 normal-case">
            Part 135.267(b)(2) — 10h limit, two-pilot crew
          </span>
        </h3>
        {filteredFlightTime.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-8 text-center text-gray-400">
            {subTab === "today" ? "No duty concerns for today & tomorrow" : "No future conflicts found"}
          </div>
        ) : (
          <div className="space-y-4">
            {filteredFlightTime.map((t) => {
              const isRed = t.maxRolling24hrMin >= FLIGHT_TIME_RED_MIN;
              const isYellow = !isRed && t.maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN;
              const pct = Math.min((t.maxRolling24hrMin / (MAX_DUTY_HOURS_SCALE * 60)) * 100, 100);

              let barColor = "bg-blue-500";
              if (isRed) barColor = "bg-red-500";
              else if (isYellow) barColor = "bg-amber-500";

              const chartMax = Math.max(10, ...t.chartPoints.map((p) => p.hours));

              return (
                <div key={t.tail} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                  {/* ── Top row: tail + summary ── */}
                  <div className="flex items-start gap-4 px-4 py-3 border-b border-gray-100">
                    <div className="shrink-0">
                      <div className="font-mono text-base font-bold text-gray-900">{t.tail}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`font-mono font-medium text-sm ${isRed ? "text-red-700" : isYellow ? "text-amber-700" : "text-gray-700"}`}>
                          {fmtDuration(t.maxRolling24hrMin)}
                        </span>
                        {isRed && <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-red-100 text-red-700 uppercase">Limit</span>}
                        {isYellow && <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-100 text-amber-700 uppercase">Caution</span>}
                      </div>
                      {t.dutyOnMs != null && t.dutyOffMs != null && (
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-400">
                          <span>Duty {fmtZulu(t.dutyOnMs)}→{fmtZulu(t.dutyOffMs)}</span>
                          <span>{fmtDuration(t.dutyMinutes ?? 0)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pt-1">
                      <div className="flex items-center gap-2">
                        <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-gray-400 whitespace-nowrap">{MAX_DUTY_HOURS_SCALE}h</span>
                      </div>
                    </div>
                  </div>

                  {/* ── Chart + Legs side by side ── */}
                  <div className="flex flex-col lg:flex-row">
                    {/* Rolling 24h chart */}
                    {t.chartPoints.length > 1 && (
                      <div className="lg:w-[360px] shrink-0 px-3 py-2 border-b lg:border-b-0 lg:border-r border-gray-100">
                        <div className="text-[10px] text-gray-400 font-medium uppercase tracking-wider mb-1">10 in 24</div>
                        <div className="h-[120px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={t.chartPoints} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                              <defs>
                                <linearGradient id={`grad-${t.tail}`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor={isRed ? "#ef4444" : isYellow ? "#f59e0b" : "#3b82f6"} stopOpacity={0.3} />
                                  <stop offset="100%" stopColor={isRed ? "#ef4444" : isYellow ? "#f59e0b" : "#3b82f6"} stopOpacity={0.05} />
                                </linearGradient>
                              </defs>
                              <XAxis
                                dataKey="timeMs"
                                type="number"
                                domain={["dataMin", "dataMax"]}
                                tickFormatter={(ms: number) => {
                                  const d = new Date(ms);
                                  return `${d.getUTCHours().toString().padStart(2, "0")}${d.getUTCMinutes().toString().padStart(2, "0")}`;
                                }}
                                tick={{ fontSize: 9, fill: "#9ca3af" }}
                                tickLine={false}
                                axisLine={false}
                                minTickGap={40}
                              />
                              <YAxis
                                domain={[0, Math.ceil(chartMax)]}
                                tick={{ fontSize: 9, fill: "#9ca3af" }}
                                tickLine={false}
                                axisLine={false}
                                width={24}
                                tickFormatter={(v: number) => `${v}h`}
                              />
                              <ReferenceLine y={10} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="4 3" label={{ value: "10h", position: "left", fontSize: 9, fill: "#22c55e" }} />
                              <Tooltip
                                formatter={(value) => [`${Number(value ?? 0).toFixed(1)}h`, "Flight Time"]}
                                labelFormatter={(label) => {
                                  const d = new Date(Number(label));
                                  return `${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}Z`;
                                }}
                                contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e5e7eb" }}
                              />
                              <Area
                                type="monotone"
                                dataKey="hours"
                                stroke={isRed ? "#ef4444" : isYellow ? "#f59e0b" : "#3b82f6"}
                                strokeWidth={2}
                                fill={`url(#grad-${t.tail})`}
                                dot={false}
                                isAnimationActive={false}
                              />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    {/* Window legs */}
                    <div className="flex-1 px-4 py-2.5 text-sm">
                      {t.windowLegs.length === 0 ? (
                        <span className="text-xs text-gray-400">No legs in window</span>
                      ) : (
                        <div className="space-y-1">
                          {t.windowLegs.map((wl, i) => {
                            const isBreach = wl.breachesAt != null;
                            const depTime = new Date(wl.depIso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
                            const arrTime = new Date(wl.arrIso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
                            return (
                              <div key={i} className="flex items-center gap-1.5 flex-wrap">
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded font-mono font-medium ${isBreach ? "bg-red-50 text-red-700 ring-1 ring-red-200" : "bg-gray-100 text-gray-700"}`}>
                                  {wl.departure_icao ?? "?"}-{wl.arrival_icao ?? "?"}
                                  <span className={isBreach ? "text-red-400" : "text-gray-400"}>{fmtDuration(wl.overlapMin)}</span>
                                </span>
                                <span className="text-[10px] text-gray-400 font-mono">{depTime}→{arrTime}Z</span>
                                <span className={`px-1 py-0.5 text-[9px] font-medium rounded ${sourceBadgeClass(wl.source)}`}>{sourceLabel(wl.source)}</span>
                                <span className="text-[10px] text-gray-400">= {fmtDuration(wl.runningTotalMin)}</span>
                                {isBreach && (
                                  <span className="text-[10px] font-semibold text-red-600">
                                    {wl.breachesAt === FLIGHT_TIME_RED_MIN ? "10h limit (135.267)" : "9h caution"}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                          {t.suggestion && (isRed || isYellow) && (
                            <div className="mt-1.5 px-2 py-1 text-[11px] rounded bg-blue-50 text-blue-700 border border-blue-100">
                              {t.suggestion}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Section 2: Crew Rest Tracker ── */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
          Crew Rest Tracker
          <span className="ml-2 text-[10px] font-normal text-gray-400 normal-case">
            {REST_RED_HOURS}h minimum required — Lead: {LEAD_TIME_MIN}m, Post: {POST_TIME_MIN}m
          </span>
        </h3>
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">Tail</th>
                <th className="px-4 py-3">Duty Period</th>
                <th className="px-4 py-3">Rest Period</th>
                <th className="px-4 py-3">Crew Rest</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredCrewRest.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    {subTab === "today" ? "No rest concerns for today & tomorrow" : "No future rest conflicts"}
                  </td>
                </tr>
              ) : (
                filteredCrewRest.map((t) => {
                  const restHours = t.restMinutes != null ? t.restMinutes / 60 : null;
                  const isRed = restHours != null && restHours < REST_RED_HOURS;
                  const isYellow = restHours != null && !isRed && restHours < REST_YELLOW_HOURS;
                  const isOk = restHours != null && !isRed && !isYellow;

                  return (
                    <tr key={t.tail} className="border-t hover:bg-gray-50 align-top">
                      <td className="px-4 py-2.5 font-mono font-semibold text-gray-900">{t.tail}</td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {t.dutyOnMs != null && t.dutyOffMs != null ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2 text-[11px]">
                              <span className="text-gray-400">On:</span>
                              <span className="font-mono font-medium">{fmtZulu(t.dutyOnMs)}</span>
                              <span className="text-gray-400">Off:</span>
                              <span className="font-mono font-medium">{fmtZulu(t.dutyOffMs)}</span>
                            </div>
                            <div className="flex items-center gap-3 text-[11px]">
                              <span>
                                <span className="text-gray-400">Duty: </span>
                                <span className="font-mono font-medium">{fmtDuration(t.dutyMinutes ?? 0)}</span>
                              </span>
                              <span>
                                <span className="text-gray-400">Flight: </span>
                                <span className="font-mono font-medium">{fmtDuration(t.flightMinutes ?? 0)}</span>
                              </span>
                            </div>
                          </div>
                        ) : <span className="text-gray-400 text-xs">--</span>}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {t.restStartMs != null && t.restStopMs != null ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2 text-[11px]">
                              <span className="text-gray-400">Start:</span>
                              <span className="font-mono font-medium">{fmtZulu(t.restStartMs)}</span>
                            </div>
                            <div className="flex items-center gap-2 text-[11px]">
                              <span className="text-gray-400">Stop:</span>
                              <span className="font-mono font-medium">{fmtZulu(t.restStopMs)}</span>
                            </div>
                          </div>
                        ) : <span className="text-gray-400 text-xs">--</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {t.restMinutes != null ? (
                          <span className={`font-mono font-medium ${isRed ? "text-red-700" : isYellow ? "text-amber-700" : "text-gray-700"}`}>
                            {fmtDuration(t.restMinutes)}
                          </span>
                        ) : <span className="text-gray-400">--</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {isRed && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />Insufficient
                          </span>
                        )}
                        {isYellow && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />Marginal
                          </span>
                        )}
                        {isOk && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />OK
                          </span>
                        )}
                        {restHours == null && <span className="text-xs text-gray-400">No rest data</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
