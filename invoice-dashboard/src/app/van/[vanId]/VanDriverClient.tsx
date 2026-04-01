"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import type { Flight, MxNote } from "@/lib/opsApi";
import type { VanZone } from "@/lib/maintenanceData";

const DAY = 86_400_000;
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
  getAirportInfo,
  haversineKm,
  isOnEtDate as isOnVanScheduleDate,
  isPositioningFlight,
  type VanFlightItem,
  type FlightInfoEntry,
} from "@/lib/vanUtils";
import { getAirportTimezone } from "@/lib/airportTimezones";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayEtDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Format arrival time with day name: "Mon 9:30 PM" — for overnight items. */
function fmtArrWithDay(iso: string, airportIcao: string | null | undefined): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const tz = getAirportTimezone(airportIcao) ?? "America/New_York";
  const day = d.toLocaleDateString("en-US", { weekday: "short", timeZone: tz });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
  return `${day} ${time}`;
}

/** Format an ISO time in the airport's local timezone as "2:30 PM EDT". */
function fmtLocalTime(iso: string | null | undefined, airportIcao: string | null | undefined): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "\u2014";
  const tz = getAirportTimezone(airportIcao) ?? "America/New_York";
  try {
    const timePart = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz,
    });
    const tzAbbr = d
      .toLocaleString("en-US", { timeZoneName: "short", timeZone: tz })
      .split(" ")
      .pop() ?? "";
    return `${timePart} ${tzAbbr}`;
  } catch {
    return fmtUtcHM(iso);
  }
}

/** Match best FA flight to a specific van leg by route (origin→dest + tail). */
function matchFaFlight(
  allEntries: FlightInfoEntry[],
  flight: Flight,
): FlightInfoEntry | undefined {
  const tail = flight.tail_number;
  if (!tail) return undefined;
  const depIcao = flight.departure_icao;
  const arrIcao = flight.arrival_icao;
  const schedDep = flight.scheduled_departure ? new Date(flight.scheduled_departure).getTime() : null;
  // Normalize airport codes: strip K-prefix, handle ICAO aliases (TJSJ↔KSJU etc.)
  const ICAO_TO_FAA: Record<string, string> = {
    TJSJ: "SJU", TJBQ: "BQN", TJIG: "SIG", TIST: "STT", TISX: "STX",
    MMUN: "CUN", MMMX: "MEX", MMSD: "SJD",
  };
  const norm = (c: string | null | undefined): string | null => {
    if (!c) return null;
    const u = c.trim().toUpperCase();
    // Check alias map first
    if (ICAO_TO_FAA[u]) return ICAO_TO_FAA[u];
    // Strip K-prefix for US airports
    if (u.length === 4 && u.startsWith("K")) return u.slice(1);
    // For 4-char codes, try last 3 chars as IATA
    return u;
  };
  const nDep = norm(depIcao);
  const nArr = norm(arrIcao);

  // Time window limits to prevent matching stale FA flights from previous days
  const HOURS_6 = 6 * 3600_000;
  const HOURS_4 = 4 * 3600_000;

  // Helper: pick the closest-in-time entry from a list, with optional max time window
  function pickClosest(
    candidates: FlightInfoEntry[],
    maxDiffMs?: number,
  ): FlightInfoEntry | undefined {
    if (candidates.length === 0) return undefined;
    if (!schedDep) return candidates.length === 1 ? candidates[0] : undefined;
    let best: FlightInfoEntry | undefined;
    let bestDiff = Infinity;
    for (const c of candidates) {
      const faDep = c.departure_time ? new Date(c.departure_time).getTime() : null;
      const diff = faDep ? Math.abs(faDep - schedDep) : Infinity;
      if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    // Reject if outside the allowed time window
    if (maxDiffMs && bestDiff > maxDiffMs) return undefined;
    return best;
  }

  // Find all FA flights for this tail
  const tailFlights = allEntries.filter((e) => e.tail === tail);
  if (tailFlights.length === 0) return undefined;

  // PRIORITY 1: Exact route match (origin + destination) — most reliable, allow wide window
  const routeMatches = tailFlights.filter((e) =>
    nDep && norm(e.origin_icao) === nDep && (!nArr || norm(e.destination_icao) === nArr)
  );
  const routeHit = pickClosest(routeMatches);
  if (routeHit) return routeHit;

  // PRIORITY 2: Origin-only match — require within 6h of scheduled departure
  const originMatches = tailFlights.filter((e) => nDep && norm(e.origin_icao) === nDep);
  const originHit = pickClosest(originMatches, HOURS_6);
  if (originHit) return originHit;

  // PRIORITY 3: Destination-only match — weakest signal, require within 4h AND
  // only accept if the FA flight is currently en route (not a stale landed flight)
  const destMatches = tailFlights.filter((e) => nArr && norm(e.destination_icao) === nArr);
  const destEnRoute = destMatches.filter((e) =>
    e.status === "En Route" || e.status === "Airborne" ||
    (e.progress_percent != null && e.progress_percent > 0 && e.progress_percent < 100)
  );
  const destHit = pickClosest(destEnRoute, HOURS_4);
  if (destHit) return destHit;

  // No reliable match — don't guess
  return undefined;
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
      label: "En Route",
      accent: "text-blue-600 dark:text-blue-400",
      borderColor: "border-l-blue-500",
    };
  }
  if (fi?.status === "En Route" || fi?.status === "Airborne") {
    return { label: "En Route", accent: "text-blue-600 dark:text-blue-400", borderColor: "border-l-blue-500" };
  }

  // If scheduled arrival is in the past and FA doesn't show en route, treat as landed
  const schedArr = item.arrFlight.scheduled_arrival;
  if (schedArr && new Date(schedArr).getTime() < Date.now()) {
    return { label: "Landed", accent: "text-green-600 dark:text-green-400", borderColor: "border-l-green-500" };
  }

  // Check for delays (scheduled vs FA arrival) — only for non-landed flights
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

/** Turn status label for an item */
function getTurnLabel(item: VanFlightItem, fmtDepTime?: (iso: string) => string): string {
  const schedArr = item.arrFlight.scheduled_arrival;
  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const arrDate = schedArr
    ? new Date(schedArr).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
    : null;
  const isOvernight = arrDate ? arrDate < todayEt : false;

  const fmt = fmtDepTime ?? fmtUtcHM;

  // Detect pre-departure: service airport matches a departure, not the arrival
  const arrIcaoNorm = item.arrFlight.arrival_icao?.replace(/^K/, "") ?? "";
  if (item.airport !== arrIcaoNorm && item.nextDep?.departure_icao?.replace(/^K/, "") === item.airport) {
    const depTime = fmt(item.nextDep.scheduled_departure);
    return `Pre-Departure - Departing at ${depTime}`;
  }

  if (!item.nextDep) {
    return isOvernight ? "Parked - No flights scheduled" : "Done for the Day";
  }

  const schedDep = item.nextDep.scheduled_departure;
  if (!schedArr || !schedDep) return "Done for the Day";

  // For overnight aircraft, use time from NOW until departure
  if (isOvernight) {
    const depMs = new Date(schedDep).getTime();
    const hoursUntilDep = Math.round((depMs - Date.now()) / 3600000);
    const depTime = fmt(schedDep);
    const depDate = new Date(schedDep).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (depDate === todayEt && hoursUntilDep < 2) {
      return `Parked - Departing soon at ${depTime}`;
    }
    if (depDate === todayEt) {
      return `Parked - Departing at ${depTime}`;
    }
    return `Parked - Next flight in ${hoursUntilDep} hour${hoursUntilDep === 1 ? "" : "s"}`;
  }

  const gapMs = new Date(schedDep).getTime() - new Date(schedArr).getTime();
  const hours = Math.round(gapMs / 3600000);
  if (gapMs < 2 * 3600000) {
    const depTime = fmt(schedDep);
    return `Quick Turn - Aircraft leaving after ${depTime}`;
  }
  if (gapMs < 8 * 3600000) {
    return `Aircraft Shutting Down - Aircraft leaving in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `Done for the Day - Aircraft leaving in ${hours} hour${hours === 1 ? "" : "s"}`;
}

function turnBadgeClass(label: string): string {
  if (label.startsWith("Pre-Departure")) return "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200";
  if (label.startsWith("Quick Turn")) return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200";
  if (label.startsWith("Aircraft Shutting Down")) return "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200";
  if (label.includes("Departing soon")) return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200";
  if (label.startsWith("Parked")) return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
  return "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300";
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
  syntheticFlights,
  mxNotes,
  fboMap,
  airportOverrides,
}: {
  vanId: number;
  zone: VanZone;
  initialFlights: Flight[];
  publishedFlightIds: string[] | null;
  publishedAt: string | null;
  syntheticFlights?: { id: string; tail: string; airport: string | null }[];
  mxNotes?: MxNote[];
  fboMap?: Record<string, string>;
  airportOverrides?: [string, string][];
}) {
  /** Look up destination FBO for a flight from trip_salespersons data */
  const lookupFbo = useCallback((f: Flight): string | null => {
    if (!fboMap || !f.tail_number || !f.arrival_icao) return null;
    return fboMap[`${f.tail_number}:${f.arrival_icao}`] ?? null;
  }, [fboMap]);

  const date = todayEtDate();
  const [flights, setFlights] = useState<Flight[]>(initialFlights);
  const [livePublishedFlightIds, setLivePublishedFlightIds] = useState<string[] | null>(publishedFlightIds);
  const [livePublishedAt, setLivePublishedAt] = useState<string | null>(publishedAt);
  const [liveSyntheticFlights, setLiveSyntheticFlights] = useState(syntheticFlights);
  const [allFlightEntries, setAllFlightEntries] = useState<FlightInfoEntry[]>([]);
  const [flightInfoMap, setFlightInfoMap] = useState<Map<string, FlightInfoEntry>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [, setTick] = useState(0); // force re-render for countdowns
  const [dismissedMxIds, setDismissedMxIds] = useState<Set<string>>(new Set());
  const [liveMxNotes, setLiveMxNotes] = useState<MxNote[]>(mxNotes ?? []);

  const dismissMxNote = useCallback(async (id: string) => {
    setDismissedMxIds((prev) => new Set(prev).add(id));
    try {
      await fetch(`/api/ops/alerts/${id}/acknowledge`, { method: "POST" });
    } catch {
      setDismissedMxIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Fetch FlightAware data
  // ---------------------------------------------------------------------------
  const fetchFlightInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/flights");
      if (!res.ok) return;
      const data = await res.json();
      const entries: FlightInfoEntry[] = data.flights ?? data ?? [];
      setAllFlightEntries(entries);
      // Build a simple tail→best-flight map (en-route preferred over scheduled/landed)
      const map = new Map<string, FlightInfoEntry>();
      for (const e of entries) {
        if (!e.tail) continue;
        const existing = map.get(e.tail);
        const eIsEnRoute = e.status?.includes("En Route");
        if (!existing || eIsEnRoute || (!existing.status?.includes("En Route") && !existing.status?.includes("Landed"))) {
          map.set(e.tail, e);
        }
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

  // Refresh MX notes from API (so new notes from admin appear without page reload)
  const refreshMxNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/mx-notes");
      if (res.ok) {
        const data = await res.json();
        if (data.notes) setLiveMxNotes(data.notes);
      }
    } catch { /* keep existing */ }
  }, []);

  // Refresh published schedule (picks up adds/removes by Director without page reload)
  const refreshPublished = useCallback(async () => {
    try {
      const res = await fetch(`/api/vans/publish?date=${date}`);
      if (!res.ok) return;
      const data = await res.json();
      const myAssignment = (data.assignments ?? []).find((a: any) => a.vanId === vanId);
      if (myAssignment) {
        setLivePublishedFlightIds(myAssignment.flightIds);
        setLiveSyntheticFlights(myAssignment.syntheticFlights ?? []);
        if (data.published_at) setLivePublishedAt(data.published_at);
      }
    } catch { /* keep existing */ }
  }, [date, vanId]);

  // Auto-refresh every 5 minutes (flights + FA + MX notes + published schedule)
  useEffect(() => {
    fetchFlightInfo();
    const interval = setInterval(() => {
      fetchFlightInfo();
      refreshFlights();
      refreshMxNotes();
      refreshPublished();
    }, 300_000);
    return () => clearInterval(interval);
  }, [fetchFlightInfo, refreshFlights, refreshMxNotes, refreshPublished]);

  // Tick every 30s for countdown updates
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  // ---------------------------------------------------------------------------
  // Compute stops
  // ---------------------------------------------------------------------------

  const apOverrideMap = useMemo(() => new Map(airportOverrides ?? []), [airportOverrides]);

  // Build a map of synthetic flights for quick lookup
  const syntheticMap = useMemo(() => {
    const map = new Map<string, { id: string; tail: string; airport: string | null }>();
    for (const sf of liveSyntheticFlights ?? []) {
      map.set(sf.id, sf);
    }
    return map;
  }, [liveSyntheticFlights]);

  const stops = useMemo(() => {
    let items: VanFlightItem[];
    if (livePublishedFlightIds && livePublishedFlightIds.length > 0) {
      // Use Director's published schedule — preserve ordering
      items = [];
      for (const fId of livePublishedFlightIds) {
        // Try real flight first
        const item = buildItemFromFlight(fId, flights, zone.lat, zone.lon);
        if (item) {
          items.push(item);
          continue;
        }
        // Try synthetic flight (unscheduled/parked aircraft)
        const sf = syntheticMap.get(fId);
        if (sf && sf.airport) {
          const info = getAirportInfo(sf.airport);
          const distKm = info ? Math.round(haversineKm(zone.lat, zone.lon, info.lat, info.lon)) : 0;
          const syntheticFlight: Flight = {
            id: sf.id,
            ics_uid: sf.id,
            tail_number: sf.tail,
            departure_icao: `K${sf.airport}`,
            arrival_icao: `K${sf.airport}`,
            scheduled_departure: `${date}T17:00:00Z`,
            scheduled_arrival: `${date}T17:00:00Z`,
            summary: `Parked – ${sf.tail}`,
            flight_type: null,
            pic: null,
            sic: null,
            pax_count: null,
            jetinsight_url: null,
            fa_flight_id: null,
            alerts: [],
          };
          items.push({
            arrFlight: syntheticFlight,
            nextDep: null,
            isRepo: false,
            nextIsRepo: false,
            airport: sf.airport,
            airportInfo: info,
            distKm,
          });
        }
      }
    } else {
      // Fallback: auto-compute
      items = computeZoneItems(zone, flights, date, zone.lat, zone.lon);
      items = greedySort(items, zone.lat, zone.lon);
    }
    // Apply airport overrides (e.g. N201HR → VNY instead of raw arrival airport)
    // When overriding, also try to swap to a flight that actually arrives at the
    // override airport so arrival times and timezone display correctly.
    if (apOverrideMap.size > 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const tail = item.arrFlight.tail_number ?? "";
        const raw = apOverrideMap.get(tail);
        if (!raw) continue;
        const overrideAirport = raw.replace(/^K/, "");
        if (overrideAirport === item.airport) continue;
        const info = getAirportInfo(overrideAirport);
        // Try to find a flight that actually arrives at the override airport
        const arrIcaoTarget = `K${overrideAirport}`;
        const betterFlight = flights.find((f) =>
          f.tail_number === tail &&
          (f.arrival_icao === arrIcaoTarget || f.arrival_icao === overrideAirport) &&
          f.scheduled_arrival &&
          isOnVanScheduleDate(f.scheduled_arrival, date)
        );
        if (betterFlight) {
          const nextDep = flights
            .filter((f) => f.tail_number === tail && f.departure_icao === betterFlight.arrival_icao && f.scheduled_departure > (betterFlight.scheduled_arrival ?? ""))
            .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure))[0] ?? null;
          items[i] = {
            arrFlight: betterFlight,
            nextDep,
            isRepo: isPositioningFlight(betterFlight),
            nextIsRepo: nextDep ? isPositioningFlight(nextDep) : false,
            airport: overrideAirport,
            airportInfo: info,
            distKm: info ? Math.round(haversineKm(zone.lat, zone.lon, info.lat, info.lon)) : 0,
          };
        } else {
          item.airport = overrideAirport;
          if (info) {
            item.airportInfo = info;
            item.distKm = Math.round(haversineKm(zone.lat, zone.lon, info.lat, info.lon));
          }
        }
      }
    }
    // Correct overnight item positions using FlightAware actual data.
    // If FA shows the aircraft landed at a different airport more recently
    // than the scheduled arrival, update the displayed position.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const tail = item.arrFlight.tail_number;
      if (!tail) continue;
      const arrDateEt = item.arrFlight.scheduled_arrival
        ? new Date(item.arrFlight.scheduled_arrival).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
        : null;
      if (!arrDateEt || arrDateEt >= date) continue; // only correct overnight items
      const fa = flightInfoMap.get(tail);
      if (!fa?.destination_icao || !(fa.actual_arrival || fa.status?.includes("Landed"))) continue;
      const faIata = fa.destination_icao.replace(/^K/, "");
      if (faIata === item.airport) continue;
      if ((fa.actual_arrival ?? fa.arrival_time ?? "") <= (item.arrFlight.scheduled_arrival ?? "")) continue;
      const info = getAirportInfo(faIata);
      item.airport = faIata;
      item.airportInfo = info;
      item.distKm = info ? Math.round(haversineKm(zone.lat, zone.lon, info.lat, info.lon)) : 0;
      item.nextDep = flights
        .filter((f) => f.tail_number === tail && f.departure_icao?.replace(/^K/, "") === faIata && f.scheduled_departure > new Date().toISOString())
        .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure))[0] ?? null;
      item.nextIsRepo = item.nextDep ? isPositioningFlight(item.nextDep) : false;
    }
    return items;
  }, [zone, flights, date, livePublishedFlightIds, syntheticMap, apOverrideMap, flightInfoMap]);

  const totalRouteKm = useMemo(() => routeDistKm(stops), [stops]);

  const mxNotesByTail = useMemo(() => {
    const map = new Map<string, MxNote[]>();
    for (const n of liveMxNotes) {
      if (!n.tail_number) continue;
      const arr = map.get(n.tail_number) ?? [];
      arr.push(n);
      map.set(n.tail_number, arr);
    }
    return map;
  }, [liveMxNotes]);

  // Find the "next" stop — first non-landed (using same logic as getFlightStatus)
  const nextStopIdx = useMemo(() => {
    for (let i = 0; i < stops.length; i++) {
      const tail = stops[i].arrFlight.tail_number;
      const fi = tail ? matchFaFlight(allFlightEntries, stops[i].arrFlight) : undefined;
      const status = getFlightStatus(stops[i], fi);
      if (status.label !== "Landed") return i;
    }
    return stops.length > 0 ? 0 : -1;
  }, [stops, allFlightEntries]);

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
      {livePublishedAt && livePublishedFlightIds && livePublishedFlightIds.length > 0 && (
        <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-2.5 mb-4 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block flex-shrink-0" />
          <span className="text-sm text-blue-700 dark:text-blue-300 font-medium">
            Schedule set by Director &middot; {new Date(livePublishedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET
          </span>
        </div>
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
                ? matchFaFlight(allFlightEntries, item.arrFlight)
                : undefined}
              flightInfoMap={flightInfoMap}
              tailMxNotes={mxNotesByTail.get(item.arrFlight.tail_number ?? "") ?? []}
              dismissedMxIds={dismissedMxIds}
              onDismissMx={dismissMxNote}
              fbo={lookupFbo(item.arrFlight)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual stop card
// ---------------------------------------------------------------------------

/** MX note card with expandable description */
function MxNoteCard({ note, isMel, now, DAY, onDismiss }: {
  note: MxNote; isMel: boolean; now: number; DAY: number; onDismiss: (id: string) => void;
}) {
  const [descOpen, setDescOpen] = useState(false);
  return (
    <div className={isMel
      ? "bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-lg px-3 py-2"
      : "bg-orange-50 dark:bg-orange-900/30 border border-orange-200 dark:border-orange-800 rounded-lg px-3 py-2"
    }>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`font-bold text-xs shrink-0 ${isMel ? "text-yellow-600 dark:text-yellow-400" : "text-orange-600 dark:text-orange-400"}`}>
          {isMel ? "MEL" : "MX"}
        </span>
        <span className={`text-xs font-medium ${isMel ? "text-yellow-700 dark:text-yellow-300" : "text-orange-700 dark:text-orange-300"}`}>{note.airport_icao}</span>
        <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">{note.body}</span>
        {note.description && (
          <button
            onClick={(e) => { e.stopPropagation(); setDescOpen((v) => !v); }}
            className={`text-xs font-medium min-h-[44px] px-2 ${isMel ? "text-yellow-600 dark:text-yellow-400" : "text-orange-600 dark:text-orange-400"}`}
          >
            {descOpen ? "hide" : "notes"} &#9662;
          </button>
        )}
        {isMel && note.end_time && (() => {
          const ms = new Date(note.end_time).getTime() - now;
          if (ms <= 0) return <span className="text-xs font-semibold text-red-600 dark:text-red-400 shrink-0">EXPIRED</span>;
          const days = Math.ceil(ms / DAY);
          return <span className={`text-xs font-semibold shrink-0 ${days <= 3 ? "text-red-600 dark:text-red-400" : days <= 7 ? "text-amber-600 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"}`}>{days}d left</span>;
        })()}
        <button
          onClick={() => onDismiss(note.id)}
          className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          aria-label="Dismiss MX note"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {descOpen && note.description && (
        <div className="mt-1.5 text-sm text-gray-600 dark:text-gray-300 bg-white/60 dark:bg-gray-700/60 rounded px-2.5 py-1.5 whitespace-pre-wrap">
          {note.description}
        </div>
      )}
      {note.end_time && (
        <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
          Due {new Date(note.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{(() => { const d = new Date(note.end_time); return d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; })()}
        </div>
      )}
    </div>
  );
}

// Per-aircraft-type service checklists (ICAO type code → steps)
const SERVICE_CHECKLISTS: Record<string, { label: string; steps: string[] }> = {
  C750: {
    label: "Citation X",
    steps: [
      "Meet pilots",
      "Check fluids and gases",
      "Stock bag pit",
      "Check tire tread",
      "Check black binder for MELs/open 1008s",
      "Report back here",
      "Clean instruments face plates and panel",
      "Drop pics here",
    ],
  },
  CL30: {
    label: "Challenger 300",
    steps: [
      "Meet pilots",
      "Service ENGs and APU",
      "Empty ecolo bottle",
      "Check tire tread",
      "Check fluids and gases",
      "Check black binder for MELs/open 1008s",
      "Report back here",
      "Clean instruments face plates and panel",
      "Drop pics here",
    ],
  },
};

// Known tail → type mapping
const TAIL_TYPE_MAP: Record<string, string> = {
  // Challenger 300 (CL30)
  N520FX: "CL30", N541FX: "CL30", N533FX: "CL30", N526FX: "CL30",
  N548FX: "CL30", N555FX: "CL30", N554FX: "CL30", N521FX: "CL30",
  N371BD: "CL30", N883TR: "CL30", N416F: "CL30", N519FX: "CL30",
  N552FX: "CL30", N553FX: "CL30", N529FX: "CL30",
  // Cessna Citation X (C750)
  N992MG: "C750", N513JB: "C750", N957JS: "C750", N954JS: "C750",
  N860TX: "C750", N700LH: "C750", N106PC: "C750", N818CF: "C750",
  N733FL: "C750", N988TX: "C750", N703TX: "C750", N910E: "C750",
  N102VR: "C750", N998CX: "C750", N51GB: "C750", N939TX: "C750",
  N301HR: "C750", N971JS: "C750", N125DZ: "C750", N955GH: "C750",
  N125TH: "C750", N201HR: "C750", N187CR: "C750",
};

function getDriverServiceChecklists(): Record<string, { label: string; steps: string[] }> {
  try {
    const saved = typeof window !== "undefined" ? localStorage.getItem("vanServiceChecklists") : null;
    if (saved) return JSON.parse(saved);
  } catch {}
  return SERVICE_CHECKLISTS;
}

function ServiceChecklistAccordion({ label, steps }: { label: string; steps: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border border-green-200 dark:border-green-800 rounded-lg overflow-hidden">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="w-full px-3 py-2 flex items-center justify-between text-sm font-semibold text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/30 min-h-[44px]"
      >
        <span>Service Check — {label}</span>
        <span className="text-green-400">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-3 py-2 bg-white dark:bg-gray-800">
          <ol className="space-y-1 list-decimal list-inside text-sm text-gray-700 dark:text-gray-300">
            {steps.map((step, i) => (
              <li key={i} className="py-0.5">{step}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function StopCard({
  item,
  index,
  isNext,
  fi,
  flightInfoMap,
  tailMxNotes,
  dismissedMxIds,
  onDismissMx,
  fbo,
}: {
  item: VanFlightItem;
  index: number;
  isNext: boolean;
  fi: FlightInfoEntry | undefined;
  flightInfoMap: Map<string, FlightInfoEntry>;
  tailMxNotes: MxNote[];
  dismissedMxIds: Set<string>;
  onDismissMx: (id: string) => void;
  fbo: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const tail = item.arrFlight.tail_number ?? "TBD";
  const dep = item.arrFlight.departure_icao?.replace(/^K/, "") ?? "???";
  const arr = item.airport;
  const status = getFlightStatus(item, fi);
  const effectiveArr = getEffectiveArrival(item, flightInfoMap);
  const countdown = effectiveArr ? fmtTimeUntil(effectiveArr) : "";
  const arrTime = effectiveArr ? fmtLocalTime(effectiveArr, item.arrFlight.arrival_icao) : "\u2014";
  const badge = flightTypeBadge(item.arrFlight);
  const schedArrLocal = fmtLocalTime(item.arrFlight.scheduled_arrival, item.arrFlight.arrival_icao);
  const faEtaLocal = fi?.arrival_time ? fmtLocalTime(fi.arrival_time, item.arrFlight.arrival_icao) : null;
  const turnLabel = getTurnLabel(item, (iso) => fmtLocalTime(iso, item.nextDep?.departure_icao ?? item.arrFlight.arrival_icao));
  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const arrDateEt = item.arrFlight.scheduled_arrival
    ? new Date(item.arrFlight.scheduled_arrival).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
    : null;
  const isOvernight = arrDateEt ? arrDateEt < todayEt : false;

  // Auto-expand when this becomes the next stop
  const prevIsNext = useRef(isNext);
  useEffect(() => {
    if (isNext && !prevIsNext.current) setExpanded(true);
    prevIsNext.current = isNext;
  }, [isNext]);

  const navUrl = fbo && item.airportInfo
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fbo + " " + (item.airportInfo.name ?? item.airport))}`
    : item.airportInfo
      ? `https://www.google.com/maps/dir/?api=1&destination=${item.airportInfo.lat},${item.airportInfo.lon}`
      : null;

  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden border-l-4 ${status.borderColor} ${
        isNext ? "ring-2 ring-blue-300 dark:ring-blue-700" : ""
      }`}
    >
      {/* Collapsed header — always visible, tap to toggle */}
      <div
        className="px-4 py-3 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold font-mono text-slate-800 dark:text-white">
              {tail}
            </span>
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
              {arr}
            </span>
            <span className={`text-xs font-semibold ${status.accent}`}>
              {status.label}
            </span>
          </div>
          <div className="text-right">
            {isOvernight ? (
              <div className="flex flex-col items-end">
                <div className="text-xs text-gray-400 tabular-nums">
                  Arrived {item.arrFlight.scheduled_arrival ? fmtArrWithDay(item.arrFlight.scheduled_arrival, item.arrFlight.arrival_icao) : "prev. day"}
                </div>
                {item.nextDep && (
                  <div className="text-sm font-bold text-slate-700 dark:text-slate-200 tabular-nums">
                    Departs {fmtLocalTime(item.nextDep.scheduled_departure, item.nextDep.departure_icao)}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="text-sm font-bold text-slate-700 dark:text-slate-200 tabular-nums">
                  Sched {schedArrLocal}
                </div>
                {fi?.actual_arrival && (
                  <div className="text-xs font-medium text-green-600 dark:text-green-400 tabular-nums">
                    Landed {fmtLocalTime(fi.actual_arrival, item.arrFlight.arrival_icao)}
                  </div>
                )}
                {!fi?.actual_arrival && faEtaLocal && faEtaLocal !== schedArrLocal && status.label !== "Landed" && (
                  <div className="text-xs font-medium text-blue-600 dark:text-blue-400 tabular-nums">
                    FA Est {faEtaLocal}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {expanded && <div className="px-4 pb-4">
        {/* Route & FBO */}
        <div className="mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-600 dark:text-gray-300">
              {dep} &rarr; {arr}
            </span>
            {fbo && (
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                &middot; {fbo}
              </span>
            )}
          </div>
          {item.airportInfo && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {item.airportInfo.name}
            </span>
          )}
        </div>

        {/* Time info — suppress for overnight/parked aircraft (yesterday's times are confusing) */}
        {!isOvernight ? (
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Dep {fmtLocalTime(fi?.departure_time ?? item.arrFlight.scheduled_departure, item.arrFlight.departure_icao)}
            </span>
            <span className="text-gray-300 dark:text-gray-600">&rarr;</span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Arr {arrTime}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              &middot; {fmtDriveTime(item.distKm)}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Arrived {item.arrFlight.scheduled_arrival ? fmtArrWithDay(item.arrFlight.scheduled_arrival, item.arrFlight.arrival_icao) : "prev. day"} &middot; {fmtDriveTime(item.distKm)}
            </span>
          </div>
        )}

        {/* Badges row */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${badge.color}`}>
            {badge.label}
          </span>
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${turnBadgeClass(turnLabel)}`}>
            {turnLabel}
          </span>
          {fi?.diverted && (
            <span className="text-xs px-2 py-1 rounded-full font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
              DIVERTED
            </span>
          )}
          {(() => {
            const arrDate = item.arrFlight.scheduled_arrival ? new Date(item.arrFlight.scheduled_arrival).toISOString().split("T")[0] : null;
            const today = new Date().toISOString().split("T")[0];
            if (arrDate && arrDate < today) {
              return <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-indigo-100 text-indigo-700">Landed Yesterday</span>;
            }
            return null;
          })()}
        </div>

        {/* MX notes — hide dismissed + older than 24h */}
        {(() => {
          const now = Date.now();
          const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
          const toEtDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
          const visible = tailMxNotes.filter((n) => {
            if (dismissedMxIds.has(n.id)) return false;
            // If scheduled_date matches today, always show regardless of start/end time
            if (n.scheduled_date === todayStr) return true;
            const startDate = n.start_time ? toEtDate(n.start_time) : null;
            const endDate = n.end_time ? toEtDate(n.end_time) : startDate; // no end_time = single-day
            if (!startDate && !endDate) return true;
            if (startDate && startDate > todayStr) return false; // future
            if (endDate && endDate < todayStr) return false; // past
            return true;
          });
          if (!visible.length) return null;
          return (
            <div className="mt-3 space-y-1.5">
              {visible.map((n) => {
                const isMel = n.body?.toLowerCase().startsWith("mel ");
                return (
                  <MxNoteCard key={n.id} note={n} isMel={!!isMel} now={now} DAY={DAY} onDismiss={onDismissMx} />
                );
              })}
            </div>
          );
        })()}

        {/* Service checklist per aircraft type */}
        {(() => {
          const checklists = getDriverServiceChecklists();
          const typeCode = TAIL_TYPE_MAP[tail];
          const cl = typeCode ? checklists[typeCode] : null;
          if (!cl) return null;
          return (
            <ServiceChecklistAccordion label={cl.label} steps={cl.steps} />
          );
        })()}

        {/* Navigate button */}
        {navUrl && (
          <a
            href={navUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 min-h-[48px] min-w-[48px]"
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
      </div>}
    </div>
  );
}
