"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import type { Flight, MxNote } from "@/lib/opsApi";
import type { VanZone } from "@/lib/maintenanceData";
import {
  computeZoneItems,
  greedySort,
  buildItemFromFlight,
  fmtDriveTime,
  fmtUtcHM,
  fmtTimeUntil,
  inferFlightType,
  getFilterCategory,
  isOnEtDate,
  getEffectiveArrival,
  routeDistKm,
  type VanFlightItem,
  type FlightInfoEntry,
} from "@/lib/vanUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayEtDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Flight type to readable badge label */
function flightTypeBadge(flight: Flight): { label: string; color: string } {
  const ft = inferFlightType(flight);
  const cat = getFilterCategory(ft);
  switch (cat) {
    case "charter":
      return { label: ft ?? "Revenue", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" };
    case "positioning":
      return { label: ft ?? "Positioning", color: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200" };
    case "maintenance":
      return { label: "Maintenance", color: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" };
    default:
      return { label: ft ?? "Other", color: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200" };
  }
}

/** Derive status info from FA data + scheduled times */
function getFlightStatus(
  item: VanFlightItem,
  fi: FlightInfoEntry | undefined,
): { label: string; accent: string; borderColor: string } {
  if (fi?.diverted) {
    return { label: "DIVERTED", accent: "text-red-600 dark:text-red-400", borderColor: "border-l-red-500" };
  }
  if (fi?.status === "Landed" || fi?.status === "Arrived") {
    return { label: "Landed", accent: "text-green-600 dark:text-green-400", borderColor: "border-l-green-500" };
  }
  if (fi?.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100) {
    return {
      label: `En Route (${fi.progress_percent}%)`,
      accent: "text-blue-600 dark:text-blue-400",
      borderColor: "border-l-blue-500",
    };
  }
  if (fi?.status === "En Route" || fi?.status === "Airborne") {
    return { label: "En Route", accent: "text-blue-600 dark:text-blue-400", borderColor: "border-l-blue-500" };
  }

  // Check for delays (scheduled vs FA arrival)
  const schedArr = item.arrFlight.scheduled_arrival;
  const faArr = fi?.arrival_time;
  if (schedArr && faArr) {
    const diffMin = (new Date(faArr).getTime() - new Date(schedArr).getTime()) / 60000;
    if (diffMin > 30) {
      return { label: `Delayed +${Math.round(diffMin)}m`, accent: "text-red-600 dark:text-red-400", borderColor: "border-l-red-500" };
    }
    if (diffMin > 15) {
      return { label: `Delayed +${Math.round(diffMin)}m`, accent: "text-amber-600 dark:text-amber-400", borderColor: "border-l-amber-500" };
    }
  }

  return { label: "Scheduled", accent: "text-gray-500 dark:text-gray-400", borderColor: "border-l-gray-300 dark:border-l-gray-600" };
}

/** Turn status for an item */
function getTurnLabel(item: VanFlightItem): string | null {
  if (!item.nextDep) return "Done for day";
  const schedDep = item.nextDep.scheduled_departure;
  const schedArr = item.arrFlight.scheduled_arrival;
  if (schedArr && schedDep) {
    const groundMin = (new Date(schedDep).getTime() - new Date(schedArr).getTime()) / 60000;
    if (groundMin < 120) return "Quickturn";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VanDriverClient({
  vanId,
  zone,
  initialFlights,
  publishedFlightIds,
  publishedAt,
  mxNotes,
}: {
  vanId: number;
  zone: VanZone;
  initialFlights: Flight[];
  publishedFlightIds: string[] | null;
  publishedAt: string | null;
  mxNotes?: MxNote[];
}) {
  const [flights, setFlights] = useState<Flight[]>(initialFlights);
  const [flightInfoMap, setFlightInfoMap] = useState<Map<string, FlightInfoEntry>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [, setTick] = useState(0); // force re-render for countdowns

  // ---------------------------------------------------------------------------
  // Fetch FlightAware data
  // ---------------------------------------------------------------------------
  const fetchFlightInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/flights");
      if (!res.ok) return;
      const data = await res.json();
      const entries: FlightInfoEntry[] = data.flights ?? data ?? [];
      const map = new Map<string, FlightInfoEntry>();
      for (const e of entries) {
        if (e.tail) map.set(e.tail, e);
      }
      setFlightInfoMap(map);
      setLastRefresh(new Date());
    } catch {
      // silently fail — FA data is supplemental
    }
  }, []);

  // Refresh flights from API
  const refreshFlights = useCallback(async () => {
    setRefreshing(true);
    try {
      const now = new Date();
      const past = new Date(now.getTime() - 12 * 3600000).toISOString();
      const future = new Date(now.getTime() + 36 * 3600000).toISOString();
      const url = `/api/flights?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.flights) setFlights(data.flights);
      }
    } catch {
      // keep existing data
    }
    setRefreshing(false);
  }, []);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    fetchFlightInfo();
    const interval = setInterval(() => {
      fetchFlightInfo();
      refreshFlights();
    }, 300_000);
    return () => clearInterval(interval);
  }, [fetchFlightInfo, refreshFlights]);

  // Tick every 30s for countdown updates
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  // ---------------------------------------------------------------------------
  // Compute stops
  // ---------------------------------------------------------------------------
  const date = todayEtDate();

  const stops = useMemo(() => {
    if (publishedFlightIds && publishedFlightIds.length > 0) {
      // Use Director's published schedule — preserve ordering
      const items: VanFlightItem[] = [];
      for (const fId of publishedFlightIds) {
        const item = buildItemFromFlight(fId, flights, zone.lat, zone.lon);
        if (item) items.push(item);
      }
      return items;
    }
    // Fallback: auto-compute
    const items = computeZoneItems(zone, flights, date, zone.lat, zone.lon);
    return greedySort(items, zone.lat, zone.lon);
  }, [zone, flights, date, publishedFlightIds]);

  const totalRouteKm = useMemo(() => routeDistKm(stops), [stops]);

  const mxNotesByTail = useMemo(() => {
    const map = new Map<string, MxNote[]>();
    for (const n of mxNotes ?? []) {
      if (!n.tail_number) continue;
      const arr = map.get(n.tail_number) ?? [];
      arr.push(n);
      map.set(n.tail_number, arr);
    }
    return map;
  }, [mxNotes]);

  // Find the "next" stop — first non-landed
  const nextStopIdx = useMemo(() => {
    for (let i = 0; i < stops.length; i++) {
      const tail = stops[i].arrFlight.tail_number;
      const fi = tail ? flightInfoMap.get(tail) : undefined;
      const status = fi?.status;
      if (status !== "Landed" && status !== "Arrived") return i;
    }
    return stops.length > 0 ? 0 : -1;
  }, [stops, flightInfoMap]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="max-w-lg mx-auto px-4 py-4">
      {/* Van info header */}
      <div className="mb-4">
        <h1 className="text-xl font-bold text-slate-800 dark:text-white">
          Van {vanId} &mdash; {zone.name}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {zone.city} &middot; {zone.homeAirport}
        </p>
      </div>

      {/* Refresh indicator */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-gray-400 dark:text-gray-500">
          Updated {lastRefresh.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET
        </span>
        <button
          onClick={() => { refreshFlights(); fetchFlightInfo(); }}
          disabled={refreshing}
          className="text-xs text-blue-600 dark:text-blue-400 font-medium min-h-[48px] min-w-[48px] flex items-center justify-center"
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* Published schedule banner */}
      {publishedAt && publishedFlightIds && publishedFlightIds.length > 0 && (
        <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-2.5 mb-4 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block flex-shrink-0" />
          <span className="text-sm text-blue-700 dark:text-blue-300 font-medium">
            Schedule set by Director &middot; {new Date(publishedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET
          </span>
        </div>
      )}

      {/* Hero card — next stop */}
      {nextStopIdx >= 0 && stops[nextStopIdx] && (
        <NextStopHero
          item={stops[nextStopIdx]}
          fi={stops[nextStopIdx].arrFlight.tail_number
            ? flightInfoMap.get(stops[nextStopIdx].arrFlight.tail_number!)
            : undefined}
          flightInfoMap={flightInfoMap}
        />
      )}

      {/* Route summary */}
      {stops.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 mb-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {stops.length} stop{stops.length !== 1 ? "s" : ""} today
            </span>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {fmtDriveTime(totalRouteKm)} total
            </span>
          </div>
        </div>
      )}

      {/* Stop list */}
      {stops.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 px-6 py-12 text-center shadow-sm">
          <p className="text-gray-500 dark:text-gray-400 text-lg">No assignments today</p>
          <p className="text-gray-400 dark:text-gray-500 text-sm mt-2">Check back later for updates</p>
        </div>
      ) : (
        <div className="space-y-3">
          {stops.map((item, idx) => (
            <StopCard
              key={item.arrFlight.id}
              item={item}
              index={idx}
              isNext={idx === nextStopIdx}
              fi={item.arrFlight.tail_number
                ? flightInfoMap.get(item.arrFlight.tail_number)
                : undefined}
              flightInfoMap={flightInfoMap}
              tailMxNotes={mxNotesByTail.get(item.arrFlight.tail_number ?? "") ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero card for next stop
// ---------------------------------------------------------------------------

function NextStopHero({
  item,
  fi,
  flightInfoMap,
}: {
  item: VanFlightItem;
  fi: FlightInfoEntry | undefined;
  flightInfoMap: Map<string, FlightInfoEntry>;
}) {
  const tail = item.arrFlight.tail_number ?? "TBD";
  const dep = item.arrFlight.departure_icao?.replace(/^K/, "") ?? "???";
  const arr = item.airport;
  const status = getFlightStatus(item, fi);
  const effectiveArr = getEffectiveArrival(item, flightInfoMap);
  const countdown = effectiveArr ? fmtTimeUntil(effectiveArr) : "";
  const arrTime = effectiveArr ? fmtUtcHM(effectiveArr) : "\u2014";

  const navUrl = item.airportInfo
    ? `https://www.google.com/maps/dir/?api=1&destination=${item.airportInfo.lat},${item.airportInfo.lon}`
    : null;

  return (
    <div className={`bg-white dark:bg-gray-800 rounded-xl border-2 border-blue-200 dark:border-blue-800 px-5 py-5 mb-4 shadow-md`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">
          Next Stop
        </span>
        <span className={`text-sm font-semibold ${status.accent}`}>
          {status.label}
        </span>
      </div>

      <div className="flex items-baseline gap-3 mb-1">
        <span className="text-2xl font-bold font-mono text-slate-800 dark:text-white">
          {tail}
        </span>
        <span className="text-base text-gray-500 dark:text-gray-400">
          {dep} &rarr; {arr}
        </span>
      </div>

      <div className="flex items-center gap-4 mb-4">
        {countdown && (
          <span className="text-lg font-semibold text-blue-700 dark:text-blue-300">
            Landing {countdown}
          </span>
        )}
        {!countdown && effectiveArr && (
          <span className="text-lg text-gray-600 dark:text-gray-400">
            ETA {arrTime}
          </span>
        )}
        <span className="text-sm text-gray-400 dark:text-gray-500">
          {fmtDriveTime(item.distKm)}
        </span>
      </div>

      {navUrl && (
        <a
          href={navUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full text-center bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold py-4 rounded-xl text-base transition-colors min-h-[56px] flex items-center justify-center"
        >
          Navigate to {arr}
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual stop card
// ---------------------------------------------------------------------------

function StopCard({
  item,
  index,
  isNext,
  fi,
  flightInfoMap,
  tailMxNotes,
}: {
  item: VanFlightItem;
  index: number;
  isNext: boolean;
  fi: FlightInfoEntry | undefined;
  flightInfoMap: Map<string, FlightInfoEntry>;
  tailMxNotes: MxNote[];
}) {
  const tail = item.arrFlight.tail_number ?? "TBD";
  const dep = item.arrFlight.departure_icao?.replace(/^K/, "") ?? "???";
  const arr = item.airport;
  const status = getFlightStatus(item, fi);
  const effectiveArr = getEffectiveArrival(item, flightInfoMap);
  const countdown = effectiveArr ? fmtTimeUntil(effectiveArr) : "";
  const arrTime = effectiveArr ? fmtUtcHM(effectiveArr) : "\u2014";
  const badge = flightTypeBadge(item.arrFlight);
  const turnLabel = getTurnLabel(item);

  const navUrl = item.airportInfo
    ? `https://www.google.com/maps/dir/?api=1&destination=${item.airportInfo.lat},${item.airportInfo.lon}`
    : null;

  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden border-l-4 ${status.borderColor} ${
        isNext ? "ring-2 ring-blue-300 dark:ring-blue-700" : ""
      }`}
    >
      <div className="px-4 py-4">
        {/* Top row: index + tail + status */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-400 dark:text-gray-500 w-5 text-center">
              {index + 1}
            </span>
            <span className="text-xl font-bold font-mono text-slate-800 dark:text-white">
              {tail}
            </span>
          </div>
          <span className={`text-sm font-semibold ${status.accent}`}>
            {status.label}
          </span>
        </div>

        {/* Route */}
        <div className="flex items-center gap-2 mb-2 ml-7">
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {dep} &rarr; {arr}
          </span>
          {item.airportInfo && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              ({item.airportInfo.name})
            </span>
          )}
        </div>

        {/* Time info */}
        <div className="flex items-center gap-3 mb-3 ml-7 flex-wrap">
          {countdown ? (
            <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
              Landing {countdown}
            </span>
          ) : (
            <span className="text-sm text-gray-500 dark:text-gray-400">
              ETA {arrTime}
            </span>
          )}
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {fmtDriveTime(item.distKm)}
          </span>
        </div>

        {/* Badges row */}
        <div className="flex items-center gap-2 ml-7 flex-wrap">
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${badge.color}`}>
            {badge.label}
          </span>
          {turnLabel && (
            <span
              className={`text-xs px-2 py-1 rounded-full font-medium ${
                turnLabel === "Quickturn"
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                  : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
              }`}
            >
              {turnLabel}
            </span>
          )}
          {fi?.diverted && (
            <span className="text-xs px-2 py-1 rounded-full font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
              DIVERTED
            </span>
          )}
        </div>

        {/* MX notes */}
        {tailMxNotes.length > 0 && (
          <div className="ml-7 mt-3 space-y-1.5">
            {tailMxNotes.map((n) => (
              <div key={n.id} className="bg-orange-50 dark:bg-orange-900/30 border border-orange-200 dark:border-orange-800 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-orange-600 dark:text-orange-400 font-bold text-xs shrink-0">MX</span>
                  <span className="text-xs font-medium text-orange-700 dark:text-orange-300">{n.airport_icao}</span>
                  <span className="text-sm text-gray-700 dark:text-gray-300">{n.body}</span>
                </div>
                {n.start_time && (
                  <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                    {new Date(n.start_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    {n.end_time && n.end_time !== n.start_time && ` – ${new Date(n.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Navigate button */}
        {navUrl && (
          <a
            href={navUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 ml-7 inline-flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 min-h-[48px] min-w-[48px]"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Navigate
          </a>
        )}
      </div>
    </div>
  );
}
