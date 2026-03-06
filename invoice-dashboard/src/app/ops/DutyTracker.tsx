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

/* ── Types ──────────────────────────────────────────── */

type LegInfo = {
  departure_icao: string | null;
  arrival_icao: string | null;
  scheduled_departure: string;
  scheduled_arrival: string | null;
  actual_departure: string | null;
  actual_arrival: string | null;
  estimated_arrival: string | null;
  durationMin: number;
};

type TailFlightTime = {
  tail: string;
  maxRolling24hrMin: number;
  legs: LegInfo[];
};

type TailCrewRest = {
  tail: string;
  lastLanding: string | null;
  lastLandingIcao: string | null;
  nextDeparture: string | null;
  nextDepartureIcao: string | null;
  restMinutes: number | null;
};

/* ── Helpers ──────────────────────────────────────────── */

function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

/**
 * Given a sorted list of (start, end) intervals within a 24-hour context,
 * compute the maximum total flight time across all rolling 24-hour windows.
 *
 * We use the "sliding window anchored at each event start" approach:
 * for each leg start time, sum all leg durations that overlap the
 * [start, start + 24h] window.
 */
function computeMaxRolling24hr(
  legs: { startMs: number; endMs: number }[]
): number {
  if (legs.length === 0) return 0;

  const WINDOW_MS = 24 * 60 * 60 * 1000;
  let maxTotalMs = 0;

  // Anchor the window start at each leg's start time, and also at
  // (each leg's end time - 24h) to catch all boundary cases.
  const anchors = new Set<number>();
  for (const leg of legs) {
    anchors.add(leg.startMs);
    anchors.add(leg.endMs - WINDOW_MS);
  }

  for (const windowStart of anchors) {
    const windowEnd = windowStart + WINDOW_MS;
    let totalMs = 0;

    for (const leg of legs) {
      // Clamp leg to window boundaries
      const overlapStart = Math.max(leg.startMs, windowStart);
      const overlapEnd = Math.min(leg.endMs, windowEnd);
      if (overlapEnd > overlapStart) {
        totalMs += overlapEnd - overlapStart;
      }
    }

    if (totalMs > maxTotalMs) maxTotalMs = totalMs;
  }

  return maxTotalMs / 60_000; // convert to minutes
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
      // Also store by tail-only for fallback
      if (!map.has(fi.tail) || (fi.latitude != null && fi.longitude != null)) {
        map.set(fi.tail, fi);
      }
    }
    return map;
  }, [faData]);

  /* ── Build enriched leg data per tail ── */
  const legsByTail = useMemo(() => {
    const result = new Map<string, LegInfo[]>();
    const now = Date.now();

    for (const f of flights) {
      if (!f.tail_number) continue;

      const routeKey = `${f.tail_number}|${f.departure_icao ?? ""}|${f.arrival_icao ?? ""}`;
      const fi = faMap.get(routeKey);

      const actualDep = fi?.actual_departure ?? null;
      const actualArr = fi?.actual_arrival ?? null;
      const estimatedArr = fi?.arrival_time ?? null;

      // Determine best departure time
      const depIso = actualDep ?? f.scheduled_departure;
      const depMs = new Date(depIso).getTime();

      // Determine best arrival time
      const arrIso = actualArr ?? estimatedArr ?? f.scheduled_arrival;
      const arrMs = arrIso ? new Date(arrIso).getTime() : null;

      let durationMin: number;
      if (actualArr) {
        // Completed flight
        durationMin = (new Date(actualArr).getTime() - depMs) / 60_000;
      } else if (actualDep && !actualArr) {
        // In-flight: duration = now - actual departure
        durationMin = (now - new Date(actualDep).getTime()) / 60_000;
      } else if (arrMs) {
        // Scheduled: use estimated/scheduled arrival
        durationMin = (arrMs - depMs) / 60_000;
      } else {
        durationMin = 0;
      }

      // Discard invalid durations
      if (durationMin < 0) durationMin = 0;

      const leg: LegInfo = {
        departure_icao: f.departure_icao,
        arrival_icao: f.arrival_icao,
        scheduled_departure: f.scheduled_departure,
        scheduled_arrival: f.scheduled_arrival,
        actual_departure: actualDep,
        actual_arrival: actualArr,
        estimated_arrival: estimatedArr,
        durationMin,
      };

      if (!result.has(f.tail_number)) {
        result.set(f.tail_number, []);
      }
      result.get(f.tail_number)!.push(leg);
    }

    // Sort legs by departure time within each tail
    for (const legs of result.values()) {
      legs.sort(
        (a, b) =>
          new Date(a.actual_departure ?? a.scheduled_departure).getTime() -
          new Date(b.actual_departure ?? b.scheduled_departure).getTime(),
      );
    }

    return result;
  }, [flights, faMap]);

  /* ── Feature 1: Rolling 24hr flight time per tail ── */
  const flightTimeData = useMemo((): TailFlightTime[] => {
    const result: TailFlightTime[] = [];

    for (const [tail, legs] of legsByTail) {
      const now = Date.now();
      const intervals = legs
        .filter((l) => l.durationMin > 0)
        .map((l) => {
          const depIso = l.actual_departure ?? l.scheduled_departure;
          const startMs = new Date(depIso).getTime();
          let endMs: number;
          if (l.actual_arrival) {
            endMs = new Date(l.actual_arrival).getTime();
          } else if (l.actual_departure && !l.actual_arrival) {
            endMs = now; // in-flight
          } else {
            endMs = startMs + l.durationMin * 60_000;
          }
          return { startMs, endMs };
        })
        .sort((a, b) => a.startMs - b.startMs);

      const maxMin = computeMaxRolling24hr(intervals);

      result.push({
        tail,
        maxRolling24hrMin: maxMin,
        legs,
      });
    }

    // Sort: highest flight time first
    result.sort((a, b) => b.maxRolling24hrMin - a.maxRolling24hrMin);
    return result;
  }, [legsByTail]);

  /* ── Feature 2: Crew rest per tail ── */
  const crewRestData = useMemo((): TailCrewRest[] => {
    const result: TailCrewRest[] = [];
    const now = Date.now();

    for (const [tail, legs] of legsByTail) {
      // Find the most recent landing (actual or scheduled) that is in the past
      let lastLanding: string | null = null;
      let lastLandingIcao: string | null = null;

      for (const leg of legs) {
        const arrIso = leg.actual_arrival ?? leg.scheduled_arrival;
        if (arrIso && new Date(arrIso).getTime() <= now) {
          // This is a past arrival — take the latest one
          if (!lastLanding || new Date(arrIso).getTime() > new Date(lastLanding).getTime()) {
            lastLanding = arrIso;
            lastLandingIcao = leg.arrival_icao;
          }
        }
      }

      // Find the next scheduled departure (in the future)
      let nextDeparture: string | null = null;
      let nextDepartureIcao: string | null = null;

      for (const leg of legs) {
        const depIso = leg.actual_departure ?? leg.scheduled_departure;
        if (new Date(depIso).getTime() > now) {
          if (!nextDeparture || new Date(depIso).getTime() < new Date(nextDeparture).getTime()) {
            nextDeparture = depIso;
            nextDepartureIcao = leg.departure_icao;
          }
        }
      }

      let restMinutes: number | null = null;
      if (lastLanding && nextDeparture) {
        restMinutes =
          (new Date(nextDeparture).getTime() - new Date(lastLanding).getTime()) / 60_000;
      }

      result.push({
        tail,
        lastLanding,
        lastLandingIcao,
        nextDeparture,
        nextDepartureIcao,
        restMinutes,
      });
    }

    // Sort: shortest rest first (most critical at top), nulls at bottom
    result.sort((a, b) => {
      if (a.restMinutes == null && b.restMinutes == null) return 0;
      if (a.restMinutes == null) return 1;
      if (b.restMinutes == null) return -1;
      return a.restMinutes - b.restMinutes;
    });

    return result;
  }, [legsByTail]);

  /* ── Alert counts for summary bar ── */
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
            {legsByTail.size} tail{legsByTail.size !== 1 ? "s" : ""} tracked
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
                <th className="px-4 py-3">Max 24hr Flight Time</th>
                <th className="px-4 py-3 w-48">Status</th>
                <th className="px-4 py-3">Legs Breakdown</th>
              </tr>
            </thead>
            <tbody>
              {flightTimeData.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-8 text-center text-gray-400"
                  >
                    No flight data available
                  </td>
                </tr>
              ) : (
                flightTimeData.map((t) => {
                  const isRed = t.maxRolling24hrMin >= FLIGHT_TIME_RED_MIN;
                  const isYellow =
                    !isRed && t.maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN;
                  const pct = Math.min(
                    (t.maxRolling24hrMin / (MAX_DUTY_HOURS_SCALE * 60)) * 100,
                    100,
                  );

                  let barColor = "bg-blue-500";
                  if (isRed) barColor = "bg-red-500";
                  else if (isYellow) barColor = "bg-amber-500";

                  return (
                    <tr key={t.tail} className="border-t hover:bg-gray-50">
                      <td className="px-4 py-2.5 font-mono font-semibold text-gray-900">
                        {t.tail}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-mono font-medium ${
                              isRed
                                ? "text-red-700"
                                : isYellow
                                  ? "text-amber-700"
                                  : "text-gray-700"
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
                        <div className="flex flex-wrap gap-1.5">
                          {t.legs
                            .filter((l) => l.durationMin > 0)
                            .map((leg, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-gray-100 text-gray-600"
                                title={`${leg.departure_icao ?? "?"} - ${leg.arrival_icao ?? "?"}: ${fmtDuration(leg.durationMin)}`}
                              >
                                <span className="font-mono font-medium">
                                  {leg.departure_icao ?? "?"}-
                                  {leg.arrival_icao ?? "?"}
                                </span>
                                <span className="text-gray-400">
                                  {fmtDuration(leg.durationMin)}
                                </span>
                              </span>
                            ))}
                          {t.legs.filter((l) => l.durationMin > 0).length ===
                            0 && (
                            <span className="text-xs text-gray-400">
                              No completed legs
                            </span>
                          )}
                        </div>
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
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-gray-400"
                  >
                    No flight data available
                  </td>
                </tr>
              ) : (
                crewRestData.map((t) => {
                  const restHours =
                    t.restMinutes != null ? t.restMinutes / 60 : null;
                  const isRed =
                    restHours != null && restHours < REST_RED_HOURS;
                  const isYellow =
                    restHours != null &&
                    !isRed &&
                    restHours < REST_YELLOW_HOURS;
                  const isOk = restHours != null && !isRed && !isYellow;

                  return (
                    <tr key={t.tail} className="border-t hover:bg-gray-50">
                      <td className="px-4 py-2.5 font-mono font-semibold text-gray-900">
                        {t.tail}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {t.lastLanding ? (
                          <span className="font-mono">
                            {fmt(t.lastLanding, t.lastLandingIcao)}
                          </span>
                        ) : (
                          <span className="text-gray-400">--</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {t.nextDeparture ? (
                          <span className="font-mono">
                            {fmt(t.nextDeparture, t.nextDepartureIcao)}
                          </span>
                        ) : (
                          <span className="text-gray-400">--</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {t.restMinutes != null ? (
                          <span
                            className={`font-mono font-medium ${
                              isRed
                                ? "text-red-700"
                                : isYellow
                                  ? "text-amber-700"
                                  : "text-gray-700"
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
                            No upcoming leg
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
