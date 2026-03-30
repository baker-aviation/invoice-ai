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
import {
  FLIGHT_TIME_RED_MIN,
  FLIGHT_TIME_YELLOW_MIN,
  REST_RED_HOURS,
  REST_YELLOW_HOURS,
  MAX_LEG_DURATION_MIN,
  MIN_REST_GAP_MS,
  LEAD_TIME_MIN,
  POST_TIME_MIN,
  DUTY_FLIGHT_TYPES,
  fmtDuration,
  fmtZulu,
  fmtDateShort,
  getActiveEdct,
  findMaxRolling24,
  getThreeDayWindowMs,
  groupIntoDutyPeriods,
  buildDP,
  relabelDPs,
  buildRestPeriods,
  findBreachLeg,
  computeSuggestion,
} from "@/lib/dutyCalc";
import type { LegInterval, DutyPeriod, RestPeriod } from "@/lib/dutyCalc";

/* ── Constants (local) ──────────────────────────────── */

const POLL_INTERVAL_MS = 300_000; // 5 min — duty data doesn't need real-time

/* ── Chart-only types & helpers (not shared — rendering only) ─ */

type ChartPoint = { timeMs: number; hours: number };

type TailData = {
  tail: string;
  dutyPeriods: DutyPeriod[];
  restPeriods: RestPeriod[];
  maxRolling24hrMin: number;
  chartPoints: ChartPoint[];
  hasFlightsTomorrow: boolean;
  breachLegKey: string | null;
  suggestion: string | null;
  edctMaxRolling24hrMin: number | null;
  edctRestPeriods: RestPeriod[] | null;
  edctChartPoints: ChartPoint[] | null;
};

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
    const jitter = () => POLL_INTERVAL_MS + Math.random() * 30_000;
    let id: ReturnType<typeof setTimeout>;
    const tick = () => { fetchFaData(false); id = setTimeout(tick, jitter()); };
    id = setTimeout(tick, jitter());
    return () => clearTimeout(id);
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
          if (!faDep) return true; // no departure time yet — allow match
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
      // Only use FA arrival data when destination matches (chained flights have wrong arrival)
      const fiDestMatch = fi && fi.destination_icao === f.arrival_icao;
      const actualArr = fiDestMatch ? (fi?.actual_arrival ?? null) : null;
      const estimatedArr = fiDestMatch ? (fi?.arrival_time ?? null) : null;
      // FA departure_time = best available (actual > estimated > scheduled)
      const faDep = fi?.departure_time ?? null;

      // Use FA departure when available — JetInsight often sets the same
      // scheduled_departure for connecting legs (e.g. both ACT→LAS and
      // LAS→PLS show 12:14Z), inflating enroute time for later legs.
      const depIso = actualDep ?? faDep ?? f.scheduled_departure;
      const depMs = new Date(depIso).getTime();

      let source: "actual" | "fa-estimate" | "scheduled";
      let endMs: number;

      if (actualArr) {
        source = "actual";
        endMs = new Date(actualArr).getTime();
      } else if (actualDep && !actualArr) {
        source = estimatedArr ? "fa-estimate" : "actual";
        endMs = estimatedArr ? new Date(estimatedArr).getTime() : now;
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

      let durationMin = (endMs - depMs) / 60_000;

      // Sanity check: if FA-derived duration is wildly longer than the ICS
      // scheduled duration, FA likely has bad data (common with international
      // flights / timezone mismatches).  Fall back to ICS scheduled times.
      if (source !== "scheduled") {
        if (f.scheduled_arrival) {
          const schedDur = (new Date(f.scheduled_arrival).getTime() - new Date(f.scheduled_departure).getTime()) / 60_000;
          if (schedDur > 0 && durationMin > Math.max(schedDur * 1.5, schedDur + 90)) {
            source = "scheduled";
            endMs = new Date(f.scheduled_arrival).getTime();
            durationMin = (endMs - depMs) / 60_000;
          }
        } else if (durationMin > 360) {
          // No scheduled arrival to compare — cap FA estimates at 6h.
          // FA sometimes returns wildly wrong estimates for future legs.
          // Use scheduled source with capped duration.
          source = "scheduled";
          durationMin = 360;
          endMs = depMs + durationMin * 60_000;
        }
      }

      if (durationMin < 0) durationMin = 0;
      // ICS sometimes sets arrival to end-of-duty rather than actual landing.
      // Cap scheduled-source legs at 6h; if still over, use a flat 3h estimate.
      if (source === "scheduled" && durationMin > 360) {
        durationMin = 180; // ~3h fallback for clearly bogus ICS arrival times
      }
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
      // Also deduplicate when a leg was flown earlier than scheduled — prefer actual/fa-estimate over scheduled
      const deduped: LegInterval[] = [];
      for (const leg of legs) {
        const prev = deduped[deduped.length - 1];
        const sameRoute = prev && prev.departure_icao === leg.departure_icao && prev.arrival_icao === leg.arrival_icao;
        if (sameRoute && Math.abs(prev.startMs - leg.startMs) < 5 * 60_000) {
          continue; // skip near-duplicate
        }
        // If this scheduled leg duplicates an actual leg already in deduped, skip it
        if (leg.source === "scheduled" && deduped.some((d) => d.departure_icao === leg.departure_icao && d.arrival_icao === leg.arrival_icao && (d.source === "actual" || d.source === "fa-estimate"))) {
          continue;
        }
        // If this actual/fa-estimate leg duplicates a scheduled leg already in deduped, replace the scheduled one
        if (leg.source === "actual" || leg.source === "fa-estimate") {
          const schedIdx = deduped.findIndex((d) => d.departure_icao === leg.departure_icao && d.arrival_icao === leg.arrival_icao && d.source === "scheduled");
          if (schedIdx !== -1) {
            deduped.splice(schedIdx, 1);
          }
        }
        deduped.push(leg);
      }
      // Fix overlapping legs: if a leg departs before the previous leg arrives
      // (common when JetInsight + FA both set connecting legs to the same departure),
      // push the later leg's departure to the previous leg's arrival.
      deduped.sort((a, b) => a.startMs - b.startMs);
      for (let i = 1; i < deduped.length; i++) {
        const prev = deduped[i - 1];
        if (deduped[i].startMs < prev.endMs) {
          deduped[i].startMs = prev.endMs;
          deduped[i].depIso = new Date(prev.endMs).toISOString();
          // Preserve FA arrival estimate but recalculate duration
          deduped[i].durationMin = Math.max(0, (deduped[i].endMs - deduped[i].startMs) / 60_000);
          if (deduped[i].durationMin > MAX_LEG_DURATION_MIN) {
            deduped[i].durationMin = MAX_LEG_DURATION_MIN;
            deduped[i].endMs = deduped[i].startMs + MAX_LEG_DURATION_MIN * 60_000;
          }
        }
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

      // EDCT-adjusted variant: shift EDCT legs AND cascade delay to subsequent legs
      let edctMaxRolling24hrMin: number | null = null;
      let edctRestPeriods: RestPeriod[] | null = null;
      const tailFlights = flights.filter(f => f.tail_number === tail);
      const hasEdct = tailFlights.some(f => getActiveEdct(f) != null);
      if (hasEdct) {
        // Build EDCT-shifted legs: shift EDCT leg, then cascade delay to later legs
        const edctLegs = validLegs.map(leg => ({ ...leg }));
        // Sort by departure time
        edctLegs.sort((a, b) => a.startMs - b.startMs);
        // Apply EDCT shifts (skip legs that have actually departed — EDCT is moot once airborne)
        for (const leg of edctLegs) {
          if (leg.source === "actual" && leg.startMs < Date.now()) continue;
          const matchedFlight = tailFlights.find(f =>
            f.departure_icao === leg.departure_icao &&
            f.arrival_icao === leg.arrival_icao &&
            Math.abs(new Date(f.scheduled_departure).getTime() - leg.startMs) < 2 * 60 * 60 * 1000
          );
          if (!matchedFlight) continue;
          const edct = getActiveEdct(matchedFlight);
          if (!edct?.edct_time) continue;
          const deltaMs = new Date(edct.edct_time).getTime() - new Date(matchedFlight.scheduled_departure).getTime();
          if (deltaMs <= 0) continue;
          leg.startMs += deltaMs;
          leg.endMs += deltaMs;
        }
        // Cascade: push subsequent legs forward if gap < 30 min (minimum turnaround)
        const MIN_TURN_MS = 30 * 60_000;
        edctLegs.sort((a, b) => a.startMs - b.startMs);
        for (let i = 1; i < edctLegs.length; i++) {
          const gap = edctLegs[i].startMs - edctLegs[i - 1].endMs;
          if (gap < MIN_TURN_MS) {
            const shift = MIN_TURN_MS - gap;
            edctLegs[i].startMs += shift;
            edctLegs[i].endMs += shift;
          }
        }
        edctMaxRolling24hrMin = findMaxRolling24(edctLegs);
        // Build EDCT rest periods: use EDCT-shifted duty off + NORMAL next DP duty on.
        // This correctly shows compressed rest (EDCT delays → finish later → less rest tonight).
        // Don't restructure DPs from EDCT legs — that creates misleading phantom rest periods.
        const todayUtcStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
        const todayUtcEnd = todayUtcStart + 24 * 60 * 60 * 1000;
        edctRestPeriods = [];
        for (let dpIdx = 0; dpIdx < dutyPeriods.length; dpIdx++) {
          if (dpIdx >= restPeriods.length) break;
          const normalRest = restPeriods[dpIdx];
          // Check if this DP has legs departing today (the DP before the rest gap)
          const dp = dutyPeriods[dpIdx];
          const hasTodayLegs = dp.legs.some(l => l.startMs >= todayUtcStart && l.startMs < todayUtcEnd);
          if (!hasTodayLegs) {
            // No EDCT impact on this rest period — use normal rest
            edctRestPeriods.push(normalRest);
            continue;
          }
          // Find EDCT-shifted duty off for this DP's legs
          // Match by route + time proximity (within 6h) to avoid picking up a
          // same-route leg from a different day when routes repeat across days.
          let edctDpLastArr = 0;
          for (const leg of dp.legs) {
            const edctLeg = edctLegs.find(el =>
              el.departure_icao === leg.departure_icao && el.arrival_icao === leg.arrival_icao &&
              Math.abs(el.startMs - leg.startMs) < 6 * 60 * 60 * 1000
            );
            edctDpLastArr = Math.max(edctDpLastArr, edctLeg?.endMs ?? leg.endMs);
          }
          const edctOff = edctDpLastArr + POST_TIME_MIN * 60_000;
          // Use NORMAL next DP's duty on (EDCT doesn't change when crew reports tomorrow)
          const normalNextOn = dutyPeriods[dpIdx + 1].dutyOnMs;
          edctRestPeriods.push({
            startMs: edctOff,
            stopMs: normalNextOn,
            minutes: Math.max(0, (normalNextOn - edctOff) / 60_000),
          });
        }
      }
      const edctChartPoints = hasEdct ? buildRolling24Chart((() => {
        const el = validLegs.map(leg => ({ ...leg }));
        el.sort((a, b) => a.startMs - b.startMs);
        for (const leg of el) {
          if (leg.source === "actual" && leg.startMs < Date.now()) continue;
          const mf = tailFlights.find(f =>
            f.departure_icao === leg.departure_icao &&
            f.arrival_icao === leg.arrival_icao &&
            Math.abs(new Date(f.scheduled_departure).getTime() - leg.startMs) < 2 * 60 * 60 * 1000
          );
          if (!mf) continue;
          const edct = getActiveEdct(mf);
          if (!edct?.edct_time) continue;
          const deltaMs = new Date(edct.edct_time).getTime() - new Date(mf.scheduled_departure).getTime();
          if (deltaMs <= 0) continue;
          leg.startMs += deltaMs;
          leg.endMs += deltaMs;
        }
        el.sort((a, b) => a.startMs - b.startMs);
        for (let i = 1; i < el.length; i++) {
          if (el[i].startMs < el[i - 1].endMs) {
            const shift = el[i - 1].endMs - el[i].startMs;
            el[i].startMs += shift;
            el[i].endMs += shift;
          }
        }
        return el;
      })()) : null;

      result.push({ tail, dutyPeriods, restPeriods, maxRolling24hrMin, chartPoints, hasFlightsTomorrow, breachLegKey, suggestion, edctMaxRolling24hrMin, edctRestPeriods, edctChartPoints });
    }

    result.sort((a, b) => b.maxRolling24hrMin - a.maxRolling24hrMin);
    return result;
  }, [intervalsByTail, flights]);

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
                    {td.edctMaxRolling24hrMin != null && td.edctMaxRolling24hrMin !== td.maxRolling24hrMin && (() => {
                      const eIsRed = td.edctMaxRolling24hrMin >= FLIGHT_TIME_RED_MIN;
                      const eIsYellow = !eIsRed && td.edctMaxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN;
                      return (
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-gray-400">EDCT:</span>
                          <span className={`font-mono font-medium text-xs ${eIsRed ? "text-red-700" : eIsYellow ? "text-amber-700" : "text-green-700"}`}>
                            {fmtDuration(td.edctMaxRolling24hrMin)}
                          </span>
                          {eIsRed && <span className="px-1 py-0.5 text-[9px] font-bold rounded bg-red-100 text-red-700 uppercase">Limit</span>}
                          {eIsYellow && <span className="px-1 py-0.5 text-[9px] font-bold rounded bg-amber-100 text-amber-700 uppercase">Caution</span>}
                        </div>
                      );
                    })()}
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
                  {td.chartPoints.length > 1 && (() => {
                    // Merge normal + EDCT chart points into one dataset for Recharts
                    const hasEdctChart = td.edctChartPoints && td.edctChartPoints.length > 1;
                    const mergedChart = (() => {
                      if (!hasEdctChart) return td.chartPoints.map(p => ({ timeMs: p.timeMs, hours: p.hours, edctHours: undefined as number | undefined }));
                      const allTimes = new Set<number>();
                      for (const p of td.chartPoints) allTimes.add(p.timeMs);
                      for (const p of td.edctChartPoints!) allTimes.add(p.timeMs);
                      const sorted = [...allTimes].sort((a, b) => a - b);
                      // Interpolate values at each time point
                      const interpNormal = (t: number) => {
                        const pts = td.chartPoints;
                        if (t <= pts[0].timeMs) return pts[0].hours;
                        if (t >= pts[pts.length - 1].timeMs) return pts[pts.length - 1].hours;
                        for (let i = 1; i < pts.length; i++) {
                          if (t <= pts[i].timeMs) {
                            const frac = (t - pts[i - 1].timeMs) / (pts[i].timeMs - pts[i - 1].timeMs);
                            return pts[i - 1].hours + frac * (pts[i].hours - pts[i - 1].hours);
                          }
                        }
                        return 0;
                      };
                      const interpEdct = (t: number) => {
                        const pts = td.edctChartPoints!;
                        if (t <= pts[0].timeMs) return pts[0].hours;
                        if (t >= pts[pts.length - 1].timeMs) return pts[pts.length - 1].hours;
                        for (let i = 1; i < pts.length; i++) {
                          if (t <= pts[i].timeMs) {
                            const frac = (t - pts[i - 1].timeMs) / (pts[i].timeMs - pts[i - 1].timeMs);
                            return pts[i - 1].hours + frac * (pts[i].hours - pts[i - 1].hours);
                          }
                        }
                        return 0;
                      };
                      return sorted.map(t => ({ timeMs: t, hours: interpNormal(t), edctHours: interpEdct(t) }));
                    })();
                    const edctChartMax = hasEdctChart ? Math.max(chartMax, ...td.edctChartPoints!.map(p => p.hours)) : chartMax;
                    return (
                    <div className="lg:w-[360px] shrink-0 px-3 py-2 border-b lg:border-b-0 lg:border-r border-gray-100">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">10 in 24</span>
                        {hasEdctChart && (
                          <span className="text-[9px] text-amber-500 font-medium">— EDCT overlay</span>
                        )}
                      </div>
                      <div className="h-[120px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={mergedChart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                            <defs>
                              <linearGradient id={`grad-${td.tail}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={isRed ? "#ef4444" : isYellow ? "#f59e0b" : "#3b82f6"} stopOpacity={0.3} />
                                <stop offset="100%" stopColor={isRed ? "#ef4444" : isYellow ? "#f59e0b" : "#3b82f6"} stopOpacity={0.05} />
                              </linearGradient>
                              {hasEdctChart && (
                                <linearGradient id={`grad-edct-${td.tail}`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.2} />
                                  <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.02} />
                                </linearGradient>
                              )}
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
                              domain={[0, Math.ceil(edctChartMax)]}
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
                              formatter={(value, name) => {
                                if (name === "edctHours") return [`${Number(value ?? 0).toFixed(1)}h`, "EDCT"];
                                return [`${Number(value ?? 0).toFixed(1)}h`, "Flight Time"];
                              }}
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
                            {hasEdctChart && (
                              <Area
                                type="monotone"
                                dataKey="edctHours"
                                stroke="#f59e0b"
                                strokeWidth={2}
                                strokeDasharray="4 3"
                                fill={`url(#grad-edct-${td.tail})`}
                                dot={false}
                                isAnimationActive={false}
                              />
                            )}
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                    );
                  })()}

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
                                    <span className={`text-[10px] font-semibold ${isRed ? "text-red-600" : "text-amber-600"}`}>limiting leg</span>
                                  )}
                                  {isBreach && td.suggestion && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100 font-medium">
                                      {isRed ? td.suggestion : td.suggestion.replace(/^Slide/, "May need to slide").replace(/^Consider/, "May need to consider")}
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
                                    {td.edctRestPeriods && td.edctRestPeriods[dpIdx] && (() => {
                                      const eRest = td.edctRestPeriods[dpIdx];
                                      if (Math.abs(eRest.minutes - rest.minutes) < 5) return null; // same — skip
                                      if (eRest.minutes >= rest.minutes) return null; // EDCT rest should be shorter, not longer
                                      const eHours = eRest.minutes / 60;
                                      const eIsRed = eHours < REST_RED_HOURS;
                                      const eIsYellow = !eIsRed && eHours < REST_YELLOW_HOURS;
                                      return (
                                        <div className={`flex items-center gap-2 px-2.5 py-1 rounded-lg text-[10px] font-medium ${
                                          eIsRed ? "bg-red-50 text-red-700 border border-red-200" :
                                          eIsYellow ? "bg-amber-50 text-amber-700 border border-amber-200" :
                                          "bg-green-50 text-green-700 border border-green-200"
                                        }`}>
                                          <span>EDCT Rest</span>
                                          <span className="font-mono">{fmtZulu(eRest.startMs)}→{fmtZulu(eRest.stopMs)}</span>
                                          <span className="font-mono font-bold">{fmtDuration(eRest.minutes)}</span>
                                        </div>
                                      );
                                    })()}
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
