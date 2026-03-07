"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
// Part 135.267(b)(2): 10h limit for two-pilot crew in any 24 consecutive hours
const FLIGHT_TIME_RED_MIN = 600; // 10 hours — hard limit
const FLIGHT_TIME_YELLOW_MIN = 540; // 9 hours — caution (within 1hr of limit)
const REST_RED_HOURS = 10; // minimum required rest
const REST_YELLOW_HOURS = 11; // within 1hr of minimum
const MAX_LEG_DURATION_MIN = 12 * 60; // cap any single leg at 12h (sanity)
const MIN_REST_GAP_MS = 8 * 60 * 60 * 1000; // 8h minimum to split duty periods
const LEAD_TIME_MIN = 60; // duty starts 60min before first leg
const POST_TIME_MIN = 30; // duty ends 30min after last leg

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
  depIso: string;
  arrIso: string;
  flightType: string | null;
};

type ChartPoint = { timeMs: number; hours: number };

type DutyPeriod = {
  label: string; // "DP 1", "DP 2", etc.
  dateLabel: string; // e.g. "Mar 6"
  legs: LegInterval[];
  dutyOnMs: number;
  dutyOffMs: number;
  dutyMinutes: number;
  flightMinutes: number;
};

type RestPeriod = {
  startMs: number; // duty off of previous DP
  stopMs: number; // duty on of next DP
  minutes: number;
};

type TailData = {
  tail: string;
  dutyPeriods: DutyPeriod[];
  restPeriods: RestPeriod[];
  maxRolling24hrMin: number;
  chartPoints: ChartPoint[];
  hasFlightsTomorrow: boolean;
  breachLegKey: string | null; // "dpIdx-legIdx" of the leg that pushes past 10h
  suggestion: string | null; // fix suggestion text
};


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

function fmtFlightType(ft: string | null): string | null {
  if (!ft) return null;
  const l = ft.toLowerCase();
  if (l === "revenue" || l === "charter" || l === "owner") return "REV";
  if (l === "positioning" || l === "ferry") return "POS";
  return ft.slice(0, 3).toUpperCase();
}

function flightTypeBadgeClass(ft: string | null): string {
  const label = fmtFlightType(ft);
  if (label === "POS") return "bg-yellow-100 text-yellow-700";
  if (label === "REV") return "bg-blue-100 text-blue-700";
  return "bg-gray-100 text-gray-500";
}

function sourceBadgeClass(src: "actual" | "fa-estimate" | "scheduled"): string {
  if (src === "actual") return "bg-green-100 text-green-700";
  if (src === "fa-estimate") return "bg-blue-100 text-blue-700";
  return "bg-gray-100 text-gray-500";
}

function fmtZulu(ms: number): string {
  const d = new Date(ms);
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}${mm}Z`;
}

function fmtDateShort(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function findMaxRolling24(legs: LegInterval[]): number {
  if (legs.length === 0) return 0;
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const checkPoints = new Set<number>();
  for (const leg of legs) {
    checkPoints.add(leg.startMs);
    checkPoints.add(leg.endMs);
    checkPoints.add(leg.startMs + WINDOW_MS);
    checkPoints.add(leg.endMs + WINDOW_MS);
  }
  let maxTotalMs = 0;
  for (const windowEnd of checkPoints) {
    const windowStart = windowEnd - WINDOW_MS;
    let totalMs = 0;
    for (const leg of legs) {
      const os = Math.max(leg.startMs, windowStart);
      const oe = Math.min(leg.endMs, windowEnd);
      if (oe > os) totalMs += oe - os;
    }
    if (totalMs > maxTotalMs) maxTotalMs = totalMs;
  }
  return maxTotalMs / 60_000;
}

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
    if (t > maxMs && hours < 0.01) break;
    t += STEP_MS;
  }
  return points;
}

/** Group sorted legs into duty periods (split at gaps >= MIN_REST_GAP_MS) */
function groupIntoDutyPeriods(legs: LegInterval[]): DutyPeriod[] {
  if (legs.length === 0) return [];
  const dps: DutyPeriod[] = [];
  let currentLegs: LegInterval[] = [legs[0]];

  for (let i = 1; i < legs.length; i++) {
    const gap = legs[i].startMs - legs[i - 1].endMs;
    if (gap >= MIN_REST_GAP_MS) {
      dps.push(buildDP(currentLegs, dps.length + 1));
      currentLegs = [legs[i]];
    } else {
      currentLegs.push(legs[i]);
    }
  }
  dps.push(buildDP(currentLegs, dps.length + 1));
  return dps;
}

function buildDP(legs: LegInterval[], num: number): DutyPeriod {
  const firstDep = legs[0].startMs;
  const lastArr = legs[legs.length - 1].endMs;
  const dutyOnMs = firstDep - LEAD_TIME_MIN * 60_000;
  const dutyOffMs = lastArr + POST_TIME_MIN * 60_000;
  return {
    label: `DP ${num}`, // will be replaced after grouping by date
    dateLabel: fmtDateShort(firstDep),
    legs,
    dutyOnMs,
    dutyOffMs,
    dutyMinutes: (dutyOffMs - dutyOnMs) / 60_000,
    flightMinutes: legs.reduce((s, l) => s + l.durationMin, 0),
  };
}

/** Relabel DPs: use date as label, add "- DP N" suffix when multiple DPs share a date */
function relabelDPs(dps: DutyPeriod[]): void {
  const countByDate = new Map<string, number>();
  for (const dp of dps) {
    countByDate.set(dp.dateLabel, (countByDate.get(dp.dateLabel) ?? 0) + 1);
  }
  const seenByDate = new Map<string, number>();
  for (const dp of dps) {
    const count = countByDate.get(dp.dateLabel) ?? 1;
    if (count > 1) {
      const idx = (seenByDate.get(dp.dateLabel) ?? 0) + 1;
      seenByDate.set(dp.dateLabel, idx);
      dp.label = `${dp.dateLabel} - DP ${idx}`;
    } else {
      dp.label = dp.dateLabel;
    }
  }
}

function buildRestPeriods(dps: DutyPeriod[]): RestPeriod[] {
  const rests: RestPeriod[] = [];
  for (let i = 0; i < dps.length - 1; i++) {
    const startMs = dps[i].dutyOffMs;
    const stopMs = dps[i + 1].dutyOnMs;
    rests.push({ startMs, stopMs, minutes: Math.max(0, (stopMs - startMs) / 60_000) });
  }
  return rests;
}

/** Find the leg that pushes the rolling 24hr total past 10h.
 *  Returns "dpIdx-legIdx" key or null. */
function findBreachLeg(dps: DutyPeriod[]): string | null {
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const allLegs: { dpIdx: number; legIdx: number; leg: LegInterval }[] = [];
  for (let d = 0; d < dps.length; d++) {
    for (let l = 0; l < dps[d].legs.length; l++) {
      allLegs.push({ dpIdx: d, legIdx: l, leg: dps[d].legs[l] });
    }
  }
  allLegs.sort((a, b) => a.leg.startMs - b.leg.startMs);

  // For each leg, compute rolling 24hr total at that leg's end
  for (let i = 0; i < allLegs.length; i++) {
    const windowEnd = allLegs[i].leg.endMs;
    const windowStart = windowEnd - WINDOW_MS;
    let totalMin = 0;
    for (let j = 0; j <= i; j++) {
      const os = Math.max(allLegs[j].leg.startMs, windowStart);
      const oe = Math.min(allLegs[j].leg.endMs, windowEnd);
      if (oe > os) totalMin += (oe - os) / 60_000;
    }
    if (totalMin >= FLIGHT_TIME_YELLOW_MIN) {
      return `${allLegs[i].dpIdx}-${allLegs[i].legIdx}`;
    }
  }
  return null;
}

/** Compute a fix suggestion: find the earliest departure time for the breach leg
 *  that keeps the rolling 24hr total under 10h. */
function computeSuggestion(dps: DutyPeriod[], breachKey: string | null): string | null {
  if (!breachKey) return null;
  const [dpIdxStr, legIdxStr] = breachKey.split("-");
  const dpIdx = parseInt(dpIdxStr);
  const legIdx = parseInt(legIdxStr);
  const dp = dps[dpIdx];
  if (!dp) return null;
  const breachLeg = dp.legs[legIdx];
  if (!breachLeg) return null;

  const route = `${breachLeg.departure_icao ?? "?"}-${breachLeg.arrival_icao ?? "?"}`;

  // Collect all legs BEFORE the breach leg
  const priorLegs: LegInterval[] = [];
  for (let d = 0; d < dps.length; d++) {
    for (let l = 0; l < dps[d].legs.length; l++) {
      if (d === dpIdx && l === legIdx) break;
      priorLegs.push(dps[d].legs[l]);
    }
    if (d === dpIdx) break;
  }

  // Scan forward from breach leg's current start time minute-by-minute
  // to find the earliest departure where rolling 24hr stays under 10h
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const legDurMs = breachLeg.durationMin * 60_000;
  const STEP = 5 * 60_000; // 5 minute steps
  const MAX_SHIFT = 12 * 60 * 60_000; // don't look more than 12h out

  for (let shift = STEP; shift <= MAX_SHIFT; shift += STEP) {
    const newStart = breachLeg.startMs + shift;
    const newEnd = newStart + legDurMs;
    const windowStart = newEnd - WINDOW_MS;

    let totalMin = 0;
    for (const leg of priorLegs) {
      const os = Math.max(leg.startMs, windowStart);
      const oe = Math.min(leg.endMs, newEnd);
      if (oe > os) totalMin += (oe - os) / 60_000;
    }
    totalMin += breachLeg.durationMin;

    if (totalMin < FLIGHT_TIME_RED_MIN) {
      const d = new Date(newStart);
      const hh = d.getUTCHours().toString().padStart(2, "0");
      const mm = d.getUTCMinutes().toString().padStart(2, "0");
      return `Slide ${route} to depart ${hh}${mm}Z or later`;
    }
  }

  return `Consider removing or shortening ${route}`;
}

/** Get yesterday 0000Z to end of tomorrow 2359Z */
function getThreeDayWindowMs(): { startMs: number; endMs: number } {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    startMs: todayUtc - 24 * 60 * 60 * 1000, // yesterday 0000Z
    endMs: todayUtc + 2 * 24 * 60 * 60 * 1000, // end of tomorrow 2359Z
  };
}

/* ── Component ──────────────────────────────────────── */

export default function DutyTracker({ flights, scrollToTail, onScrollComplete }: {
  flights: Flight[];
  scrollToTail?: string | null;
  onScrollComplete?: () => void;
}) {
  const [faData, setFaData] = useState<FlightInfoMap[]>([]);
  const [faLoading, setFaLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [useUtc, setUseUtc] = useState(false);

  const fmt = useCallback(
    (iso: string | null | undefined, icao?: string | null) =>
      fmtTimeInTz(iso, icao, !useUtc),
    [useUtc],
  );

  const fetchFaData = useCallback(async (isInitial = false) => {
    if (isInitial) setFaLoading(true);
    try {
      const res = await fetch("/api/aircraft/flights", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setFaData(data.flights ?? []);
        setLastUpdate(new Date());
      }
    } catch { /* ignore */ }
    if (isInitial) setFaLoading(false);
  }, []);

  useEffect(() => {
    fetchFaData(true);
    const interval = setInterval(() => fetchFaData(false), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchFaData]);

  // Group FA flights by tail for flexible matching
  const faByTail = useMemo(() => {
    const map = new Map<string, FlightInfoMap[]>();
    for (const fi of faData) {
      if (!map.has(fi.tail)) map.set(fi.tail, []);
      map.get(fi.tail)!.push(fi);
    }
    return map;
  }, [faData]);

  /* ── Build leg intervals per tail (filtered to 3-day window) ── */
  const intervalsByTail = useMemo(() => {
    const result = new Map<string, LegInterval[]>();
    const now = Date.now();
    const { startMs: windowStart, endMs: windowEnd } = getThreeDayWindowMs();

    for (const f of flights) {
      if (!f.tail_number) continue;
      const ft = (f.flight_type ?? "").toLowerCase();
      if (ft && !DUTY_FLIGHT_TYPES.has(ft)) continue;

      // Match FA data: prefer exact route match, fall back to closest departure time
      const tailFaFlights = faByTail.get(f.tail_number) ?? [];
      let fi: FlightInfoMap | undefined;
      // Try exact route match first
      fi = tailFaFlights.find(
        (fa) => fa.origin_icao === f.departure_icao && fa.destination_icao === f.arrival_icao
      );
      // Fall back: match by closest scheduled departure time (within 2h)
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

      // Sanity check: if FA-derived duration is wildly longer than the ICS
      // scheduled duration, FA likely has bad data (common with international
      // flights / timezone mismatches).  Fall back to ICS scheduled times.
      if (source !== "scheduled" && f.scheduled_arrival) {
        const schedDur = (new Date(f.scheduled_arrival).getTime() - new Date(f.scheduled_departure).getTime()) / 60_000;
        if (schedDur > 0 && durationMin > Math.max(schedDur * 2, schedDur + 120)) {
          source = "scheduled";
          endMs = new Date(f.scheduled_arrival).getTime();
          durationMin = (endMs - depMs) / 60_000;
        }
      }

      if (durationMin < 0) durationMin = 0;
      if (durationMin > MAX_LEG_DURATION_MIN) durationMin = MAX_LEG_DURATION_MIN;
      endMs = depMs + durationMin * 60_000;

      if (durationMin <= 0) continue;

      // Filter: only include legs that overlap the 3-day window
      if (endMs < windowStart || depMs > windowEnd) continue;

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
        flightType: f.flight_type,
      });
    }

    for (const [tail, legs] of result) {
      legs.sort((a, b) => a.startMs - b.startMs);
      // Dedup: remove legs with same route and overlapping times (ICS sometimes has duplicate entries)
      const deduped: LegInterval[] = [];
      for (const leg of legs) {
        const prev = deduped[deduped.length - 1];
        if (prev && prev.departure_icao === leg.departure_icao && prev.arrival_icao === leg.arrival_icao && Math.abs(prev.startMs - leg.startMs) < 5 * 60_000) {
          continue; // skip duplicate
        }
        deduped.push(leg);
      }
      result.set(tail, deduped);
    }
    return result;
  }, [flights, faByTail]);

  /* ── Build per-tail data with duty periods ── */
  const tailData = useMemo((): TailData[] => {
    const result: TailData[] = [];

    for (const [tail, legs] of intervalsByTail) {
      const validLegs = legs.filter((l) => l.durationMin > 0);
      const dutyPeriods = groupIntoDutyPeriods(validLegs);
      relabelDPs(dutyPeriods);
      const restPeriods = buildRestPeriods(dutyPeriods);
      const maxRolling24hrMin = findMaxRolling24(validLegs);
      const chartPoints = buildRolling24Chart(validLegs);

      // Check if any leg departs tomorrow (UTC)
      const now = new Date();
      const tomorrowUtcStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 24 * 60 * 60 * 1000;
      const tomorrowUtcEnd = tomorrowUtcStart + 24 * 60 * 60 * 1000;
      const hasFlightsTomorrow = validLegs.some((l) => l.startMs >= tomorrowUtcStart && l.startMs < tomorrowUtcEnd);
      const breachLegKey = maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN ? findBreachLeg(dutyPeriods) : null;
      const suggestion = maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN ? computeSuggestion(dutyPeriods, breachLegKey) : null;

      result.push({ tail, dutyPeriods, restPeriods, maxRolling24hrMin, chartPoints, hasFlightsTomorrow, breachLegKey, suggestion });
    }

    result.sort((a, b) => b.maxRolling24hrMin - a.maxRolling24hrMin);
    return result;
  }, [intervalsByTail]);

  // Scroll to a specific tail card when requested.
  // Depends on tailData so it re-fires after FA data recomputes the card list.
  // Uses two rAFs to ensure React has flushed the DOM.
  const scrollDone = useRef(false);
  useEffect(() => { scrollDone.current = false; }, [scrollToTail]);
  useEffect(() => {
    if (!scrollToTail || scrollDone.current) return;
    // Only scroll once FA data has loaded (tailData will recompute)
    if (faLoading) return;
    // Double-rAF to ensure DOM is painted after React commit
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        const el = document.getElementById(`duty-${scrollToTail}`);
        if (el) {
          scrollDone.current = true;
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("ring-2", "ring-blue-400");
          setTimeout(() => el.classList.remove("ring-2", "ring-blue-400"), 2500);
          onScrollComplete?.();
        }
      });
      return () => cancelAnimationFrame(raf2);
    });
    return () => cancelAnimationFrame(raf1);
  }, [scrollToTail, faLoading, tailData, onScrollComplete]);

  /* ── Render ────────────────────────────────────────── */
  return (
    <div className="space-y-6">
      {/* ── Header row ── */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-4">
          <span className="font-medium text-gray-700">
            {intervalsByTail.size} tail{intervalsByTail.size !== 1 ? "s" : ""} tracked
          </span>
          <span className="text-xs text-gray-400">Yesterday / Today / Tomorrow</span>
          {faLoading && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs text-gray-400">
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              Loading FlightAware...
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
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

      {/* ── Per-tail cards ── */}
      {tailData.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-8 text-center text-gray-400">
          No flights in the 3-day window
        </div>
      ) : (
        <div className="space-y-4">
          {tailData.map((td) => {
            const isRed = td.maxRolling24hrMin >= FLIGHT_TIME_RED_MIN;
            const isYellow = !isRed && td.maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN;
            const pct = Math.min((td.maxRolling24hrMin / (10 * 60)) * 100, 100);
            const chartMax = Math.max(10, ...td.chartPoints.map((p) => p.hours));

            let barColor = "bg-blue-500";
            if (isRed) barColor = "bg-red-500";
            else if (isYellow) barColor = "bg-amber-500";

            return (
              <div key={td.tail} id={`duty-${td.tail}`} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                {/* ── Header: tail + rolling 24hr summary ── */}
                <div className="flex items-start gap-4 px-4 py-3 border-b border-gray-100">
                  <div className="shrink-0">
                    <div className="font-mono text-base font-bold text-gray-900">{td.tail}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-gray-400">24hr Max:</span>
                      <span className={`font-mono font-medium text-sm ${isRed ? "text-red-700" : isYellow ? "text-amber-700" : "text-gray-700"}`}>
                        {fmtDuration(td.maxRolling24hrMin)}
                      </span>
                      {isRed && <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-red-100 text-red-700 uppercase">Limit</span>}
                      {isYellow && <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-100 text-amber-700 uppercase">Caution</span>}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 pt-2">
                    <div className="flex items-center gap-2">
                      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[10px] text-gray-400 whitespace-nowrap">10h</span>
                    </div>
                  </div>
                </div>

                {/* ── Body: chart + duty periods ── */}
                <div className="flex flex-col lg:flex-row">
                  {/* Rolling 24h chart */}
                  {td.chartPoints.length > 1 && (
                    <div className="lg:w-[360px] shrink-0 px-3 py-2 border-b lg:border-b-0 lg:border-r border-gray-100">
                      <div className="text-[10px] text-gray-400 font-medium uppercase tracking-wider mb-1">10 in 24</div>
                      <div className="h-[120px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={td.chartPoints} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                            <defs>
                              <linearGradient id={`grad-${td.tail}`} x1="0" y1="0" x2="0" y2="1">
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
                                const hh = d.getUTCHours().toString().padStart(2, "0");
                                const mm = d.getUTCMinutes().toString().padStart(2, "0");
                                if (hh === "00" && parseInt(mm) < 15) {
                                  return `${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`;
                                }
                                return `${hh}${mm}`;
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
                            {/* Midnight UTC reference lines */}
                            {(() => {
                              const pts = td.chartPoints;
                              if (pts.length < 2) return null;
                              const minMs = pts[0].timeMs;
                              const maxMs = pts[pts.length - 1].timeMs;
                              const lines: React.ReactNode[] = [];
                              // Find first midnight at or after minMs
                              let m = new Date(minMs);
                              m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + 1));
                              while (m.getTime() < maxMs) {
                                const ms = m.getTime();
                                const lbl = `${m.getUTCDate()} ${m.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`;
                                lines.push(
                                  <ReferenceLine key={ms} x={ms} stroke="#d1d5db" strokeWidth={1} strokeDasharray="3 3" label={{ value: lbl, position: "top", fontSize: 8, fill: "#9ca3af" }} />
                                );
                                m = new Date(ms + 24 * 60 * 60 * 1000);
                              }
                              return lines;
                            })()}
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
                              fill={`url(#grad-${td.tail})`}
                              dot={false}
                              isAnimationActive={false}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  {/* Duty periods + rest */}
                  <div className="flex-1 px-4 py-3 text-sm space-y-3">
                    {td.dutyPeriods.length === 0 ? (
                      <span className="text-xs text-gray-400">No legs</span>
                    ) : (
                      td.dutyPeriods.map((dp, dpIdx) => (
                        <div key={dpIdx}>
                          {/* Duty period header */}
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-semibold text-gray-700">{dp.label}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                              On: {fmtZulu(dp.dutyOnMs)} Off: {fmtZulu(dp.dutyOffMs)}
                            </span>
                            <span className="text-[10px] text-gray-400">
                              Duty: {fmtDuration(dp.dutyMinutes)} | Flight: {fmtDuration(dp.flightMinutes)}
                            </span>
                          </div>

                          {/* Legs in this duty period */}
                          <div className="space-y-1 ml-3 border-l-2 border-gray-200 pl-3">
                            {dp.legs.map((leg, legIdx) => {
                              const depTime = new Date(leg.depIso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
                              const arrTime = new Date(leg.arrIso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
                              const isBreach = td.breachLegKey === `${dpIdx}-${legIdx}`;
                              return (
                                <div key={legIdx} className="flex items-center gap-1.5 flex-wrap">
                                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded font-mono font-medium ${isBreach ? "bg-red-50 text-red-700 ring-1 ring-red-200" : "bg-gray-100 text-gray-700"}`}>
                                    {leg.departure_icao ?? "?"}-{leg.arrival_icao ?? "?"}
                                    <span className={isBreach ? "text-red-400" : "text-gray-400"}>{fmtDuration(leg.durationMin)}</span>
                                  </span>
                                  <span className="text-[10px] text-gray-400 font-mono">{depTime}→{arrTime}Z</span>
                                  {fmtFlightType(leg.flightType) && (
                                    <span className={`px-1 py-0.5 text-[9px] font-bold rounded ${flightTypeBadgeClass(leg.flightType)}`}>{fmtFlightType(leg.flightType)}</span>
                                  )}
                                  <span className={`px-1 py-0.5 text-[9px] font-medium rounded ${sourceBadgeClass(leg.source)}`}>{sourceLabel(leg.source)}</span>
                                  {isBreach && (
                                    <span className="text-[10px] font-semibold text-red-600">10h limit</span>
                                  )}
                                  {isBreach && td.suggestion && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100 font-medium">
                                      {td.suggestion}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          {/* Rest period after this DP (if not the last) */}
                          {dpIdx < td.restPeriods.length && (
                            <div className="mt-2 mb-1 flex items-center gap-2">
                              {(() => {
                                const rest = td.restPeriods[dpIdx];
                                const restHours = rest.minutes / 60;
                                const rIsRed = restHours < REST_RED_HOURS;
                                const rIsYellow = !rIsRed && restHours < REST_YELLOW_HOURS;
                                return (
                                  <>
                                    <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] font-medium ${
                                      rIsRed ? "bg-red-50 text-red-700 border border-red-200" :
                                      rIsYellow ? "bg-amber-50 text-amber-700 border border-amber-200" :
                                      "bg-green-50 text-green-700 border border-green-200"
                                    }`}>
                                      <span>Rest</span>
                                      <span className="font-mono">{fmtZulu(rest.startMs)}→{fmtZulu(rest.stopMs)}</span>
                                      <span className="font-mono font-bold">{fmtDuration(rest.minutes)}</span>
                                      {rIsRed && <span className="text-[9px] uppercase font-bold">Insufficient</span>}
                                      {rIsYellow && <span className="text-[9px] uppercase font-bold">Marginal</span>}
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      ))
                    )}

                    {/* No flights tomorrow note */}
                    {!td.hasFlightsTomorrow && (
                      <div className="mt-3 px-2.5 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-gray-400 italic">
                        No flights scheduled tomorrow
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
  );
}
