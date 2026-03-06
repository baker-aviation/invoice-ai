"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { Flight } from "@/lib/opsApi";
import type { FlightInfoMap } from "@/app/maintenance/MapView";
import { fmtTimeInTz } from "@/lib/airportTimezones";

/* ── Constants ──────────────────────────────────────── */

const POLL_INTERVAL_MS = 60_000;
const MAX_DUTY_HOURS_SCALE = 10; // progress bar scale (hours)
const FLIGHT_TIME_RED_MIN = 570; // 9.5 hours
const FLIGHT_TIME_YELLOW_MIN = 480; // 8 hours
const REST_RED_HOURS = 12;
const REST_YELLOW_HOURS = 14;
const MAX_LEG_DURATION_MIN = 12 * 60; // cap any single leg at 12h (sanity)
const MIN_REST_GAP_MS = 6 * 60 * 60 * 1000; // 6h minimum for crew rest

// Only include revenue/charter and positioning legs for duty tracking
const DUTY_FLIGHT_TYPES = new Set(["revenue", "owner", "positioning", "ferry"]);

/* ── Types ──────────────────────────────────────────── */

type LegInterval = {
  departure_icao: string | null;
  arrival_icao: string | null;
  startMs: number;
  endMs: number;
  durationMin: number;
  source: "actual" | "fa-estimate" | "scheduled";
};

type WindowLeg = LegInterval & {
  /** Minutes of this leg that overlap the worst window */
  overlapMin: number;
  /** Running total at end of this leg within the window */
  runningTotalMin: number;
  /** True if this leg is the one that crosses the threshold */
  breachesAt?: number; // minute mark where threshold crossed
};

type TailFlightTime = {
  tail: string;
  maxRolling24hrMin: number;
  windowLegs: WindowLeg[];
  /** The leg that should be slid to fix the issue */
  suggestion: string | null;
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

function sourceBadgeClass(src: "actual" | "fa-estimate" | "scheduled"): string {
  if (src === "actual") return "bg-green-100 text-green-700";
  if (src === "fa-estimate") return "bg-blue-100 text-blue-700";
  return "bg-gray-100 text-gray-500";
}

/**
 * Find the worst 24hr window (the one with max flight time)
 * scanning window-end from now to now+24h.
 * Returns { maxMin, bestWindowEnd }.
 */
function findWorstWindow(
  legs: LegInterval[],
  nowMs: number,
): { maxMin: number; windowEndMs: number } {
  if (legs.length === 0) return { maxMin: 0, windowEndMs: nowMs };

  const WINDOW_MS = 24 * 60 * 60 * 1000;

  const checkPoints = new Set<number>();
  checkPoints.add(nowMs);
  checkPoints.add(nowMs + WINDOW_MS);

  for (const leg of legs) {
    for (const t of [leg.startMs, leg.endMs, leg.startMs + WINDOW_MS, leg.endMs + WINDOW_MS]) {
      if (t >= nowMs && t <= nowMs + WINDOW_MS) {
        checkPoints.add(t);
      }
    }
  }

  let maxTotalMs = 0;
  let bestEnd = nowMs;

  for (const windowEnd of checkPoints) {
    const windowStart = windowEnd - WINDOW_MS;
    let totalMs = 0;

    for (const leg of legs) {
      const overlapStart = Math.max(leg.startMs, windowStart);
      const overlapEnd = Math.min(leg.endMs, windowEnd);
      if (overlapEnd > overlapStart) {
        totalMs += overlapEnd - overlapStart;
      }
    }

    if (totalMs > maxTotalMs) {
      maxTotalMs = totalMs;
      bestEnd = windowEnd;
    }
  }

  return { maxMin: maxTotalMs / 60_000, windowEndMs: bestEnd };
}

/* ── Component ──────────────────────────────────────── */

export default function DutyTracker({ flights }: { flights: Flight[] }) {
  const [faData, setFaData] = useState<FlightInfoMap[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [useUtc, setUseUtc] = useState(false);

  const fmt = useCallback(
    (iso: string | null | undefined, icao?: string | null) =>
      fmtTimeInTz(iso, icao, !useUtc),
    [useUtc],
  );

  /* ── Fetch FlightAware data ── */
  const fetchFaData = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/flights", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setFaData(data.flights ?? []);
        setLastUpdate(new Date());
      }
    } catch {
      /* ignore fetch errors */
    }
  }, []);

  useEffect(() => {
    fetchFaData();
    const interval = setInterval(fetchFaData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchFaData]);

  /* ── Build FA lookup keyed by tail|origin|dest ── */
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

      // Only include charter/revenue and positioning legs
      const ft = (f.flight_type ?? "").toLowerCase();
      if (ft && !DUTY_FLIGHT_TYPES.has(ft)) continue;

      const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
      const fi = faMap.get(routeKey);

      const actualDep = fi?.actual_departure ?? null;
      const actualArr = fi?.actual_arrival ?? null;
      const estimatedArr = fi?.arrival_time ?? null;

      // Determine source for departure
      const depIso = actualDep ?? f.scheduled_departure;
      const depMs = new Date(depIso).getTime();

      // Determine arrival and source
      let arrIso: string | null;
      let source: "actual" | "fa-estimate" | "scheduled";
      let endMs: number;

      if (actualArr) {
        arrIso = actualArr;
        source = "actual";
        endMs = new Date(actualArr).getTime();
      } else if (actualDep && !actualArr) {
        // In-flight
        arrIso = null;
        source = estimatedArr ? "fa-estimate" : "actual";
        endMs = estimatedArr ? new Date(estimatedArr).getTime() : now;
      } else if (estimatedArr) {
        arrIso = estimatedArr;
        source = "fa-estimate";
        endMs = new Date(estimatedArr).getTime();
      } else {
        arrIso = f.scheduled_arrival;
        source = "scheduled";
        endMs = arrIso ? new Date(arrIso).getTime() : depMs;
      }

      let durationMin = (endMs - depMs) / 60_000;
      if (durationMin < 0) durationMin = 0;
      if (durationMin > MAX_LEG_DURATION_MIN) durationMin = MAX_LEG_DURATION_MIN;

      // Re-clamp endMs based on capped duration
      endMs = depMs + durationMin * 60_000;

      const leg: LegInterval = {
        departure_icao: f.departure_icao,
        arrival_icao: f.arrival_icao,
        startMs: depMs,
        endMs,
        durationMin,
        source,
      };

      if (!result.has(f.tail_number)) {
        result.set(f.tail_number, []);
      }
      result.get(f.tail_number)!.push(leg);
    }

    // Sort legs by departure time within each tail
    for (const legs of result.values()) {
      legs.sort((a, b) => a.startMs - b.startMs);
    }

    return result;
  }, [flights, faMap]);

  /* ── Feature 1: Rolling 24hr flight time per tail ── */
  const flightTimeData = useMemo((): TailFlightTime[] => {
    const result: TailFlightTime[] = [];
    const now = Date.now();
    const WINDOW_MS = 24 * 60 * 60 * 1000;

    for (const [tail, legs] of intervalsByTail) {
      const validLegs = legs.filter((l) => l.durationMin > 0);
      const { maxMin, windowEndMs } = findWorstWindow(validLegs, now);
      const windowStartMs = windowEndMs - WINDOW_MS;

      // Get legs that overlap this worst window, sorted by start
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

        const wl: WindowLeg = {
          ...leg,
          overlapMin,
          runningTotalMin: runningTotal,
        };

        // Check if this leg crosses the 8h caution threshold
        if (prevTotal < FLIGHT_TIME_YELLOW_MIN && runningTotal >= FLIGHT_TIME_YELLOW_MIN) {
          breachLegIdx = windowLegs.length;
          wl.breachesAt = FLIGHT_TIME_YELLOW_MIN;
        }
        // Or the 9.5h red threshold
        if (prevTotal < FLIGHT_TIME_RED_MIN && runningTotal >= FLIGHT_TIME_RED_MIN) {
          breachLegIdx = windowLegs.length;
          wl.breachesAt = FLIGHT_TIME_RED_MIN;
        }

        windowLegs.push(wl);
      }

      // Suggestion: if breaching, suggest sliding the first leg after breach
      let suggestion: string | null = null;
      if (breachLegIdx >= 0 && breachLegIdx + 1 < windowLegs.length) {
        const slideLeg = windowLegs[breachLegIdx + 1];
        suggestion = `Consider sliding ${slideLeg.departure_icao ?? "?"}-${slideLeg.arrival_icao ?? "?"} to reduce 24hr total`;
      } else if (breachLegIdx >= 0) {
        // The breach leg itself is the last one — suggest sliding it
        const slideLeg = windowLegs[breachLegIdx];
        suggestion = `Consider sliding ${slideLeg.departure_icao ?? "?"}-${slideLeg.arrival_icao ?? "?"} to reduce 24hr total`;
      }

      result.push({
        tail,
        maxRolling24hrMin: maxMin,
        windowLegs,
        suggestion,
      });
    }

    // Sort: highest flight time first
    result.sort((a, b) => b.maxRolling24hrMin - a.maxRolling24hrMin);
    return result;
  }, [intervalsByTail]);

  /* ── Feature 2: Crew rest per tail ── */
  const crewRestData = useMemo((): TailCrewRest[] => {
    const result: TailCrewRest[] = [];
    const now = Date.now();

    for (const [tail, legs] of intervalsByTail) {
      const sorted = [...legs].sort((a, b) => a.startMs - b.startMs);

      let bestLanding: string | null = null;
      let bestLandingIcao: string | null = null;
      let bestLandingSource: "actual" | "fa-estimate" | "scheduled" = "scheduled";
      let bestNextDep: string | null = null;
      let bestNextDepIcao: string | null = null;
      let bestNextDepSource: "actual" | "fa-estimate" | "scheduled" = "scheduled";
      let bestRestMin: number | null = null;

      // Look for gaps >= 6h between consecutive legs
      for (let i = 0; i < sorted.length - 1; i++) {
        const landingMs = sorted[i].endMs;
        const nextDepMs = sorted[i + 1].startMs;
        const gapMs = nextDepMs - landingMs;

        if (gapMs < MIN_REST_GAP_MS) continue;

        // We want the gap that straddles now or is the first future one
        if (nextDepMs > now) {
          bestLanding = new Date(landingMs).toISOString();
          bestLandingIcao = sorted[i].arrival_icao;
          bestLandingSource = sorted[i].source;
          bestNextDep = new Date(nextDepMs).toISOString();
          bestNextDepIcao = sorted[i + 1].departure_icao;
          bestNextDepSource = sorted[i + 1].source === "actual" ? "actual" : "scheduled";
          bestRestMin = gapMs / 60_000;
          break;
        }
      }

      // Fallback: last past landing → next future departure with 6h+ gap
      if (!bestNextDep && sorted.length > 0) {
        const pastLegs = sorted.filter((l) => l.endMs <= now);
        const futureLeg = sorted.find((l) => l.startMs > now);
        if (pastLegs.length > 0 && futureLeg) {
          const lastPast = pastLegs[pastLegs.length - 1];
          const gapMs = futureLeg.startMs - lastPast.endMs;
          if (gapMs >= MIN_REST_GAP_MS) {
            bestLanding = new Date(lastPast.endMs).toISOString();
            bestLandingIcao = lastPast.arrival_icao;
            bestLandingSource = lastPast.source;
            bestNextDep = new Date(futureLeg.startMs).toISOString();
            bestNextDepIcao = futureLeg.departure_icao;
            bestNextDepSource = futureLeg.source === "actual" ? "actual" : "scheduled";
            bestRestMin = gapMs / 60_000;
          }
        }
      }

      result.push({
        tail,
        lastLanding: bestLanding,
        lastLandingIcao: bestLandingIcao,
        lastLandingSource: bestLandingSource,
        nextDeparture: bestNextDep,
        nextDepartureIcao: bestNextDepIcao,
        nextDepartureSource: bestNextDepSource,
        restMinutes: bestRestMin,
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

  /* ── Alert counts ── */
  const flightTimeAlerts = flightTimeData.filter(
    (t) => t.maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN,
  ).length;
  const restAlerts = crewRestData.filter(
    (t) => t.restMinutes != null && t.restMinutes < REST_YELLOW_HOURS * 60,
  ).length;

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
          {lastUpdate && (
            <span className="text-xs text-gray-400">
              Updated{" "}
              {lastUpdate.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
        </div>
      </div>

      {/* ── Section 1: Rolling 24hr Flight Time ── */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
          Rolling 24hr Flight Time
        </h3>
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">Tail</th>
                <th className="px-4 py-3">Max 24hr</th>
                <th className="px-4 py-3 w-40">Status</th>
                <th className="px-4 py-3">Window Legs</th>
              </tr>
            </thead>
            <tbody>
              {flightTimeData.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                    No flight data available
                  </td>
                </tr>
              ) : (
                flightTimeData.map((t) => {
                  const isRed = t.maxRolling24hrMin >= FLIGHT_TIME_RED_MIN;
                  const isYellow = !isRed && t.maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN;
                  const pct = Math.min(
                    (t.maxRolling24hrMin / (MAX_DUTY_HOURS_SCALE * 60)) * 100,
                    100,
                  );

                  let barColor = "bg-blue-500";
                  if (isRed) barColor = "bg-red-500";
                  else if (isYellow) barColor = "bg-amber-500";

                  return (
                    <tr key={t.tail} className="border-t hover:bg-gray-50 align-top">
                      <td className="px-4 py-2.5 font-mono font-semibold text-gray-900">
                        {t.tail}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-mono font-medium ${
                              isRed ? "text-red-700" : isYellow ? "text-amber-700" : "text-gray-700"
                            }`}
                          >
                            {fmtDuration(t.maxRolling24hrMin)}
                          </span>
                          {isRed && (
                            <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-red-100 text-red-700 uppercase">
                              Limit
                            </span>
                          )}
                          {isYellow && (
                            <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-100 text-amber-700 uppercase">
                              Caution
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${barColor}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-gray-400 whitespace-nowrap">
                            {MAX_DUTY_HOURS_SCALE}h
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        {t.windowLegs.length === 0 ? (
                          <span className="text-xs text-gray-400">No legs in window</span>
                        ) : (
                          <div className="space-y-1">
                            {t.windowLegs.map((wl, i) => {
                              const isBreach = wl.breachesAt != null;
                              return (
                                <div key={i} className="flex items-center gap-1.5 flex-wrap">
                                  <span
                                    className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded font-mono font-medium ${
                                      isBreach
                                        ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                                        : "bg-gray-100 text-gray-700"
                                    }`}
                                  >
                                    {wl.departure_icao ?? "?"}-{wl.arrival_icao ?? "?"}
                                    <span className={isBreach ? "text-red-400" : "text-gray-400"}>
                                      {fmtDuration(wl.overlapMin)}
                                    </span>
                                  </span>
                                  <span className={`px-1 py-0.5 text-[9px] font-medium rounded ${sourceBadgeClass(wl.source)}`}>
                                    {sourceLabel(wl.source)}
                                  </span>
                                  <span className="text-[10px] text-gray-400">
                                    = {fmtDuration(wl.runningTotalMin)}
                                  </span>
                                  {isBreach && (
                                    <span className="text-[10px] font-semibold text-red-600">
                                      {wl.breachesAt === FLIGHT_TIME_RED_MIN
                                        ? "9.5h limit hit"
                                        : "8h caution"}
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
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Section 2: Crew Rest Tracker ── */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
          Crew Rest Tracker
        </h3>
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">Tail</th>
                <th className="px-4 py-3">Last Landing</th>
                <th className="px-4 py-3">Next Departure</th>
                <th className="px-4 py-3">Rest Period</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {crewRestData.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    No flight data available
                  </td>
                </tr>
              ) : (
                crewRestData.map((t) => {
                  const restHours = t.restMinutes != null ? t.restMinutes / 60 : null;
                  const isRed = restHours != null && restHours < REST_RED_HOURS;
                  const isYellow = restHours != null && !isRed && restHours < REST_YELLOW_HOURS;
                  const isOk = restHours != null && !isRed && !isYellow;

                  return (
                    <tr key={t.tail} className="border-t hover:bg-gray-50">
                      <td className="px-4 py-2.5 font-mono font-semibold text-gray-900">
                        {t.tail}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {t.lastLanding ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono">
                              {fmt(t.lastLanding, t.lastLandingIcao)}
                            </span>
                            <span className={`px-1 py-0.5 text-[9px] font-medium rounded ${sourceBadgeClass(t.lastLandingSource)}`}>
                              {sourceLabel(t.lastLandingSource)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-400">--</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {t.nextDeparture ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono">
                              {fmt(t.nextDeparture, t.nextDepartureIcao)}
                            </span>
                            <span className={`px-1 py-0.5 text-[9px] font-medium rounded ${sourceBadgeClass(t.nextDepartureSource)}`}>
                              {sourceLabel(t.nextDepartureSource)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-400">--</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {t.restMinutes != null ? (
                          <span
                            className={`font-mono font-medium ${
                              isRed ? "text-red-700" : isYellow ? "text-amber-700" : "text-gray-700"
                            }`}
                          >
                            {fmtDuration(t.restMinutes)}
                          </span>
                        ) : (
                          <span className="text-gray-400">--</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isRed && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                            Insufficient Rest
                          </span>
                        )}
                        {isYellow && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                            Marginal
                          </span>
                        )}
                        {isOk && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            OK
                          </span>
                        )}
                        {restHours == null && (
                          <span className="text-xs text-gray-400">
                            No upcoming rest
                          </span>
                        )}
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
