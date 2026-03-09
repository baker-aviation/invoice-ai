"use client";

import dynamic from "next/dynamic";
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import type { Flight, MxNote } from "@/lib/opsApi";
import {
  computeOvernightPositions,
  computeOvernightPositionsFromFlights,
  assignVans,
  getDateRange,
  isContiguous48,
  haversineKm,
  FIXED_VAN_ZONES,
  FALLBACK_TAILS,
  VanAssignment,
  AircraftOvernightPosition,
} from "@/lib/maintenanceData";
import { getAirportInfo } from "@/lib/airportCoords";
import type { AircraftPosition } from "./MapView";

// Leaflet requires SSR to be disabled
const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[520px] bg-gray-100 rounded-xl text-gray-500 text-sm">
      Loading map…
    </div>
  ),
});


// ---------------------------------------------------------------------------
// Compute overnight positions from live API flights
// ---------------------------------------------------------------------------

function computePositionsFromFlights(
  flights: Flight[],
  date: string,
): AircraftOvernightPosition[] {
  // Group flights by tail number
  const byTail = new Map<string, Flight[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    const arr = byTail.get(f.tail_number) ?? [];
    arr.push(f);
    byTail.set(f.tail_number, arr);
  }

  const results: AircraftOvernightPosition[] = [];
  const dateEnd = date + "T23:59:59";

  for (const [tail, tailFlights] of byTail) {
    // Sort by scheduled_departure descending
    const sorted = [...tailFlights].sort((a, b) =>
      b.scheduled_departure.localeCompare(a.scheduled_departure),
    );

    // Find the best flight to determine where this aircraft is on `date`:
    // 1. Flights arriving on this date (use arrival airport)
    // 2. Flights departing on this date (use arrival airport if it exists, else departure)
    // 3. Most recent past flight (use arrival airport)
    const arrivingToday = sorted.filter(
      (f) => isOnEtDate(f.scheduled_arrival, date),
    );
    const departingToday = sorted.filter(
      (f) => isOnEtDate(f.scheduled_departure, date),
    );
    const pastFlights = sorted.filter(
      (f) => f.scheduled_departure <= dateEnd,
    );

    let airport: string | null = null;

    if (arrivingToday.length > 0) {
      // Last arrival on this date
      const last = arrivingToday[arrivingToday.length - 1];
      airport = last.arrival_icao?.replace(/^K/, "") ?? null;
    } else if (departingToday.length > 0) {
      // Departing today — aircraft is at the arrival airport (or departure if no arrival)
      const last = departingToday[departingToday.length - 1];
      airport = (last.arrival_icao ?? last.departure_icao)?.replace(/^K/, "") ?? null;
    } else if (pastFlights.length > 0) {
      // Most recent past flight
      const last = pastFlights[0];
      airport = (last.arrival_icao ?? last.departure_icao)?.replace(/^K/, "") ?? null;
    }

    if (!airport) continue;

    const info = getAirportInfo(airport);
    results.push({
      tail,
      airport,
      airportName: info?.name ?? airport,
      city: info?.city ?? "Unknown",
      state: info?.state ?? "",
      lat: info?.lat ?? 0,
      lon: info?.lon ?? 0,
      tripId: sorted[0].id,
      tripStatus: "Active",
      isKnown: info !== null,
    });
  }

  return results.sort((a, b) => a.tail.localeCompare(b.tail));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAN_COLORS = [
  "#2563eb","#16a34a","#dc2626","#9333ea","#ea580c","#0891b2",
  "#d97706","#be185d","#65a30d","#0369a1","#7c3aed","#c2410c",
  "#047857","#b91c1c","#1d4ed8","#15803d",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: string) {
  const base = "inline-block px-2 py-0.5 rounded-full text-xs font-medium";
  if (status === "Released") return <span className={`${base} bg-green-100 text-green-800`}>Released</span>;
  if (status === "Booked")   return <span className={`${base} bg-blue-100 text-blue-800`}>Booked</span>;
  return <span className={`${base} bg-gray-100 text-gray-600`}>{status}</span>;
}

function fmtShortDate(d: string) {
  // "2026-02-26" → "Feb 26"
  const parts = d.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(parts[1]) - 1]} ${parseInt(parts[2])}`;
}

// ---------------------------------------------------------------------------
// Timezone helpers — display all times in Eastern Time to match JetInsight
// ---------------------------------------------------------------------------

const DISPLAY_TZ = "America/New_York";

/** Convert a UTC ISO string to an ET date string (YYYY-MM-DD). */
function utcToEtDate(utcIso: string): string {
  return new Date(utcIso).toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ });
}

/** Check if a UTC ISO string falls on a given ET date (YYYY-MM-DD). */
function isOnEtDate(utcIso: string | null | undefined, etDate: string): boolean {
  if (!utcIso) return false;
  return utcToEtDate(utcIso) === etDate;
}

// ── Airport-local timezone lookup (state-based fallback) ──
const STATE_TZ: Record<string, string> = {
  // Eastern
  CT:"America/New_York",DE:"America/New_York",FL:"America/New_York",GA:"America/New_York",
  IN:"America/New_York",KY:"America/New_York",ME:"America/New_York",MD:"America/New_York",
  MA:"America/New_York",MI:"America/New_York",NH:"America/New_York",NJ:"America/New_York",
  NY:"America/New_York",NC:"America/New_York",OH:"America/New_York",PA:"America/New_York",
  RI:"America/New_York",SC:"America/New_York",VT:"America/New_York",VA:"America/New_York",
  WV:"America/New_York",DC:"America/New_York",
  // Central
  AL:"America/Chicago",AR:"America/Chicago",IL:"America/Chicago",IA:"America/Chicago",
  KS:"America/Chicago",LA:"America/Chicago",MN:"America/Chicago",MS:"America/Chicago",
  MO:"America/Chicago",NE:"America/Chicago",ND:"America/Chicago",OK:"America/Chicago",
  SD:"America/Chicago",TN:"America/Chicago",TX:"America/Chicago",WI:"America/Chicago",
  // Mountain
  CO:"America/Denver",ID:"America/Denver",MT:"America/Denver",NM:"America/Denver",
  UT:"America/Denver",WY:"America/Denver",
  // Arizona (no DST)
  AZ:"America/Phoenix",
  // Pacific
  CA:"America/Los_Angeles",NV:"America/Los_Angeles",OR:"America/Los_Angeles",WA:"America/Los_Angeles",
  // Alaska / Hawaii
  AK:"America/Anchorage",HI:"Pacific/Honolulu",
};

/** Get IANA timezone for an IATA airport code using state lookup. */
function airportTz(iata: string | null | undefined): string {
  if (!iata) return DISPLAY_TZ;
  const info = getAirportInfo(iata.replace(/^K/, ""));
  if (!info) return DISPLAY_TZ;
  return STATE_TZ[info.state] ?? DISPLAY_TZ;
}

function fmtLongDate(d: string) {
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** Format with month+day in airport-local time. */
function fmtTime(s: string | null | undefined, icao?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const tz = airportTz(icao);
  const tzAbbr = d.toLocaleTimeString("en-US", { timeZoneName: "short", timeZone: tz }).split(" ").pop() ?? "";
  return (
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }) + ` ${tzAbbr}`
  );
}

function fmtDuration(dep: string, arr: string | null): string {
  if (!arr) return "";
  const diff = new Date(arr).getTime() - new Date(dep).getTime();
  if (isNaN(diff) || diff < 0) return "";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Day strip
// ---------------------------------------------------------------------------

function DayStrip({
  dates,
  selectedIdx,
  onSelect,
}: {
  dates: string[];
  selectedIdx: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {dates.map((date, i) => {
        const dt = new Date(date + "T12:00:00");
        const weekday = i === 0 ? "Today" : i === 1 ? "Tomorrow" : dt.toLocaleDateString("en-US", { weekday: "short" });
        const dayLabel = fmtShortDate(date);
        const isSelected = i === selectedIdx;
        return (
          <button
            key={date}
            onClick={() => onSelect(i)}
            className={`flex flex-col items-center min-w-[64px] px-3 py-2 rounded-xl border text-sm whitespace-nowrap transition-colors ${
              isSelected
                ? "bg-slate-800 text-white border-slate-800 shadow"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
            }`}
          >
            <span className={`text-xs font-medium ${isSelected ? "text-slate-300" : "text-gray-400"}`}>
              {weekday}
            </span>
            <span className="font-semibold text-sm">{dayLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------

function StatsBar({
  positions,
  vans,
  flightCount,
  aogVanCount,
}: {
  positions: AircraftOvernightPosition[];
  vans: VanAssignment[];
  flightCount: number;
  aogVanCount: number;
}) {
  const covered = vans.flatMap((v) => v.aircraft).length;
  const airports = new Set(positions.map((p) => p.airport)).size;
  const vansActive = aogVanCount > 0 ? aogVanCount : vans.filter((v) => v.aircraft.length > 0).length;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: "Aircraft Positioned", value: covered },
        { label: "Airports Covered",    value: airports },
        { label: "Vans Active",          value: `${vansActive}` },
        { label: "Flights This Day",     value: flightCount },
      ].map(({ label, value }) => (
        <div key={label} className="bg-white border rounded-xl px-4 py-3 shadow-sm">
          <div className="text-2xl font-bold text-slate-800">{value}</div>
          <div className="text-xs text-gray-500 mt-0.5">{label}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab button helper
// ---------------------------------------------------------------------------

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${
        active
          ? "bg-blue-600 text-white shadow-md"
          : "bg-white text-gray-600 border border-gray-200 hover:border-blue-300 hover:text-blue-600 shadow-sm"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Van map: airport cluster card (list view)
// ---------------------------------------------------------------------------

function AirportCluster({ van, color }: { van: VanAssignment; color: string }) {
  const [expanded, setExpanded] = useState(false);
  const aptCounts = van.aircraft.reduce<Record<string, AircraftOvernightPosition[]>>((acc, ac) => {
    (acc[ac.airport] = acc[ac.airport] ?? []).push(ac);
    return acc;
  }, {});

  return (
    <div className="border rounded-xl overflow-hidden bg-white shadow-sm">
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
            style={{ background: color }}
          >
            V{van.vanId}
          </div>
          <div>
            <div className="font-semibold text-sm">Van {van.vanId}</div>
            <div className="text-xs text-gray-500">
              Base: <span className="font-medium">{van.homeAirport}</span> · {van.region}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs bg-slate-100 text-slate-700 rounded-full px-2 py-0.5 font-medium">
            {van.aircraft.length} aircraft
          </span>
          <span className="text-gray-400 text-sm">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t divide-y">
          {Object.entries(aptCounts).map(([apt, acs]) => (
            <div key={apt} className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
                <span className="font-medium text-sm">{apt}</span>
                <span className="text-xs text-gray-500">{acs[0].airportName}</span>
                <span className="text-xs text-gray-400">· {acs[0].city}, {acs[0].state}</span>
              </div>
              <div className="flex flex-wrap gap-2 pl-4">
                {acs.map((ac) => (
                  <div
                    key={ac.tail + ac.tripId}
                    className="flex items-center gap-1.5 bg-gray-50 border rounded-lg px-2.5 py-1.5 text-xs"
                  >
                    <span className="font-mono font-semibold">{ac.tail}</span>
                    {statusBadge(ac.tripStatus)}
                    <span className="text-gray-400">#{ac.tripId}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule tab — per-van plan view
// Shows each van's assigned aircraft, when they land, and done-for-day status.
// ---------------------------------------------------------------------------

/** Format km → driving time string, assuming 90 km/h average. */
function fmtDriveTime(distKm: number): string {
  const totalMins = Math.round(distKm / 90 * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h === 0) return `${m}m drive`;
  return m === 0 ? `${h}h drive` : `${h}h ${m}m drive`;
}

/** Format a UTC ISO timestamp to "HH:MM TZ" in the airport's local timezone. */
function fmtUtcHM(iso: string, icao?: string | null): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const tz = airportTz(icao);
  const tzAbbr = d.toLocaleTimeString("en-US", { timeZoneName: "short", timeZone: tz }).split(" ").pop() ?? "";
  return (
    d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }) + ` ${tzAbbr}`
  );
}

/** True if the flight summary indicates a positioning / ferry / repo leg. */
function isPositioningFlight(f: Flight): boolean {
  return !!(f.summary?.toLowerCase().includes("positioning"));
}

// Flight type keywords matching OpsBoard logic
const FLIGHT_TYPE_KEYWORDS = [
  "Revenue", "Owner", "Positioning", "Maintenance", "Training",
  "Ferry", "Cargo", "Needs pos", "Crew conflict", "Time off",
  "Assignment", "Transient",
];

/** Infer flight type from flight_type field or summary text */
function inferFlightType(flight: Flight): string | null {
  // Same-airport flights are maintenance reminders from JetInsight
  if (flight.departure_icao && flight.arrival_icao &&
      flight.departure_icao === flight.arrival_icao) {
    return "Maintenance";
  }
  if (flight.flight_type) return flight.flight_type;
  const text = flight.summary ?? "";
  const afterPair = text.match(/\([A-Z]{3,4}\s*[-–]\s*[A-Z]{3,4}\)\s*[-–]\s*(.+)$/);
  if (afterPair) {
    const raw = afterPair[1].replace(/\s+flights?\s*$/i, "").trim();
    if (raw) return raw;
  }
  const preBracket = text.match(/^([A-Za-z][A-Za-z /]+?)\s*[-–]?\s*\[/);
  if (preBracket) {
    const raw = preBracket[1].replace(/[-–]\s*$/, "").replace(/\s+flights?\s*$/i, "").trim();
    if (raw) return raw;
  }
  for (const kw of FLIGHT_TYPE_KEYWORDS) {
    if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
      return kw;
    }
  }
  return null;
}

/** Categories that matter for AOG van scheduling */
const AOG_ACTIVE_TYPES = new Set(["Revenue", "Owner", "Positioning", "Charter"]);

/** Flight types that are scheduling notes, NOT real aircraft movements. */
const NON_FLIGHT_TYPES = new Set([
  "Time off",
  "Assignment",
  "Needs pos",
  "Crew conflict",
  "Aircraft away from home base",
  "Aircraft needs repositioning",
]);

/** Map flight types to user-facing filter categories. */
function getFilterCategory(ft: string | null): string {
  if (!ft) return "other";
  const lower = ft.toLowerCase();
  if (lower === "revenue" || lower === "owner" || lower === "charter") return "charter";
  if (lower === "positioning" || lower === "ferry" || lower.includes("ferry") || lower === "transient") return "positioning";
  if (lower === "maintenance") return "maintenance";
  return "other";
}

const SCHED_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "charter", label: "Charter" },
  { key: "positioning", label: "Positioning" },
  { key: "maintenance", label: "Maintenance" },
  { key: "other", label: "Other" },
];

/** "in 2h 15m" or "in 45m" until a future ISO timestamp. Returns "" if in the past. */
function fmtTimeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h === 0 ? `in ${m}m` : `in ${h}h ${m}m`;
}

/** Max one-way driving radius for schedule arrivals (≈2.2h drive). */
const SCHEDULE_ARRIVAL_RADIUS_KM = 200;

/**
 * Greedy nearest-neighbor sort: reorders items so the van visits the closest
 * airport first, then the closest remaining, etc.  Minimises total drive vs.
 * the default arrival-time order which can zigzag across the region.
 */
function greedySort(items: VanFlightItem[], startLat: number, startLon: number): VanFlightItem[] {
  if (items.length <= 1) return items;
  const remaining = [...items];
  const result: VanFlightItem[] = [];
  let curLat = startLat, curLon = startLon;
  while (remaining.length > 0) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const info = remaining[i].airportInfo;
      if (!info) { bestIdx = i; break; }
      const d = haversineKm(curLat, curLon, info.lat, info.lon);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    result.push(chosen);
    curLat = chosen.airportInfo?.lat ?? curLat;
    curLon = chosen.airportInfo?.lon ?? curLon;
  }
  return result;
}

type VanFlightItem = {
  arrFlight: Flight;
  nextDep:   Flight | null;
  isRepo:     boolean;   // arriving leg is positioning
  nextIsRepo: boolean;   // next departure is positioning
  airport:    string;    // IATA
  airportInfo: ReturnType<typeof getAirportInfo>;
  distKm:     number;
};

type FlightInfoEntry = {
  tail: string; ident: string; origin_icao: string | null; origin_name: string | null;
  destination_icao: string | null; destination_name: string | null; status: string | null;
  progress_percent: number | null; departure_time: string | null; arrival_time: string | null;
  route_distance_nm: number | null; diverted: boolean;
  latitude?: number | null; longitude?: number | null; altitude?: number | null;
  groundspeed?: number | null; heading?: number | null;
};

/** Get the effective arrival time for a flight item, preferring FA ETA over scheduled. */
function getEffectiveArrival(item: VanFlightItem, flightInfoMap: Map<string, FlightInfoEntry>): string {
  const tail = item.arrFlight.tail_number;
  if (!tail) return item.arrFlight.scheduled_arrival ?? "";
  const fi = flightInfoMap.get(tail);
  if (fi?.arrival_time) return fi.arrival_time;
  return item.arrFlight.scheduled_arrival ?? "";
}

const MAX_ARRIVALS_PER_VAN = 8;

// ---------------------------------------------------------------------------
// Compute schedule items for a single zone (extracted so ScheduleTab can
// centrally compute items for all zones and manage drag-and-drop overrides)
// ---------------------------------------------------------------------------

function computeZoneItems(
  zone: (typeof FIXED_VAN_ZONES)[number],
  allFlights: Flight[],
  date: string,
  baseLat: number,
  baseLon: number,
): VanFlightItem[] {
  // All arrivals today (any airport, not filtered by zone yet)
  const arrivalsToday = allFlights.filter((f) => {
    if (!f.arrival_icao || !f.scheduled_arrival) return false;
    if (!isOnEtDate(f.scheduled_arrival, date)) return false;
    const ft = inferFlightType(f);
    const cat = getFilterCategory(ft);
    if (cat === "other") return false;
    const iata = f.arrival_icao.replace(/^K/, "");
    const info = getAirportInfo(iata);
    return !!(info && isContiguous48(info.state));
  });

  // Build VanFlightItems with next departure info
  function buildItem(arr: Flight): VanFlightItem {
    const nextDep =
      allFlights
        .filter(
          (f) =>
            f.tail_number === arr.tail_number &&
            f.departure_icao === arr.arrival_icao &&
            f.scheduled_departure > (arr.scheduled_arrival ?? ""),
        )
        .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure))[0] ?? null;

    const iata = arr.arrival_icao!.replace(/^K/, "");
    const info = getAirportInfo(iata);
    const distKm = info ? Math.round(haversineKm(baseLat, baseLon, info.lat, info.lon)) : 0;

    return {
      arrFlight: arr,
      nextDep,
      isRepo: isPositioningFlight(arr),
      nextIsRepo: nextDep ? isPositioningFlight(nextDep) : false,
      airport: iata,
      airportInfo: info,
      distKm,
    };
  }

  /** Check if an airport is within this zone's radius. */
  function isInZone(iata: string): boolean {
    const info = getAirportInfo(iata);
    if (!info) return false;
    return haversineKm(zone.lat, zone.lon, info.lat, info.lon) <= SCHEDULE_ARRIVAL_RADIUS_KM;
  }

  // Group arrivals by tail number
  const byTail = new Map<string, Flight[]>();
  for (const f of arrivalsToday) {
    const key = f.tail_number || `_no_tail_${f.id}`;
    const arr = byTail.get(key) ?? [];
    arr.push(f);
    byTail.set(key, arr);
  }

  // Priority logic per tail:
  // 1. End-of-day airport in zone → assign there
  // 2. Quickturn before repo out of zone → assign at the quickturn airport
  // 3. Skip if neither applies
  const rawItems: VanFlightItem[] = [];

  for (const [tailKey, legs] of byTail) {
    // Sort by arrival time descending to find last arrival first
    const sorted = [...legs].sort((a, b) =>
      (b.scheduled_arrival ?? "").localeCompare(a.scheduled_arrival ?? ""),
    );

    // Find the tail's end-of-day airport: follow the chain of same-day departures
    // from the last arrival to find where the aircraft actually ends up
    let endOfDayFlight = sorted[0]; // last arrival of the day
    let endOfDayAirport = endOfDayFlight.arrival_icao!.replace(/^K/, "");

    // Walk forward: if there's a same-day departure from this airport, follow it
    let current = endOfDayFlight;
    for (let i = 0; i < 5; i++) { // max 5 hops to prevent infinite loops
      const nextLeg = allFlights.find(
        (f) =>
          f.tail_number === current.tail_number &&
          f.departure_icao === current.arrival_icao &&
          f.scheduled_departure > (current.scheduled_arrival ?? "") &&
          isOnEtDate(f.scheduled_departure, date),
      );
      if (!nextLeg || !nextLeg.arrival_icao) break;
      endOfDayFlight = nextLeg;
      endOfDayAirport = nextLeg.arrival_icao.replace(/^K/, "");
      current = nextLeg;
    }

    // Priority 1: end-of-day airport is in zone
    if (isInZone(endOfDayAirport)) {
      // Use the last arrival leg that lands in the zone as the display item
      // but show the end-of-day airport for van assignment
      const lastInZone = sorted.find((f) => isInZone(f.arrival_icao!.replace(/^K/, "")));
      const item = buildItem(lastInZone ?? sorted[0]);
      // Override airport to end-of-day location
      const eodInfo = getAirportInfo(endOfDayAirport);
      if (eodInfo) {
        item.airport = endOfDayAirport;
        item.airportInfo = eodInfo;
        item.distKm = Math.round(haversineKm(baseLat, baseLon, eodInfo.lat, eodInfo.lon));
      }
      rawItems.push(item);
      continue;
    }

    // Priority 2: quickturn in zone before a repo/departure out of zone
    // Look for a leg that arrives in zone, has a same-day departure (quickturn)
    for (const leg of sorted) {
      const arrIata = leg.arrival_icao!.replace(/^K/, "");
      if (!isInZone(arrIata)) continue;

      const item = buildItem(leg);
      if (!item.nextDep) continue; // no departure = done for day (should have been caught by P1)

      const arrMs = new Date(leg.scheduled_arrival ?? "").getTime();
      const depMs = new Date(item.nextDep.scheduled_departure).getTime();
      const groundHours = (depMs - arrMs) / 3_600_000;

      // Quickturn (< 2h) or short ground time before repo
      if (groundHours < 6 && (item.nextIsRepo || isPositioningFlight(item.nextDep))) {
        rawItems.push(item);
        break;
      }
    }
  }

  // Deduplicate by tail — keep the one closest to the van base
  const deduped = new Map<string, VanFlightItem>();
  for (const item of rawItems) {
    const key = item.arrFlight.tail_number || `_no_tail_${item.arrFlight.id}`;
    const existing = deduped.get(key);
    if (!existing || item.distKm < existing.distKm) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) =>
      (a.arrFlight.scheduled_arrival ?? "").localeCompare(b.arrFlight.scheduled_arrival ?? ""),
    )
    .slice(0, MAX_ARRIVALS_PER_VAN);
}

/**
 * Compute ALL arrivals for a given date across all airports (no zone proximity
 * filter). Used to build the "unassigned aircraft" pool in the schedule tab.
 */
function computeAllDayArrivals(allFlights: Flight[], date: string): VanFlightItem[] {
  const arrivalsToday = allFlights.filter((f) => {
    if (!f.arrival_icao || !f.scheduled_arrival) return false;
    if (!isOnEtDate(f.scheduled_arrival, date)) return false;
    // Hide "other" category flights from the AOG schedule
    const ft = inferFlightType(f);
    const cat = getFilterCategory(ft);
    if (cat === "other") return false;
    const iata = f.arrival_icao.replace(/^K/, "");
    const info = getAirportInfo(iata);
    return !!(info && isContiguous48(info.state));
  });

  const rawItems = arrivalsToday
    .map((arr) => {
      const iata = arr.arrival_icao!.replace(/^K/, "");
      const info = getAirportInfo(iata);
      const nextDep =
        allFlights
          .filter(
            (f) =>
              f.tail_number === arr.tail_number &&
              f.departure_icao === arr.arrival_icao &&
              f.scheduled_departure > (arr.scheduled_arrival ?? ""),
          )
          .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure))[0] ?? null;

      return {
        arrFlight: arr,
        nextDep,
        isRepo: isPositioningFlight(arr),
        nextIsRepo: nextDep ? isPositioningFlight(nextDep) : false,
        airport: iata,
        airportInfo: info,
        distKm: 0, // no van base yet
      };
    })
    .filter(({ arrFlight, nextDep }) => {
      if (!nextDep) return true;
      // Transit filter: short ground time + same-day revenue dep = just passing through
      if (nextDep.scheduled_departure.startsWith(date)) {
        const arrMs = new Date(arrFlight.scheduled_arrival ?? "").getTime();
        const depMs = new Date(nextDep.scheduled_departure).getTime();
        const groundHours = (depMs - arrMs) / 3_600_000;
        if (groundHours < 2 && !isPositioningFlight(nextDep)) return false;
      }
      if (isPositioningFlight(nextDep)) return true;
      return !isOnEtDate(nextDep.scheduled_departure, date);
    });

  // Deduplicate by tail — keep last arrival (no van base for uncovered pool)
  // Use flight ID as key for flights with no tail number to avoid collapsing them
  const byTail = new Map<string, VanFlightItem>();
  for (const item of rawItems) {
    const key = item.arrFlight.tail_number || `_no_tail_${item.arrFlight.id}`;
    const existing = byTail.get(key);
    if (
      !existing ||
      (item.arrFlight.scheduled_arrival ?? "") > (existing.arrFlight.scheduled_arrival ?? "")
    ) {
      byTail.set(key, item);
    }
  }

  // Second pass: remove tailless duplicates that match a tailed flight on same route+time
  const tailedSigs = new Set<string>();
  for (const item of byTail.values()) {
    if (!item.arrFlight.tail_number) continue;
    const sig = `${item.arrFlight.departure_icao}|${item.arrFlight.arrival_icao}|${item.arrFlight.scheduled_departure}|${item.arrFlight.scheduled_arrival ?? ""}`;
    tailedSigs.add(sig);
  }
  for (const [key, item] of byTail) {
    if (item.arrFlight.tail_number) continue;
    const sig = `${item.arrFlight.departure_icao}|${item.arrFlight.arrival_icao}|${item.arrFlight.scheduled_departure}|${item.arrFlight.scheduled_arrival ?? ""}`;
    if (tailedSigs.has(sig)) byTail.delete(key);
  }

  return Array.from(byTail.values()).sort((a, b) =>
    (a.arrFlight.scheduled_arrival ?? "").localeCompare(b.arrFlight.scheduled_arrival ?? ""),
  );
}

/** Recalculate distKm for items relative to a van's base position. */
function recalcDist(items: VanFlightItem[], baseLat: number, baseLon: number): VanFlightItem[] {
  return items.map((item) => ({
    ...item,
    distKm: item.airportInfo
      ? Math.round(haversineKm(baseLat, baseLon, item.airportInfo.lat, item.airportInfo.lon))
      : 0,
  }));
}

/** Compute sequential route distance (base→stop1→stop2→…). */
function routeDistKm(items: VanFlightItem[]): number {
  return items.reduce((sum, item, idx) => {
    if (idx === 0) return item.distKm;
    const prev = items[idx - 1];
    if (!prev.airportInfo || !item.airportInfo) return sum + item.distKm;
    return sum + Math.round(haversineKm(prev.airportInfo.lat, prev.airportInfo.lon, item.airportInfo.lat, item.airportInfo.lon));
  }, 0);
}

// ---------------------------------------------------------------------------
// Slack share modal for a van's schedule
// ---------------------------------------------------------------------------

type SlackChannel = { id: string; name: string };
type SlackShareState = "idle" | "loading-channels" | "picking" | "sending" | "success" | "error";

function SlackShareModal({
  vanName,
  vanId,
  homeAirport,
  date,
  items,
  flightInfoMap,
  onClose,
}: {
  vanName: string;
  vanId: number;
  homeAirport: string;
  date: string;
  items: VanFlightItem[];
  flightInfoMap: Map<string, FlightInfoEntry>;
  onClose: () => void;
}) {
  const [state, setState] = useState<SlackShareState>("loading-channels");
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function loadChannels() {
      try {
        const res = await fetch("/api/vans/share-slack");
        const data = await res.json();
        if (!data.ok) {
          setError(data.error ?? "Failed to load channels");
          setState("error");
          return;
        }
        setChannels(data.channels);
        setState("picking");
      } catch (e) {
        setError(String(e));
        setState("error");
      }
    }
    loadChannels();
  }, []);

  async function handleShare(channel: SlackChannel) {
    setState("sending");
    try {
      const payload = {
        channel: channel.id,
        vanName,
        vanId,
        homeAirport,
        date,
        items: items.map((item) => {
          const fi = flightInfoMap.get(item.arrFlight.tail_number ?? "");
          const arrMs = item.arrFlight.scheduled_arrival ? new Date(item.arrFlight.scheduled_arrival).getTime() : null;
          const gapMs = item.nextDep && arrMs
            ? new Date(item.nextDep.scheduled_departure).getTime() - arrMs : Infinity;
          const turnLabel = !item.nextDep || gapMs >= 6 * 3600000
            ? "Done for day"
            : gapMs < 2 * 3600000 ? "Quickturn" : undefined;
          // Determine status from FA data when available
          let slackStatus: string;
          if (fi?.diverted) {
            slackStatus = "DIVERTED";
          } else if (fi?.status?.includes("Landed")) {
            slackStatus = "Landed";
          } else if (fi?.status?.includes("En Route")) {
            const eta = fi.arrival_time ? fmtTimeUntil(fi.arrival_time) : "";
            slackStatus = eta ? `En Route (ETA ${eta})` : "En Route";
          } else if (item.arrFlight.scheduled_arrival && new Date(item.arrFlight.scheduled_arrival) < new Date()) {
            slackStatus = "~Landed";
          } else {
            slackStatus = "Scheduled";
          }
          return {
            tail: item.arrFlight.tail_number ?? "—",
            route: `${item.arrFlight.departure_icao?.replace(/^K/, "") ?? "?"} → ${item.airport}`,
            arrivalTime: item.arrFlight.scheduled_arrival ? fmtUtcHM(item.arrFlight.scheduled_arrival, item.arrFlight.arrival_icao) : "—",
            status: slackStatus,
            nextDep: item.nextDep ? `Flying again ${fmtUtcHM(item.nextDep.scheduled_departure, item.nextDep.departure_icao)} → ${item.nextDep.arrival_icao?.replace(/^K/, "") ?? "?"}` : undefined,
            turnStatus: turnLabel,
            driveTime: item.distKm > 0 ? fmtDriveTime(item.distKm) : undefined,
          };
        }),
      };
      const res = await fetch("/api/vans/share-slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        setState("success");
        setTimeout(onClose, 1500);
      } else {
        setError(data.error ?? "Failed to share");
        setState("error");
      }
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  }

  const filtered = channels.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="font-semibold text-sm">Share to Slack — {vanName}</div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none">&times;</button>
        </div>

        {state === "loading-channels" && (
          <div className="px-4 py-8 text-center text-sm text-gray-400 animate-pulse">Loading Slack channels...</div>
        )}

        {state === "error" && (
          <div className="px-4 py-6 text-center space-y-2">
            <div className="text-sm text-red-600">{error}</div>
            <button onClick={onClose} className="text-xs text-gray-500 hover:underline">Close</button>
          </div>
        )}

        {state === "picking" && (
          <div className="max-h-80 overflow-y-auto">
            <div className="px-4 py-2 sticky top-0 bg-white border-b">
              <input
                type="text"
                placeholder="Search channels..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full text-sm border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-sm text-gray-400 text-center">No channels found</div>
            ) : (
              <div className="divide-y">
                {filtered.map((ch) => (
                  <button
                    key={ch.id}
                    onClick={() => handleShare(ch)}
                    className="w-full px-4 py-2.5 text-left text-sm hover:bg-blue-50 transition-colors flex items-center gap-2"
                  >
                    <span className="text-gray-400">#</span>
                    <span className="font-medium text-gray-700">{ch.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {state === "sending" && (
          <div className="px-4 py-8 text-center text-sm text-gray-400 animate-pulse">Sending to Slack...</div>
        )}

        {state === "success" && (
          <div className="px-4 py-8 text-center text-sm text-green-600 font-medium">Shared successfully!</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MxNoteInline — JetInsight maintenance alerts per aircraft
// ---------------------------------------------------------------------------

function MxNoteInline({ notes }: { notes: MxNote[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="ml-8 mt-1 space-y-1">
      {notes.map((n) => (
        <div key={n.id} className="flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-1.5">
          <span className="text-orange-500 font-bold text-xs mt-0.5 shrink-0">MX</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-orange-700">{n.airport_icao}</span>
              <span className="text-xs text-gray-700">{n.body}</span>
              {n.start_time && (
                <span className="text-[11px] text-gray-400 ml-auto shrink-0">
                  {new Date(n.start_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  {n.end_time && n.end_time !== n.start_time && ` – ${new Date(n.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LegNoteInline — MX director note per flight leg
// ---------------------------------------------------------------------------

function LegNoteInline({
  flightId,
  tailNumber,
  note,
  onSave,
}: {
  flightId: string;
  tailNumber: string | null;
  note: string;
  onSave: (flightId: string, tailNumber: string | null, note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync draft when note changes externally
  useEffect(() => { setDraft(note); }, [note]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (!editing && !note) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        className="ml-8 mt-1 text-[11px] text-gray-400 hover:text-indigo-600 hover:underline"
      >
        + Add MX note
      </button>
    );
  }

  if (!editing) {
    return (
      <div
        className="ml-8 mt-1 flex items-start gap-1.5 group cursor-pointer"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      >
        <span className="text-[11px] font-medium text-indigo-600 shrink-0">MX:</span>
        <span className="text-[11px] text-gray-600 whitespace-pre-wrap">{note}</span>
        <button className="text-[10px] text-gray-300 group-hover:text-indigo-500 shrink-0 ml-1">edit</button>
      </div>
    );
  }

  const commit = () => {
    onSave(flightId, tailNumber, draft);
    setEditing(false);
  };

  return (
    <div className="ml-8 mt-1 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <span className="text-[11px] font-medium text-indigo-600 shrink-0">MX:</span>
      <input
        ref={inputRef}
        className="flex-1 text-[11px] border border-indigo-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(note); setEditing(false); }
        }}
        placeholder="Note for van driver…"
      />
      <button
        onClick={commit}
        className="text-[10px] font-medium text-white bg-indigo-500 hover:bg-indigo-600 rounded px-1.5 py-0.5"
      >
        Save
      </button>
      {note && (
        <button
          onClick={() => { onSave(flightId, tailNumber, ""); setEditing(false); }}
          className="text-[10px] text-red-400 hover:text-red-600"
        >
          Delete
        </button>
      )}
      <button
        onClick={() => { setDraft(note); setEditing(false); }}
        className="text-[10px] text-gray-400 hover:text-gray-600"
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VanScheduleCard — now receives items as props (no internal computation)
// ---------------------------------------------------------------------------

function VanScheduleCard({
  zone,
  color,
  items,
  date,
  allFlights,
  liveVanPos,
  liveAddress,
  samsaraVanName,
  isDropTarget,
  hasOverrides,
  flightInfoMap,
  legNotes,
  mxNotesByTail,
  onSaveNote,
  onDragStart,
  onDragOver,
  onDrop,
  onDragLeave,
  onRemove,
}: {
  zone: (typeof FIXED_VAN_ZONES)[number];
  color: string;
  items: VanFlightItem[];
  date: string;
  allFlights?: Flight[];
  liveVanPos?: { lat: number; lon: number };
  liveAddress?: string | null;
  samsaraVanName?: string | null;
  isDropTarget: boolean;
  hasOverrides: boolean;
  flightInfoMap: Map<string, FlightInfoEntry>;
  legNotes: Map<string, string>;
  mxNotesByTail: Map<string, MxNote[]>;
  onSaveNote: (flightId: string, tailNumber: string | null, note: string) => void;
  onDragStart: (e: React.DragEvent, flightId: string, fromVanId: number) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, toVanId: number) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onRemove: (flightId: string) => void;  // delete aircraft from this van
}) {
  const [expanded, setExpanded] = useState(true);
  const [showSlackModal, setShowSlackModal] = useState(false);
  const now = new Date();

  const totalDistKm = routeDistKm(items);
  const totalDriveH = totalDistKm / 90;
  const overLimit = totalDriveH > 5;

  return (
    <div
      className={`border rounded-xl overflow-hidden bg-white shadow-sm transition-all ${
        isDropTarget ? "ring-2 ring-blue-400 border-blue-300 bg-blue-50/30" : ""
      }`}
      onDragOver={onDragOver}
      onDrop={(e) => onDrop(e, zone.vanId)}
      onDragLeave={onDragLeave}
    >
      {showSlackModal && (
        <SlackShareModal
          vanName={samsaraVanName ?? zone.name}
          vanId={zone.vanId}
          homeAirport={zone.homeAirport}
          date={date}
          items={items}
          flightInfoMap={flightInfoMap}
          onClose={() => setShowSlackModal(false)}
        />
      )}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
            style={{ background: color }}
          >
            V{zone.vanId}
          </div>
          <div>
            {(() => {
              // Extract city, state from live GPS address (e.g. "123 Main St, Vail, CO, 81657")
              let liveCityState: string | null = null;
              if (liveAddress) {
                const parts = liveAddress.split(",").map((p) => p.trim());
                // Find state abbreviation (2 uppercase letters, possibly followed by zip)
                for (let i = 1; i < parts.length; i++) {
                  const stateMatch = parts[i].match(/^([A-Z]{2})$/);
                  if (stateMatch && i >= 1) {
                    liveCityState = `${parts[i - 1]}, ${stateMatch[1]}`;
                    break;
                  }
                }
              }
              return (
                <>
                  <div className="font-semibold text-sm">
                    {liveCityState ? `${liveCityState} Van` : ((samsaraVanName && parseVanDisplayName(samsaraVanName)) || zone.name)}
                  </div>
                  {samsaraVanName && (
                    <div className="text-[10px] text-gray-400 -mt-0.5">{samsaraVanName}</div>
                  )}
                  {!liveCityState && (
                    <div className="text-xs text-gray-500">
                      {zone.city}
                    </div>
                  )}
                </>
              );
            })()}
            {liveAddress ? (
              <div className="text-xs text-green-600 mt-0.5 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block flex-shrink-0" />
                <span className="font-medium text-gray-500">Van Location:</span> {liveAddress}
              </div>
            ) : liveVanPos ? (
              <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                <span className="font-medium text-gray-500">Van Location:</span> {liveVanPos.lat.toFixed(3)}, {liveVanPos.lon.toFixed(3)}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={(e) => { e.stopPropagation(); setShowSlackModal(true); }}
            className="text-xs text-gray-500 hover:text-purple-700 hover:bg-purple-50 border border-gray-200 hover:border-purple-300 rounded-lg px-2 py-1 transition-colors font-medium"
            title="Share to Slack"
          >
            Share to Slack
          </button>
          {hasOverrides && (
            <span className="text-xs rounded-full px-2 py-0.5 font-medium bg-amber-100 text-amber-700">
              Edited
            </span>
          )}
          {items.length > 0 && (
            <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${overLimit ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"}`}>
              {fmtDriveTime(totalDistKm)}{overLimit ? " ⚠" : ""}
            </span>
          )}
          <span className="text-xs bg-slate-100 text-slate-700 rounded-full px-2 py-0.5 font-medium">
            {items.length} arrival{items.length !== 1 ? "s" : ""}
          </span>
          <span className="text-gray-400 text-sm">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t">
          {items.length === 0 ? (
            <div className={`px-4 py-6 text-sm text-center ${isDropTarget ? "text-blue-500 font-medium" : "text-gray-400"}`}>
              {isDropTarget ? "Drop aircraft here" : "No arrivals in area today."}
            </div>
          ) : (
            <div className="divide-y">
              {items.map(({ arrFlight, nextDep, isRepo, nextIsRepo, airport, airportInfo, distKm }) => {
                const fi = flightInfoMap.get(arrFlight.tail_number ?? "");
                const arrTime = arrFlight.scheduled_arrival ? new Date(arrFlight.scheduled_arrival) : null;
                const hasLanded = arrTime !== null && arrTime < now;
                // Compute delay from FA data
                const faEtaMs = fi?.arrival_time ? new Date(fi.arrival_time).getTime() : null;
                const schedMs = arrTime ? arrTime.getTime() : null;
                const delayMs = (faEtaMs != null && schedMs != null) ? faEtaMs - schedMs : 0;
                const delayMin = Math.round(delayMs / 60000);
                const isEnRoute = fi?.status?.includes("En Route") ?? false;
                const faLanded = fi?.status?.includes("Landed") ?? false;
                const groundMs = nextDep && arrTime
                  ? new Date(nextDep.scheduled_departure).getTime() - arrTime.getTime()
                  : Infinity;
                const doneForDay = !nextDep || groundMs >= 6 * 3600000;
                const isQuickturn = !!nextDep && groundMs < 2 * 3600000;
                // Find same-day legs for this aircraft (exclude "other" type)
                const extraLegs = (allFlights && arrFlight.tail_number)
                  ? allFlights.filter((f) => {
                      if (f.tail_number !== arrFlight.tail_number) return false;
                      if (f.id === arrFlight.id) return false;
                      if (!(isOnEtDate(f.scheduled_departure, date) || isOnEtDate(f.scheduled_arrival, date))) return false;
                      return getFilterCategory(inferFlightType(f)) !== "other";
                    }).sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure))
                  : [];
                // Check if this aircraft has a maintenance event scheduled
                const hasMaintenance = !!(allFlights && arrFlight.tail_number) && allFlights.some((f) =>
                  f.tail_number === arrFlight.tail_number &&
                  f.departure_icao && f.arrival_icao &&
                  f.departure_icao === f.arrival_icao &&
                  (isOnEtDate(f.scheduled_departure, date) || isOnEtDate(f.scheduled_arrival, date))
                );
                return (
                  <div
                    key={arrFlight.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, arrFlight.id, zone.vanId)}
                    className="px-4 py-2 cursor-grab active:cursor-grabbing hover:bg-gray-50/50"
                  >
                    <div className="flex items-center justify-between gap-3">
                      {/* Left: color dot + tail + route + badges */}
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                          <svg className="w-3 h-3 text-gray-300" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2}>
                            <path d="M2 4h8M2 8h8" />
                          </svg>
                        </div>
                        <span className="font-mono font-semibold text-sm">{arrFlight.tail_number ?? "—"}</span>
                        <span className="text-xs text-gray-500 font-mono">
                          {arrFlight.departure_icao?.replace(/^K/, "") ?? "?"} → {airport}
                        </span>
                        {inferFlightType(arrFlight) === "Maintenance" ? (
                          <span className="text-xs bg-orange-100 text-orange-700 rounded px-1.5 py-0.5">Maintenance</span>
                        ) : isRepo ? (
                          <span className="text-xs bg-purple-100 text-purple-700 rounded px-1.5 py-0.5">Positioning</span>
                        ) : (
                          <span className="text-xs bg-green-100 text-green-700 rounded px-1.5 py-0.5">Revenue</span>
                        )}
                        {isQuickturn && (
                          <span className="text-xs font-semibold bg-amber-100 text-amber-700 rounded-full px-2 py-0.5">Quickturn</span>
                        )}
                        {doneForDay && (
                          <span className="text-xs font-semibold bg-green-100 text-green-700 rounded-full px-2 py-0.5">Done for day</span>
                        )}
                        {hasMaintenance && (
                          <span className="text-xs font-semibold bg-orange-100 text-orange-700 rounded-full px-2 py-0.5">Maint</span>
                        )}
                      </div>
                      {/* Right: times + status + countdown + remove */}
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="text-right text-xs whitespace-nowrap">
                          {arrFlight.scheduled_departure && (
                            <span className="text-gray-400">{fmtUtcHM(arrFlight.scheduled_departure, arrFlight.departure_icao)}</span>
                          )}
                          {arrTime && (
                            <span className="text-gray-400">{" → "}<span className="font-medium text-gray-700">{fmtUtcHM(arrFlight.scheduled_arrival!, arrFlight.arrival_icao)}</span></span>
                          )}
                          {/* Landing countdown when en route with FA ETA */}
                          {isEnRoute && fi?.arrival_time && !faLanded && (() => {
                            const countdown = fmtTimeUntil(fi.arrival_time!);
                            const etaColorClass = delayMin > 30 ? "text-red-600" : delayMin > 15 ? "text-amber-600" : delayMin < -5 ? "text-green-600" : "text-blue-600";
                            return countdown ? (
                              <span className={`ml-1 font-medium ${etaColorClass}`}>
                                Landing {countdown}
                              </span>
                            ) : null;
                          })()}
                        </div>
                        {/* FA-powered status badge */}
                        {fi?.diverted ? (
                          <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-red-100 text-red-700">DIVERTED</span>
                        ) : faLanded ? (
                          <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-green-100 text-green-700">Landed</span>
                        ) : isEnRoute ? (
                          <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-blue-100 text-blue-700">
                            En Route{fi?.progress_percent != null ? ` ${fi.progress_percent}%` : ""}
                          </span>
                        ) : (
                          <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${hasLanded ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>
                            {hasLanded ? "~Landed" : "Scheduled"}
                          </span>
                        )}
                        {/* Delay alert badges (diversion already shown in status badge above) */}
                        {!fi?.diverted && delayMin > 30 && (
                          <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-red-100 text-red-700">Delayed ~{delayMin}m</span>
                        )}
                        {!fi?.diverted && delayMin > 15 && delayMin <= 30 && (
                          <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-amber-100 text-amber-700">Delayed ~{delayMin}m</span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); onRemove(arrFlight.id); }}
                          className="p-1 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title="Remove from this van"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 14 14" stroke="currentColor" strokeWidth={2}>
                            <path d="M3 3l8 8M11 3l-8 8" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {/* Sub-info line: airport city + drive time + FA ETA + flying again */}
                    <div className="ml-8 mt-0.5 flex items-center gap-2 text-xs text-gray-400 flex-wrap">
                      <span>
                        {airport}{airportInfo ? ` · ${airportInfo.city}, ${airportInfo.state}` : ""} · {fmtDriveTime(distKm)}
                        {isEnRoute && fi?.arrival_time && !faLanded && (() => {
                          const etaStr = fmtTimeUntil(fi.arrival_time!);
                          return etaStr ? ` · ETA ${etaStr}` : "";
                        })()}
                      </span>
                      {nextDep && (
                        <>
                          <span className="text-gray-300">|</span>
                          <span className={nextIsRepo ? "text-purple-600 font-medium" : "text-blue-600 font-medium"}>
                            Flying again {fmtTimeUntil(nextDep.scheduled_departure) && `${fmtTimeUntil(nextDep.scheduled_departure)} · `}{fmtUtcHM(nextDep.scheduled_departure, nextDep.departure_icao)} → {nextDep.arrival_icao?.replace(/^K/, "") ?? "?"}
                            {nextIsRepo && <span className="text-purple-400 font-normal"> (repo)</span>}
                          </span>
                        </>
                      )}
                    </div>
                    {/* Day's other legs for this aircraft */}
                    {extraLegs.length > 0 && (
                      <div className="ml-8 mt-1 space-y-0 border-l-2 pl-3" style={{ borderColor: color + "40" }}>
                        {extraLegs.map((f) => {
                          const ft = inferFlightType(f);
                          const cat = getFilterCategory(ft);
                          const dep = f.departure_icao?.replace(/^K/, "") ?? "?";
                          const arrIcao = f.arrival_icao?.replace(/^K/, "") ?? "?";
                          const isNext = nextDep && f.id === nextDep.id;
                          return (
                            <div key={f.id} className={`flex items-center gap-2 text-xs py-px ${isNext ? "text-gray-500" : "text-gray-400"}`}>
                              <span className="font-mono text-gray-500">{dep} → {arrIcao}</span>
                              <span>{fmtUtcHM(f.scheduled_departure, f.departure_icao)}{f.scheduled_arrival ? ` – ${fmtUtcHM(f.scheduled_arrival, f.arrival_icao)}` : ""}</span>
                              {ft && (
                                <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                                  cat === "positioning" ? "bg-purple-50 text-purple-500"
                                  : cat === "charter" ? "bg-green-50 text-green-500"
                                  : cat === "maintenance" ? "bg-orange-50 text-orange-500"
                                  : ft === "Owner" ? "bg-blue-50 text-blue-500"
                                  : "bg-gray-50 text-gray-400"
                                }`}>
                                  {ft}
                                </span>
                              )}
                              {isNext && <span className="text-blue-500 font-medium">← next</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {/* MX notes from JetInsight */}
                    <MxNoteInline notes={mxNotesByTail.get(arrFlight.tail_number ?? "") ?? []} />
                    {/* MX director note */}
                    <LegNoteInline
                      flightId={arrFlight.id}
                      tailNumber={arrFlight.tail_number ?? null}
                      note={legNotes.get(arrFlight.id) ?? ""}
                      onSave={onSaveNote}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {isDropTarget && items.length > 0 && (
            <div className="px-4 py-2 text-xs text-blue-500 font-medium text-center bg-blue-50/50 border-t border-dashed border-blue-200">
              Drop aircraft here
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleTab — manages centralized items + drag-and-drop override state
// ---------------------------------------------------------------------------

function ScheduleTab({
  allFlights,
  date,
  liveVanPositions,
  liveVanAddresses,
  vanZoneNames,
  flightInfoMap,
  mxNotesByTail,
}: {
  allFlights: Flight[];
  date: string;
  liveVanPositions: Map<number, { lat: number; lon: number }>;
  liveVanAddresses: Map<number, string | null>;
  vanZoneNames: Map<number, string>;
  flightInfoMap: Map<string, FlightInfoEntry>;
  mxNotesByTail: Map<string, MxNote[]>;
}) {
  const hasLive = liveVanPositions.size > 0;

  // Manual overrides: flightId → target vanId (moves) + removed flight IDs
  const [overrides, setOverrides] = useState<Map<string, number>>(new Map());
  const [removals, setRemovals] = useState<Set<string>>(new Set());
  // Unscheduled aircraft assigned to vans: tail → vanId
  const [unscheduledOverrides, setUnscheduledOverrides] = useState<Map<string, number>>(new Map());

  // Publish state
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Snapshot of edits at last publish — used to detect unpublished changes
  const [publishedEditsSnapshot, setPublishedEditsSnapshot] = useState<string>("");

  // MX director notes per leg
  const [legNotes, setLegNotes] = useState<Map<string, string>>(new Map());

  // Check existing publish status + load notes on mount / date change
  useEffect(() => {
    setPublishedAt(null);
    setPublishError(null);
    setPublishedEditsSnapshot("");
    fetch(`/api/vans/publish?date=${date}`)
      .then((r) => r.json())
      .then((d) => { if (d.published_at) setPublishedAt(d.published_at); })
      .catch(() => {});
    // Load existing notes
    fetch(`/api/vans/notes?date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        const map = new Map<string, string>();
        for (const n of d.notes ?? []) map.set(n.flight_id, n.note);
        setLegNotes(map);
      })
      .catch(() => {});
  }, [date]);
  // Reset overrides when date changes
  const prevDateRef = useRef(date);
  if (prevDateRef.current !== date) {
    prevDateRef.current = date;
    if (overrides.size > 0) setOverrides(new Map());
    if (removals.size > 0) setRemovals(new Set());
    if (unscheduledOverrides.size > 0) setUnscheduledOverrides(new Map());
  }

  const totalEdits = overrides.size + removals.size + unscheduledOverrides.size;

  // DnD visual state
  const saveLegNote = useCallback(async (flightId: string, tailNumber: string | null, note: string) => {
    if (!note.trim()) {
      // Delete note
      setLegNotes((prev) => { const m = new Map(prev); m.delete(flightId); return m; });
      fetch(`/api/vans/notes?flight_id=${encodeURIComponent(flightId)}`, { method: "DELETE" }).catch(() => {});
      return;
    }
    setLegNotes((prev) => new Map(prev).set(flightId, note.trim()));
    fetch("/api/vans/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flight_id: flightId, date, tail_number: tailNumber, note }),
    }).catch(() => {});
  }, [date]);

  const [dropTargetVan, setDropTargetVan] = useState<number | null>(null);
  const dragCounterRef = useRef(0);

  // Compute base items for every zone, then deduplicate across zones
  // so each aircraft only appears in the closest van's card.
  const baseItemsByVan = useMemo(() => {
    const raw = new Map<number, VanFlightItem[]>();
    for (const zone of FIXED_VAN_ZONES) {
      const baseLat = liveVanPositions.get(zone.vanId)?.lat ?? zone.lat;
      const baseLon = liveVanPositions.get(zone.vanId)?.lon ?? zone.lon;
      raw.set(zone.vanId, computeZoneItems(zone, allFlights, date, baseLat, baseLon));
    }
    // Deduplicate: if an aircraft appears in multiple zones, keep only the closest
    const claimedFlights = new Set<string>();
    // Build a list of (vanId, flightId, distance) for all assignments
    const assignments: { vanId: number; flightId: string; distKm: number; item: VanFlightItem }[] = [];
    for (const [vanId, items] of raw) {
      for (const item of items) {
        assignments.push({ vanId, flightId: item.arrFlight.id, distKm: item.distKm, item });
      }
    }
    // Sort by distance so closest van wins
    assignments.sort((a, b) => a.distKm - b.distKm);
    const map = new Map<number, VanFlightItem[]>();
    for (const zone of FIXED_VAN_ZONES) map.set(zone.vanId, []);
    for (const { vanId, flightId, item } of assignments) {
      if (claimedFlights.has(flightId)) continue;
      claimedFlights.add(flightId);
      map.get(vanId)!.push(item);
    }
    return map;
  }, [allFlights, date, liveVanPositions]);

  // All arrivals today (no zone filter) — used for the uncovered pool
  const allDayArrivals = useMemo(
    () => computeAllDayArrivals(allFlights, date),
    [allFlights, date],
  );

  // Apply overrides + removals → final items per van
  const finalItemsByVan = useMemo(() => {
    // Deep-copy base items, excluding removals
    const result = new Map<number, VanFlightItem[]>();
    for (const [vanId, items] of baseItemsByVan) {
      result.set(vanId, items.filter((item) => !removals.has(item.arrFlight.id)));
    }

    // Move overridden flights
    for (const [flightId, targetVanId] of overrides) {
      if (removals.has(flightId)) continue; // removed trumps move

      // Check if this flight is already in a van (from base items)
      let found = false;
      for (const [vanId, items] of result) {
        const idx = items.findIndex((item) => item.arrFlight.id === flightId);
        if (idx !== -1) {
          found = true;
          const [removed] = items.splice(idx, 1);
          if (vanId !== targetVanId) {
            const target = result.get(targetVanId) ?? [];
            target.push(removed);
            result.set(targetVanId, target);
          } else {
            items.splice(idx, 0, removed);
          }
          break;
        }
      }

      // Flight came from uncovered pool — find it in allDayArrivals
      if (!found) {
        const item = allDayArrivals.find((a) => a.arrFlight.id === flightId);
        if (item) {
          const target = result.get(targetVanId) ?? [];
          target.push(item);
          result.set(targetVanId, target);
        }
      }
    }

    // Add unscheduled aircraft that have been assigned to vans
    const unschedPositions = unscheduledOverrides.size > 0
      ? computePositionsFromFlights(allFlights, date)
      : [];
    for (const [tail, targetVanId] of unscheduledOverrides) {
      const syntheticId = `unsched_${tail}`;
      const airport = unschedPositions.find((p) => p.tail === tail)?.airport ?? null;
      const info = airport ? getAirportInfo(airport) : null;
      const baseLat = liveVanPositions.get(targetVanId)?.lat ?? FIXED_VAN_ZONES.find((z) => z.vanId === targetVanId)!.lat;
      const baseLon = liveVanPositions.get(targetVanId)?.lon ?? FIXED_VAN_ZONES.find((z) => z.vanId === targetVanId)!.lon;
      const distKm = info ? Math.round(haversineKm(baseLat, baseLon, info.lat, info.lon)) : 0;
      const syntheticFlight: Flight = {
        id: syntheticId,
        ics_uid: syntheticId,
        tail_number: tail,
        departure_icao: airport ? `K${airport}` : null,
        arrival_icao: airport ? `K${airport}` : null,
        scheduled_departure: `${date}T17:00:00Z`,
        scheduled_arrival: `${date}T17:00:00Z`,
        summary: `Unscheduled – ${tail}`,
        flight_type: null,
        alerts: [],
      };
      const item: VanFlightItem = {
        arrFlight: syntheticFlight,
        nextDep: null,
        isRepo: false,
        nextIsRepo: false,
        airport: airport ?? "???",
        airportInfo: info,
        distKm,
      };
      const target = result.get(targetVanId) ?? [];
      target.push(item);
      result.set(targetVanId, target);
    }

    // Recalculate distances + greedy sort for each van, then re-sort by FA ETA
    for (const zone of FIXED_VAN_ZONES) {
      const items = result.get(zone.vanId) ?? [];
      const baseLat = liveVanPositions.get(zone.vanId)?.lat ?? zone.lat;
      const baseLon = liveVanPositions.get(zone.vanId)?.lon ?? zone.lon;
      const withDist = recalcDist(items, baseLat, baseLon);
      // Sort by scheduled arrival time (earliest first)
      const sorted = withDist.sort((a, b) =>
        (a.arrFlight.scheduled_arrival ?? "").localeCompare(b.arrFlight.scheduled_arrival ?? ""),
      );
      result.set(zone.vanId, sorted);
    }

    return result;
  }, [baseItemsByVan, overrides, removals, liveVanPositions, allDayArrivals, flightInfoMap, unscheduledOverrides, allFlights, date]);

  // Uncovered aircraft: arrivals today not assigned to any van
  const uncoveredItems = useMemo(() => {
    const assignedIds = new Set<string>();
    for (const items of finalItemsByVan.values()) {
      for (const item of items) assignedIds.add(item.arrFlight.id);
    }
    return allDayArrivals.filter((item) => !assignedIds.has(item.arrFlight.id));
  }, [allDayArrivals, finalItemsByVan]);

  // Unscheduled aircraft: fleet tails with NO flights on this date
  const unscheduledAircraft = useMemo(() => {
    // All fleet tails = tails from live flights + fallback roster
    const allTails = new Set<string>(FALLBACK_TAILS);
    for (const f of allFlights) {
      if (f.tail_number) allTails.add(f.tail_number);
    }

    // Tails that have ANY flight on this date (departure or arrival)
    const scheduledTails = new Set<string>();
    for (const f of allFlights) {
      if (!f.tail_number) continue;
      if (isOnEtDate(f.scheduled_departure, date) || isOnEtDate(f.scheduled_arrival, date)) {
        // Exclude non-flight types (Time off, Assignment, etc.)
        const ft = inferFlightType(f);
        if (ft && NON_FLIGHT_TYPES.has(ft)) continue;
        scheduledTails.add(f.tail_number);
      }
    }

    // Unscheduled = fleet minus scheduled
    const unscheduled = Array.from(allTails).filter((t) => !scheduledTails.has(t)).sort();

    // Determine each tail's current location using overnight position logic
    const positions = computePositionsFromFlights(allFlights, date);
    const posMap = new Map<string, AircraftOvernightPosition>();
    for (const p of positions) posMap.set(p.tail, p);

    return unscheduled.map((tail) => {
      const pos = posMap.get(tail);
      const airport = pos?.airport ?? null;
      const airportInfo = airport ? getAirportInfo(airport) : null;
      return {
        tail,
        airport,
        airportInfo,
        lat: airportInfo?.lat ?? pos?.lat ?? 0,
        lon: airportInfo?.lon ?? pos?.lon ?? 0,
      };
    });
  }, [allFlights, date]);

  // Is it after 5pm ET right now?
  const isAfter5pmET = useMemo(() => {
    const now = new Date();
    const etHour = parseInt(now.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "America/New_York" }));
    return etHour >= 17;
  }, []); // static for the lifecycle of the component — re-renders won't matter much

  // Track which vans have been manually edited
  const editedVans = useMemo(() => {
    const set = new Set<number>();
    for (const targetVanId of overrides.values()) set.add(targetVanId);
    // Also mark source vans (vans that lost an item)
    for (const [flightId] of overrides) {
      for (const [vanId, items] of baseItemsByVan) {
        if (items.some((item) => item.arrFlight.id === flightId)) {
          set.add(vanId);
          break;
        }
      }
    }
    return set;
  }, [overrides, baseItemsByVan]);

  // ── Drag-and-drop handlers ──
  const handleDragStart = useCallback((e: React.DragEvent, flightId: string, fromVanId: number) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ flightId, fromVanId }));
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toVanId: number) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDropTargetVan(null);

    try {
      const { flightId, fromVanId } = JSON.parse(e.dataTransfer.getData("text/plain"));
      if (fromVanId === toVanId) return;

      // Handle unscheduled aircraft drops (synthetic IDs start with "unsched_")
      if (typeof flightId === "string" && flightId.startsWith("unsched_")) {
        const tail = flightId.replace("unsched_", "");
        setUnscheduledOverrides((prev) => {
          const next = new Map(prev);
          if (fromVanId === -2 || toVanId > 0) {
            next.set(tail, toVanId);
          }
          return next;
        });
        return;
      }

      // If dragged from uncovered pool, clear any prior removal
      setRemovals((prev) => {
        if (!prev.has(flightId)) return prev;
        const next = new Set(prev);
        next.delete(flightId);
        return next;
      });
      setOverrides((prev) => {
        const next = new Map(prev);
        next.set(flightId, toVanId);
        return next;
      });
    } catch { /* ignore bad data */ }
  }, []);

  const handleRemove = useCallback((flightId: string) => {
    // Handle unscheduled aircraft removal
    if (flightId.startsWith("unsched_")) {
      const tail = flightId.replace("unsched_", "");
      setUnscheduledOverrides((prev) => {
        if (!prev.has(tail)) return prev;
        const next = new Map(prev);
        next.delete(tail);
        return next;
      });
      return;
    }
    // Remove any move override for this flight
    setOverrides((prev) => {
      if (!prev.has(flightId)) return prev;
      const next = new Map(prev);
      next.delete(flightId);
      return next;
    });
    // Add to removals
    setRemovals((prev) => {
      const next = new Set(prev);
      next.add(flightId);
      return next;
    });
  }, []);

  const handleDragEnterZone = useCallback((vanId: number) => {
    dragCounterRef.current++;
    setDropTargetVan(vanId);
  }, []);

  const handleDragLeaveZone = useCallback(() => {
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDropTargetVan(null);
    }
  }, []);

  // Current edits fingerprint — changes when overrides or removals change
  const currentEditsFingerprint = useMemo(() => {
    const parts: string[] = [];
    for (const [fId, vId] of overrides) parts.push(`m:${fId}:${vId}`);
    for (const fId of removals) parts.push(`r:${fId}`);
    for (const [tail, vId] of unscheduledOverrides) parts.push(`u:${tail}:${vId}`);
    // Also include the base flight IDs per van to detect schedule data changes
    for (const [vanId, items] of finalItemsByVan) {
      parts.push(`v${vanId}:${items.map((i) => i.arrFlight.id).join(",")}`);
    }
    return parts.sort().join("|");
  }, [overrides, removals, unscheduledOverrides, finalItemsByVan]);

  const hasUnpublishedChanges = publishedAt && currentEditsFingerprint !== publishedEditsSnapshot;

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      const assignments = FIXED_VAN_ZONES.map((zone) => ({
        vanId: zone.vanId,
        flightIds: (finalItemsByVan.get(zone.vanId) ?? []).map((item) => item.arrFlight.id),
      }));
      const res = await fetch("/api/vans/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, assignments }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPublishError(data.error ?? "Publish failed");
      } else {
        setPublishedAt(data.published_at);
        setPublishedEditsSnapshot(currentEditsFingerprint);
      }
    } catch {
      setPublishError("Network error");
    }
    setPublishing(false);
  }, [date, finalItemsByVan, currentEditsFingerprint]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-gray-500">
          Arrivals plan for {fmtLongDate(date)} · up to {MAX_ARRIVALS_PER_VAN} aircraft per van · 5 h drive limit
          {hasLive && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-green-600 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
              distances from live GPS
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {totalEdits > 0 && (
            <button
              onClick={() => { setOverrides(new Map()); setRemovals(new Set()); setUnscheduledOverrides(new Map()); }}
              className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 hover:bg-amber-100 transition-colors"
            >
              Reset all edits ({totalEdits})
            </button>
          )}
          <button
            onClick={handlePublish}
            disabled={publishing}
            className="text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-400 rounded-lg px-4 py-1.5 transition-colors"
          >
            {publishing ? "Sending…" : "Send to Vans"}
          </button>
        </div>
      </div>

      {/* Publish status */}
      <div className="flex items-center gap-3 flex-wrap">
        {publishedAt && !hasUnpublishedChanges && (
          <span className="text-xs text-green-600 font-medium flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
            Last published: {new Date(publishedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET
          </span>
        )}
        {hasUnpublishedChanges && (
          <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
            Unpublished changes
          </span>
        )}
        {!publishedAt && !publishing && (
          <span className="text-xs text-gray-400">Not yet published for this date</span>
        )}
        {publishError && (
          <span className="text-xs text-red-600 font-medium">{publishError}</span>
        )}
      </div>
      {totalEdits > 0 && (
        <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center gap-2">
          <span className="font-semibold">Manual edits active</span>
          {" — "}
          {[
            overrides.size > 0 && `${overrides.size} moved`,
            removals.size > 0 && `${removals.size} removed`,
          ].filter(Boolean).join(", ")}
          . Distances and route order updated.
        </div>
      )}

      {/* ── Unassigned aircraft pool (draggable into vans) ── */}
      {uncoveredItems.length > 0 && (() => {
        // Group uncovered items by tail
        const uncoveredByTail = new Map<string, VanFlightItem[]>();
        for (const item of uncoveredItems) {
          const key = item.arrFlight.tail_number || "_no_tail";
          const arr = uncoveredByTail.get(key) ?? [];
          arr.push(item);
          uncoveredByTail.set(key, arr);
        }
        // Collect ALL legs for each tail on this day (excluding "other" and non-flight types)
        const allLegsByTail = new Map<string, Flight[]>();
        for (const tail of uncoveredByTail.keys()) {
          if (tail === "_no_tail") continue;
          const legs = allFlights.filter((f) => {
            if (f.tail_number !== tail) return false;
            if (!isOnEtDate(f.scheduled_departure, date) && !isOnEtDate(f.scheduled_arrival, date)) return false;
            const ft = inferFlightType(f);
            const cat = getFilterCategory(ft);
            if (cat === "other") return false;
            if (ft && NON_FLIGHT_TYPES.has(ft)) return false;
            return true;
          });
          if (legs.length > 0) {
            allLegsByTail.set(tail, legs.sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure)));
          }
        }

        const uncoveredTails = Array.from(uncoveredByTail.keys());

        return (
          <div className="border-2 border-dashed border-red-200 rounded-xl bg-red-50/50 overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center text-xs">
                  !
                </div>
                <div>
                  <div className="text-sm font-semibold text-red-800">
                    Unassigned Aircraft
                  </div>
                  <div className="text-xs text-red-600">
                    {uncoveredTails.filter((t) => t !== "_no_tail").length} aircraft not covered by any van — drag into a van to assign
                  </div>
                </div>
              </div>
            </div>
            <div className="border-t border-red-200 divide-y divide-red-100">
              {uncoveredTails.map((tailKey) => {
                const items = uncoveredByTail.get(tailKey) ?? [];
                const tail = items[0].arrFlight.tail_number;
                const primaryItem = items[0]; // for drag-and-drop assignment
                const allLegs = allLegsByTail.get(tailKey) ?? [];
                // Check for maintenance (same-airport flights)
                const hasMaintenance = allLegs.some((f) =>
                  f.departure_icao && f.arrival_icao && f.departure_icao === f.arrival_icao
                );
                // Flying again from last VanFlightItem
                const lastItem = items[items.length - 1];
                const nextDep = lastItem?.nextDep ?? null;
                const nextIsRepo = lastItem?.nextIsRepo ?? false;
                const lastArrTime = lastItem?.arrFlight.scheduled_arrival
                  ? new Date(lastItem.arrFlight.scheduled_arrival).getTime() : null;
                const uncovGroundMs = nextDep && lastArrTime
                  ? new Date(nextDep.scheduled_departure).getTime() - lastArrTime : Infinity;
                const uncovDoneForDay = !nextDep || uncovGroundMs >= 6 * 3600000;
                const uncovQuickturn = !!nextDep && uncovGroundMs < 2 * 3600000;
                return (
                  <div
                    key={tailKey}
                    draggable
                    onDragStart={(e) => handleDragStart(e, primaryItem.arrFlight.id, 0)}
                    className="px-4 py-2 cursor-grab active:cursor-grabbing hover:bg-red-50/50"
                  >
                    {/* Header: tail number + badges + assign dropdown */}
                    <div className="flex items-center justify-between gap-4 mb-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="w-2.5 h-2.5 rounded-full bg-red-300 flex-shrink-0" />
                        <span className="font-mono font-semibold text-sm">{tail ?? "—"}</span>
                        <span className="text-xs bg-red-100 text-red-600 rounded px-1.5 py-0.5">No Van</span>
                        {hasMaintenance && (
                          <span className="text-xs bg-orange-100 text-orange-700 rounded-full px-2 py-0.5 font-semibold">
                            Maintenance Scheduled
                          </span>
                        )}
                        {/* Quickturn + Done-for-day badges hidden for unassigned aircraft */}
                      </div>
                      <select
                        className="text-xs border border-red-200 rounded-lg px-2 py-1.5 bg-white text-red-700 font-medium cursor-pointer hover:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-300 appearance-none"
                        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%23b91c1c' stroke-width='1.5'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 6px center", paddingRight: "22px" }}
                        value=""
                        onChange={(e) => {
                          const vanId = Number(e.target.value);
                          if (!vanId) return;
                          setRemovals((prev) => {
                            if (!prev.has(primaryItem.arrFlight.id)) return prev;
                            const next = new Set(prev);
                            next.delete(primaryItem.arrFlight.id);
                            return next;
                          });
                          setOverrides((prev) => {
                            const next = new Map(prev);
                            next.set(primaryItem.arrFlight.id, vanId);
                            return next;
                          });
                        }}
                      >
                        <option value="">Assign…</option>
                        {FIXED_VAN_ZONES.map((z) => (
                          <option key={z.vanId} value={z.vanId}>
                            V{z.vanId} – {z.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {/* All legs + flying again */}
                    <div className="ml-5 space-y-0">
                      {allLegs.map((f) => {
                        const ft = inferFlightType(f);
                        const cat = getFilterCategory(ft);
                        const dep = f.departure_icao?.replace(/^K/, "") ?? "?";
                        const arrIcao = f.arrival_icao?.replace(/^K/, "") ?? "?";
                        const isMaint = dep === arrIcao;
                        return (
                          <div key={f.id} className="flex items-center gap-2 text-xs text-gray-600 py-px">
                            <span className="font-mono">{dep} → {arrIcao}</span>
                            <span>{fmtUtcHM(f.scheduled_departure, f.departure_icao)}{f.scheduled_arrival ? ` – ${fmtUtcHM(f.scheduled_arrival, f.arrival_icao)}` : ""}</span>
                            {ft && (
                              <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                                isMaint ? "bg-orange-50 text-orange-600"
                                : cat === "charter" ? "bg-green-50 text-green-600"
                                : cat === "positioning" ? "bg-purple-50 text-purple-600"
                                : cat === "maintenance" ? "bg-orange-50 text-orange-600"
                                : "bg-gray-50 text-gray-500"
                              }`}>
                                {ft}
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {nextDep && (
                        <div className="flex items-center gap-2 text-xs py-px">
                          <span className={nextIsRepo ? "text-purple-600 font-medium" : "text-blue-600 font-medium"}>
                            Flying again {fmtTimeUntil(nextDep.scheduled_departure) && `${fmtTimeUntil(nextDep.scheduled_departure)} · `}{fmtUtcHM(nextDep.scheduled_departure, nextDep.departure_icao)} → {nextDep.arrival_icao?.replace(/^K/, "") ?? "?"}
                          </span>
                          {nextIsRepo && <span className="text-purple-400">(repo)</span>}
                        </div>
                      )}
                    </div>
                    {/* MX notes from JetInsight */}
                    <MxNoteInline notes={mxNotesByTail.get(tail ?? "") ?? []} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Unscheduled aircraft (no flights today) ── */}
      {(() => {
        // Filter out tails already assigned to a van via unscheduledOverrides
        const visibleUnscheduled = unscheduledAircraft.filter(
          (a) => !unscheduledOverrides.has(a.tail),
        );
        if (visibleUnscheduled.length === 0) return null;

        return (
          <div className={`border-2 border-dashed border-amber-200 rounded-xl bg-amber-50/50 overflow-hidden ${!isAfter5pmET ? "opacity-60" : ""}`}>
            <div className="px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center text-xs text-amber-700 font-bold">
                  ?
                </div>
                <div>
                  <div className="text-sm font-semibold text-amber-800">
                    Unscheduled Aircraft
                    <span className="ml-1.5 text-xs font-normal text-amber-600">({visibleUnscheduled.length})</span>
                  </div>
                  <div className="text-xs text-amber-600">
                    {isAfter5pmET
                      ? "No flights today — drag into a van to assign"
                      : "Available after 5pm ET — drag into a van to assign early"}
                  </div>
                </div>
              </div>
            </div>
            <div className="border-t border-amber-200 divide-y divide-amber-100">
              {visibleUnscheduled.map((ac) => (
                <div
                  key={ac.tail}
                  draggable
                  onDragStart={(e) => handleDragStart(e, `unsched_${ac.tail}`, -2)}
                  className="px-4 py-2 cursor-grab active:cursor-grabbing hover:bg-amber-50/80"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="w-2.5 h-2.5 rounded-full bg-amber-300 flex-shrink-0" />
                      <span className="font-mono font-semibold text-sm">{ac.tail}</span>
                      {ac.airport && (
                        <span className="text-xs text-gray-500 font-mono">{ac.airport}</span>
                      )}
                      <span className="text-xs bg-amber-100 text-amber-700 rounded px-1.5 py-0.5">No Schedule</span>
                    </div>
                    <select
                      className="text-xs border border-amber-200 rounded-lg px-2 py-1.5 bg-white text-amber-700 font-medium cursor-pointer hover:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-300 appearance-none"
                      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%23b45309' stroke-width='1.5'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 6px center", paddingRight: "22px" }}
                      value=""
                      onChange={(e) => {
                        const vanId = Number(e.target.value);
                        if (!vanId) return;
                        setUnscheduledOverrides((prev) => {
                          const next = new Map(prev);
                          next.set(ac.tail, vanId);
                          return next;
                        });
                      }}
                    >
                      <option value="">Assign...</option>
                      {FIXED_VAN_ZONES.map((z) => (
                        <option key={z.vanId} value={z.vanId}>
                          V{z.vanId} – {z.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {ac.airportInfo && (
                    <div className="ml-5 text-xs text-gray-500 mt-0.5">
                      {ac.airportInfo.name}, {ac.airportInfo.state}
                    </div>
                  )}
                  <MxNoteInline notes={mxNotesByTail.get(ac.tail) ?? []} />
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {FIXED_VAN_ZONES.map((zone) => {
        const color = VAN_COLORS[(zone.vanId - 1) % VAN_COLORS.length];
        return (
          <div
            key={zone.vanId}
            onDragEnter={() => handleDragEnterZone(zone.vanId)}
            onDragLeave={() => handleDragLeaveZone()}
          >
            <VanScheduleCard
              zone={zone}
              color={color}
              items={finalItemsByVan.get(zone.vanId) ?? []}
              date={date}
              allFlights={allFlights}
              liveVanPos={liveVanPositions.get(zone.vanId)}
              liveAddress={liveVanAddresses.get(zone.vanId)}
              samsaraVanName={vanZoneNames.get(zone.vanId)}
              isDropTarget={dropTargetVan === zone.vanId}
              hasOverrides={editedVans.has(zone.vanId)}
              flightInfoMap={flightInfoMap}
              legNotes={legNotes}
              mxNotesByTail={mxNotesByTail}
              onSaveNote={saveLegNote}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragLeave={() => handleDragLeaveZone()}
              onRemove={handleRemove}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Samsara live van locations — AOG Vans only
// ---------------------------------------------------------------------------

type SamsaraVan = {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  speed_mph: number | null;
  heading: number | null;
  address: string | null;
  gps_time: string | null;
};

type VehicleDiag = {
  id: string;
  name: string;
  odometer_miles: number | null;
  check_engine_on: boolean | null;
  fault_codes: string[];
  diag_time: string | null;
};

/** Vehicles whose name contains "VAN", "AOG", "OG", or "TRAN" are AOG support vans. */
function isAogVehicle(name: string): boolean {
  const u = (name || "").toUpperCase();
  if (u.includes("CLEANING")) return false;
  return u.includes("VAN") || u.includes("AOG") || u.includes(" OG") || u.includes("TRAN");
}

const US_STATE_NAMES: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",
  CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",
  HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",
  KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",
  MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",
  NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",
  NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",
  OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",
  VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
};

/**
 * Parse a Samsara vehicle name like "aog-fl-pbi-van" into a readable label.
 * Extracts state (→ full name) and optional city/airport code.
 * Returns null if the name can't be parsed.
 */
function parseVanDisplayName(samsaraName: string): string | null {
  if (!samsaraName) return null;
  // Normalise: lowercase, split on dashes/spaces/underscores
  const parts = samsaraName.toLowerCase().replace(/[_\s]+/g, "-").split("-").filter(Boolean);
  // Remove noise words
  const noise = new Set(["aog", "van", "og", "tran", "transit", "vehicle"]);
  const meaningful = parts.filter((p) => !noise.has(p));
  if (meaningful.length === 0) return null;

  // Try to find a 2-letter US state code
  let state: string | null = null;
  let city: string | null = null;
  for (const p of meaningful) {
    const upper = p.toUpperCase();
    if (p.length === 2 && US_STATE_NAMES[upper]) {
      state = US_STATE_NAMES[upper];
    } else if (p.length >= 2 && p.length <= 4) {
      city = upper; // likely airport code or city abbreviation
    } else {
      // Longer token — capitalise as city name
      city = p.charAt(0).toUpperCase() + p.slice(1);
    }
  }

  if (state && city) return `${state} – ${city}`;
  if (state) return state;
  if (city) return city;
  return null;
}

/**
 * Match AOG Samsara vans to FIXED_VAN_ZONES by GPS proximity.
 * Returns a Map<zoneId, SamsaraVan> — one van per zone, closest wins.
 * Handles the case where multiple vans are near the same zone by doing
 * a greedy assignment (sort all van↔zone pairs by distance, assign each
 * van/zone at most once).
 */
function matchVansToZones(
  vans: SamsaraVan[],
): Map<number, SamsaraVan> {
  const withGps = vans.filter((v) => v.lat !== null && v.lon !== null);
  if (withGps.length === 0) return new Map();

  // Build all (van, zone, distance) pairs
  const pairs: { van: SamsaraVan; zoneId: number; dist: number }[] = [];
  for (const van of withGps) {
    for (const zone of FIXED_VAN_ZONES) {
      pairs.push({
        van,
        zoneId: zone.vanId,
        dist: haversineKm(van.lat!, van.lon!, zone.lat, zone.lon),
      });
    }
  }
  // Sort by distance ascending — closest pairs first
  pairs.sort((a, b) => a.dist - b.dist);

  const result = new Map<number, SamsaraVan>();
  const usedVans = new Set<string>(); // van IDs already assigned
  for (const { van, zoneId, dist } of pairs) {
    if (result.has(zoneId)) continue;  // zone already has a van
    if (usedVans.has(van.id)) continue; // van already assigned
    if (dist > 1500) continue;          // ignore vans > 1500 km from any zone
    result.set(zoneId, van);
    usedVans.add(van.id);
  }
  return result;
}

function VehicleRow({ v, diag }: { v: SamsaraVan; diag?: VehicleDiag }) {
  const [expanded, setExpanded] = useState(false);
  const celOn = diag?.check_engine_on === true;

  return (
    <div>
      <div
        className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-800">{v.name || v.id}</span>
            {celOn && (
              <span className="text-xs bg-red-100 text-red-700 font-semibold px-2 py-0.5 rounded-full">
                ⚠ Check Engine
              </span>
            )}
          </div>
          <div className="text-xs text-gray-400 font-mono">{v.id}</div>
          <div className="text-xs text-gray-500 truncate mt-0.5">
            {v.address || (v.lat != null ? `${v.lat.toFixed(4)}, ${v.lon?.toFixed(4)}` : "No location")}
          </div>
        </div>
        <div className="text-right shrink-0 space-y-0.5">
          {v.speed_mph != null && (
            <div className="text-sm font-semibold text-gray-700">{Math.round(v.speed_mph)} mph</div>
          )}
          {v.gps_time && <div className="text-xs text-gray-400">{fmtTime(v.gps_time)}</div>}
          <div className="text-xs text-gray-400">{expanded ? "▲ Status" : "▼ Status"}</div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 pt-1 bg-gray-50 border-t text-xs space-y-1.5">
          {diag ? (
            <>
              {diag.odometer_miles !== null && (
                <div className="text-gray-600">
                  Odometer: <span className="font-semibold">{diag.odometer_miles.toLocaleString()} mi</span>
                </div>
              )}
              <div className={diag.check_engine_on === true ? "text-red-600 font-semibold" : diag.check_engine_on === false ? "text-green-600" : "text-gray-400"}>
                Check engine: {diag.check_engine_on === true ? "⚠ ON" : diag.check_engine_on === false ? "✓ Off" : "No data"}
                {diag.fault_codes.length > 0 && (
                  <span className="ml-1 font-mono">— {diag.fault_codes.join(", ")}</span>
                )}
              </div>
              {diag.diag_time && (
                <div className="text-gray-400">Diag as of {fmtTime(diag.diag_time)}</div>
              )}
            </>
          ) : (
            <div className="text-gray-400">No diagnostic data available.</div>
          )}
        </div>
      )}
    </div>
  );
}


function VanLiveLocations({
  vans,
  loading,
  error,
  lastFetch,
  onRefresh,
  diags,
}: {
  vans: SamsaraVan[];
  loading: boolean;
  error: string | null;
  lastFetch: Date | null;
  onRefresh: () => void;
  diags: Map<string, VehicleDiag>;
}) {
  if (loading && vans.length === 0) {
    return (
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 text-sm text-gray-400 animate-pulse">
        Loading van locations…
      </div>
    );
  }

  if (error) {
    const unconfigured = error.includes("not configured") || error.includes("503");
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-5 py-4 flex items-center gap-4">
        <div className="w-9 h-9 rounded-full bg-white border flex items-center justify-center text-lg shrink-0">🚐</div>
        <div>
          <div className="text-sm font-semibold text-gray-700">Van Live Tracking</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {unconfigured ? "Add SAMSARA_API_KEY to Vercel environment variables to enable live locations." : `Samsara error: ${error}`}
          </div>
        </div>
      </div>
    );
  }

  if (vans.length === 0) {
    return (
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 text-sm text-gray-400">
        No AOG vans found in Samsara.
      </div>
    );
  }

  const celAlerts = vans.filter((v) => diags.get(v.id)?.check_engine_on === true);

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      {/* Global alert bar — only when check engine lights are active */}
      {celAlerts.length > 0 && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2.5 flex items-center gap-3">
          <span className="text-sm font-semibold text-red-700">
            ⚠ Check Engine Light — {celAlerts.length} van{celAlerts.length !== 1 ? "s" : ""}
          </span>
          <span className="text-xs text-red-600">
            {celAlerts.map((v) => v.name).join(", ")}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="text-sm font-semibold text-gray-800">
          🚐 AOG Van Live Locations
          <span className="ml-2 text-xs font-normal text-gray-400">via Samsara · {vans.length} vans · click for status</span>
        </div>
        <div className="flex items-center gap-3">
          {lastFetch && (
            <span className="text-xs text-gray-400">
              Updated {lastFetch.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button onClick={onRefresh} disabled={loading} className="text-xs text-blue-600 hover:underline disabled:opacity-50">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="divide-y">
        {vans.map((v) => <VehicleRow key={v.id} v={v} diag={diags.get(v.id)} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3-hour radius constant (~300 km at highway speed)
// ---------------------------------------------------------------------------

const THREE_HOUR_RADIUS_KM = 300;

const haversineKmClient = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ---------------------------------------------------------------------------
// Out-of-range alert banner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

export default function VanPositioningClient({ initialFlights, mxNotes }: { initialFlights: Flight[]; mxNotes?: MxNote[] }) {
  const dates = useMemo(() => getDateRange(7), []); // 7-day window
  const [dayIdx, setDayIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<"map" | "schedule" | "flights">("map");
  const [viewMode, setViewMode] = useState<"map" | "list">("map");
  const [selectedVan, setSelectedVan] = useState<number | null>(null);
  const [mxNotesOpen, setMxNotesOpen] = useState(false);
  const [schedTypeFilter, setSchedTypeFilter] = useState<string>("all");

  const selectedDate = dates[dayIdx];

  // Use live JetInsight flight data for overnight positions; fall back to hardcoded TRIPS if no live data
  const positions = useMemo(() => {
    if (initialFlights.length > 0) {
      const live = computeOvernightPositionsFromFlights(initialFlights, selectedDate);
      if (live.length > 0) return live;
    }
    return computeOvernightPositions(selectedDate);
  }, [initialFlights, selectedDate]);
  const vans       = useMemo(() => assignVans(positions), [positions]);
  const displayedVans = selectedVan === null ? vans : vans.filter((v) => v.vanId === selectedVan);

  // Filter flights to real aircraft movements (exclude scheduling notes)
  const activeFlights = useMemo(
    () => initialFlights.filter((f) => {
      const ft = inferFlightType(f);
      if (!ft) return true; // include flights with unknown type
      return !NON_FLIGHT_TYPES.has(ft);
    }),
    [initialFlights],
  );

  // MX notes grouped by tail number for inline display
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

  // Flights arriving on the selected date (for stats bar) — only active types
  // Use ET date matching so evening flights show on the correct day
  const flightsForDay = useMemo(
    () => activeFlights.filter((f) =>
      isOnEtDate(f.scheduled_arrival ?? f.scheduled_departure, selectedDate)
    ),
    [activeFlights, selectedDate],
  );

  // ALL flights for the selected date (for the Flight Schedule tab)
  // Exclude scheduling notes (non-flight types). Use ET dates.
  const allFlightsForDay = useMemo(
    () => activeFlights
      .filter((f) => isOnEtDate(f.scheduled_departure, selectedDate))
      .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure)),
    [activeFlights, selectedDate],
  );

  // ── Samsara live van data (lifted so map + schedule can both use it) ──
  const [samsaraVans, setSamsaraVans]         = useState<SamsaraVan[]>([]);
  const [samsaraLoading, setSamsaraLoading]   = useState(true);
  const [samsaraError, setSamsaraError]       = useState<string | null>(null);
  const [samsaraLastFetch, setSamsaraLastFetch] = useState<Date | null>(null);

  async function loadSamsara() {
    setSamsaraLoading(true);
    setSamsaraError(null);
    try {
      const res  = await fetch("/api/vans", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) {
        const dbg = data.debug ? ` [SA: ${data.debug.sa}, target: ${data.debug.target}]` : "";
        throw new Error((data.detail || data.error || `HTTP ${res.status}`) + dbg);
      }
      setSamsaraVans(data.vans ?? []);
      setSamsaraLastFetch(new Date());
    } catch (e: unknown) {
      setSamsaraError(String(e));
    } finally {
      setSamsaraLoading(false);
    }
  }

  useEffect(() => { loadSamsara(); }, []);
  useEffect(() => {
    const id = setInterval(loadSamsara, 240_000);
    return () => clearInterval(id);
  }, []);

  const aogSamsaraVans = useMemo(
    () => samsaraVans.filter((v) => isAogVehicle(v.name)),
    [samsaraVans],
  );

  /** GPS-proximity match: zone ID → Samsara van (closest van per zone). */
  const vanZoneMatch = useMemo(() => {
    const match = matchVansToZones(aogSamsaraVans);
    // Debug: log the GPS-based matching results
    if (aogSamsaraVans.length > 0) {
      const rows = FIXED_VAN_ZONES.map((z) => {
        const v = match.get(z.vanId);
        return {
          zone: `V${z.vanId} ${z.name}`,
          samsaraVan: v?.name ?? "—",
          dist: v ? `${Math.round(haversineKm(v.lat!, v.lon!, z.lat, z.lon))} km` : "—",
        };
      });
      console.log("[AOG Vans] GPS-based zone matching:");
      console.table(rows);
      const unmatched = aogSamsaraVans.filter(
        (v) => ![...match.values()].some((m) => m.id === v.id)
      );
      if (unmatched.length) {
        console.log("[AOG Vans] Unmatched AOG vehicles:", unmatched.map((v) => v.name));
      }
    }
    return match;
  }, [aogSamsaraVans]);

  /** Zone ID → last known GPS position (persists across refreshes if signal lost). */
  const lastKnownGpsRef = useRef<Map<number, { lat: number; lon: number }>>(new Map());
  /** Zone ID → last known street address (persists across refreshes if signal lost). */
  const lastKnownAddressRef = useRef<Map<number, string>>(new Map());

  const liveVanPositions = useMemo<Map<number, { lat: number; lon: number }>>(() => {
    // Update cache with fresh positions from matched vans
    for (const [zoneId, v] of vanZoneMatch) {
      if (v.lat !== null && v.lon !== null) {
        lastKnownGpsRef.current.set(zoneId, { lat: v.lat, lon: v.lon });
      }
    }
    // Return live position, or last known if currently null
    const map = new Map<number, { lat: number; lon: number }>();
    for (const [zoneId, v] of vanZoneMatch) {
      const pos = (v.lat !== null && v.lon !== null)
        ? { lat: v.lat, lon: v.lon }
        : lastKnownGpsRef.current.get(zoneId) ?? null;
      if (pos) map.set(zoneId, pos);
    }
    return map;
  }, [vanZoneMatch]);

  /** Zone ID → true if the position is a fresh live reading right now. */
  const liveVanIsLive = useMemo<Map<number, boolean>>(() => {
    const map = new Map<number, boolean>();
    for (const [zoneId, v] of vanZoneMatch) {
      map.set(zoneId, v.lat !== null && v.lon !== null);
    }
    return map;
  }, [vanZoneMatch]);

  /** Zone ID → street address (live, or last known if signal lost). */
  const liveVanAddresses = useMemo<Map<number, string | null>>(() => {
    // Cache fresh addresses
    for (const [zoneId, v] of vanZoneMatch) {
      if (v.address) lastKnownAddressRef.current.set(zoneId, v.address);
    }
    // Return live, or fall back to last known
    const map = new Map<number, string | null>();
    for (const [zoneId, v] of vanZoneMatch) {
      const addr = v.address ?? lastKnownAddressRef.current.get(zoneId) ?? null;
      map.set(zoneId, addr);
    }
    return map;
  }, [vanZoneMatch]);

  /** Zone ID → Samsara van display name (for schedule cards). */
  const vanZoneNames = useMemo<Map<number, string>>(() => {
    const map = new Map<number, string>();
    for (const [zoneId, v] of vanZoneMatch) {
      if (v.name) map.set(zoneId, v.name);
    }
    return map;
  }, [vanZoneMatch]);

  // ── Samsara diagnostics (odometer + check engine light) ──
  const [diagData, setDiagData] = useState<Map<string, VehicleDiag>>(new Map());

  useEffect(() => {
    async function loadDiags() {
      try {
        const res = await fetch("/api/vans/diagnostics", { cache: "no-store" });
        const data = await res.json();
        if (!data.ok) return;
        const map = new Map<string, VehicleDiag>();
        for (const v of (data.vehicles ?? [])) map.set(v.id, v);
        setDiagData(map);
      } catch {}
    }
    loadDiags();
    const id = setInterval(loadDiags, 300_000); // refresh every 5 min
    return () => clearInterval(id);
  }, []);

  // ── FlightAware flight info (ETA, route, origin/destination, positions) ──
  // FlightInfoEntry type is defined at module level
  const [flightInfoMap, setFlightInfoMap] = useState<Map<string, FlightInfoEntry>>(new Map());
  const [faAircraft, setFaAircraft] = useState<AircraftPosition[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadFlightInfo() {
      try {
        const res = await fetch("/api/aircraft/flights", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const map = new Map<string, FlightInfoEntry>();
        const positions: AircraftPosition[] = [];
        for (const f of (data.flights ?? [])) {
          // Prioritise en-route flights so they aren't overwritten by scheduled/completed ones
          const existing = map.get(f.tail);
          const fIsEnRoute = f.status?.includes("En Route");
          if (!existing || fIsEnRoute || (!existing.status?.includes("En Route") && !existing.status?.includes("Landed"))) {
            map.set(f.tail, f);
          }
          // Synthesize map positions from en-route flights with position data
          if (f.latitude != null && f.longitude != null) {
            positions.push({
              tail: f.tail,
              lat: f.latitude,
              lon: f.longitude,
              alt_baro: f.altitude ?? null,
              gs: f.groundspeed ?? null,
              track: f.heading ?? null,
              baro_rate: null,
              on_ground: false,
              squawk: null,
              flight: f.ident ?? null,
              seen: null,
              aircraft_type: null,
              description: null,
            });
          }
        }
        setFlightInfoMap(map);
        setFaAircraft(positions);
      } catch {
        // FlightAware is optional — fail silently
      }
    }
    loadFlightInfo();
    const id = setInterval(loadFlightInfo, 300_000); // refresh every 5 min
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return (
    <div className="space-y-5">
      {/* ── 7-day date strip ── */}
      <DayStrip
        dates={dates}
        selectedIdx={dayIdx}
        onSelect={(i) => { setDayIdx(i); setSelectedVan(null); }}
      />

      {/* ── Stats ── */}
      <StatsBar positions={positions} vans={vans} flightCount={flightsForDay.length} aogVanCount={aogSamsaraVans.length} />

      {/* ── Van Status — vehicle health ── */}
      {(() => {
        const celVans = aogSamsaraVans.filter((v) => diagData.get(v.id)?.check_engine_on === true);
        const hasAlerts = celVans.length > 0;

        return (
          <div className={`rounded-xl border-2 px-5 py-4 shadow-sm ${
            hasAlerts ? "border-red-300 bg-red-50" : "border-green-300 bg-green-50"
          }`}>
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 ${
                hasAlerts ? "bg-red-100" : "bg-green-100"
              }`}>
                {hasAlerts ? "⚠" : "✓"}
              </div>
              <div className="flex-1">
                <div className={`text-base font-bold ${hasAlerts ? "text-red-800" : "text-green-800"}`}>
                  Van Status
                </div>
                {hasAlerts ? (
                  <div className="text-sm text-red-600 font-semibold">
                    {celVans.length} check engine light{celVans.length !== 1 ? "s" : ""}
                  </div>
                ) : (
                  <div className="text-sm text-green-700 font-medium">
                    All {aogSamsaraVans.length} vans clear — no alerts
                  </div>
                )}
              </div>
            </div>
            {hasAlerts && (
              <div className="flex flex-wrap gap-2 mt-3 ml-[52px]">
                {celVans.map((v) => (
                  <span key={`cel-${v.id}`} className="inline-flex items-center gap-1.5 bg-white border border-red-200 rounded-lg px-3 py-1.5 text-xs font-medium text-red-700">
                    {v.name} — Check Engine
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── MX Notes from JetInsight (accordion) ── */}
      {mxNotes && mxNotes.length > 0 && (
        <div className="rounded-xl border-2 border-orange-300 bg-orange-50 px-5 py-4 shadow-sm">
          <button
            onClick={() => setMxNotesOpen((v) => !v)}
            className="flex items-center gap-3 w-full text-left"
          >
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 bg-orange-100">
              !
            </div>
            <div className="text-base font-bold text-orange-800 flex-1">
              Maintenance Notes ({mxNotes.length})
            </div>
            <svg
              className={`w-5 h-5 text-orange-600 transition-transform ${mxNotesOpen ? "rotate-180" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {mxNotesOpen && (
            <div className="flex flex-col gap-2 ml-[52px] mt-2">
              {mxNotes.map((note) => (
                <div key={note.id} className="bg-white border border-orange-200 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-orange-800">{note.tail_number}</span>
                    <span className="text-xs text-orange-600">{note.airport_icao}</span>
                    {note.start_time && (
                      <span className="text-[11px] text-gray-500 ml-auto">
                        {new Date(note.start_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        {note.end_time && ` – ${new Date(note.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-700 mt-0.5">{note.body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="flex gap-3">
        <TabBtn active={activeTab === "map"} onClick={() => setActiveTab("map")}>
          Van Map
        </TabBtn>
        <TabBtn active={activeTab === "schedule"} onClick={() => setActiveTab("schedule")}>
          Schedule
          {vans.length > 0 && (
            <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs font-bold ${
              activeTab === "schedule" ? "bg-blue-500 text-white" : "bg-blue-100 text-blue-700"
            }`}>
              {vans.length}
            </span>
          )}
        </TabBtn>
        <TabBtn active={activeTab === "flights"} onClick={() => setActiveTab("flights")}>
          Flight Schedule
          {flightsForDay.length > 0 && (
            <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs font-bold ${
              activeTab === "flights" ? "bg-blue-500 text-white" : "bg-blue-100 text-blue-700"
            }`}>
              {flightsForDay.length}
            </span>
          )}
        </TabBtn>
      </div>

      {/* ── Van Map tab ── */}
      {activeTab === "map" && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Van filter pills */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedVan(null)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  selectedVan === null
                    ? "bg-slate-800 text-white border-slate-800"
                    : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                }`}
              >
                All Vans
              </button>
              {vans.map((v) => (
                <button
                  key={v.vanId}
                  onClick={() => setSelectedVan(selectedVan === v.vanId ? null : v.vanId)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    selectedVan === v.vanId
                      ? "text-white border-transparent"
                      : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                  }`}
                  style={selectedVan === v.vanId ? { background: VAN_COLORS[(v.vanId - 1) % VAN_COLORS.length] } : {}}
                >
                  Van {v.vanId} · {v.aircraft.length} ac
                </button>
              ))}
            </div>

            {/* Map / List toggle */}
            <div className="flex bg-gray-100 rounded-xl p-1 gap-1">
              {(["map", "list"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setViewMode(v)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    viewMode === v ? "bg-white shadow text-slate-800" : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {v === "map" ? "🗺 Map" : "☰ List"}
                </button>
              ))}
            </div>
          </div>

          {viewMode === "map" ? (
            <div className="rounded-xl overflow-hidden border shadow-sm">
              <MapView vans={displayedVans} colors={VAN_COLORS} liveVanPositions={liveVanPositions} liveVanIsLive={liveVanIsLive} aircraftPositions={faAircraft} flightInfo={flightInfoMap} />
            </div>
          ) : (
            <div className="space-y-3">
              {displayedVans.length === 0 && (
                <div className="text-sm text-gray-500 py-8 text-center">No vans match selection.</div>
              )}
              {displayedVans.map((van) => (
                <AirportCluster
                  key={van.vanId}
                  van={van}
                  color={VAN_COLORS[(van.vanId - 1) % VAN_COLORS.length]}
                />
              ))}
            </div>
          )}

          {/* FlightAware status */}
          {flightInfoMap.size > 0 && (
            <div className="flex flex-col gap-1 text-xs text-gray-500 px-1">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                <span>
                  FlightAware: {faAircraft.length} en-route, {flightInfoMap.size} flights tracked
                </span>
              </div>
            </div>
          )}

          {/* Samsara live locations */}
          <VanLiveLocations
            vans={aogSamsaraVans}
            loading={samsaraLoading}
            error={samsaraError}
            lastFetch={samsaraLastFetch}
            onRefresh={loadSamsara}
            diags={diagData}
          />

          {/* Full aircraft table */}
          <div>
            <div className="text-sm font-semibold text-gray-700 mb-2">
              All Aircraft Overnight Positions · {fmtLongDate(selectedDate)}
            </div>
            <div className="bg-white border rounded-xl overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-3">Tail</th>
                    <th className="px-4 py-3">Airport</th>
                    <th className="px-4 py-3 hidden sm:table-cell">City</th>
                    <th className="px-4 py-3 hidden md:table-cell">State</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 hidden lg:table-cell">Trip</th>
                    <th className="px-4 py-3">Van</th>
                    <th className="px-4 py-3">Range</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {positions.map((p) => {
                    const van = vans.find((v) =>
                      v.aircraft.some((a) => a.tail === p.tail && a.tripId === p.tripId),
                    );
                    const color = van ? VAN_COLORS[(van.vanId - 1) % VAN_COLORS.length] : "#9ca3af";
                    const distKm = van ? Math.round(haversineKmClient(van.lat, van.lon, p.lat, p.lon)) : null;
                    const outOfRange = distKm !== null && distKm > THREE_HOUR_RADIUS_KM;
                    return (
                      <tr
                        key={p.tail + p.tripId}
                        className={`hover:bg-gray-50 ${
                          selectedVan !== null && van?.vanId !== selectedVan ? "opacity-30" : ""
                        } ${outOfRange ? "bg-red-50" : ""}`}
                      >
                        <td className="px-4 py-2.5 font-mono font-semibold">{p.tail}</td>
                        <td className="px-4 py-2.5 font-medium">{p.airport}</td>
                        <td className="px-4 py-2.5 hidden sm:table-cell text-gray-600">{p.city}</td>
                        <td className="px-4 py-2.5 hidden md:table-cell text-gray-500">{p.state}</td>
                        <td className="px-4 py-2.5">{statusBadge(p.tripStatus)}</td>
                        <td className="px-4 py-2.5 hidden lg:table-cell text-gray-400 font-mono text-xs">{p.tripId}</td>
                        <td className="px-4 py-2.5">
                          {van ? (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold text-white"
                              style={{ background: color }}
                            >
                              V{van.vanId}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {distKm !== null ? (
                            <span className={outOfRange ? "text-red-600 font-semibold" : "text-gray-400"}>
                              {outOfRange ? "⚠ " : ""}{distKm} km
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Schedule tab ── */}
      {activeTab === "schedule" && (
        <ScheduleTab allFlights={activeFlights} date={selectedDate} liveVanPositions={liveVanPositions} liveVanAddresses={liveVanAddresses} vanZoneNames={vanZoneNames} flightInfoMap={flightInfoMap} mxNotesByTail={mxNotesByTail} />
      )}

      {/* ── Flight Schedule tab — grouped by aircraft ── */}
      {activeTab === "flights" && (() => {
        // Dedup flights by route + time (prevents duplicate ICS entries)
        const seen = new Set<string>();
        const deduped = allFlightsForDay.filter((f) => {
          const dk = `${f.departure_icao}|${f.arrival_icao}|${f.scheduled_departure}|${f.scheduled_arrival ?? ""}`;
          if (seen.has(dk)) return false;
          seen.add(dk);
          return true;
        });

        // Apply flight type category filter ("all" excludes "other" by default)
        const filtered = schedTypeFilter === "all"
          ? deduped.filter((f) => getFilterCategory(inferFlightType(f)) !== "other")
          : deduped.filter((f) => getFilterCategory(inferFlightType(f)) === schedTypeFilter);

        // Compute counts per category (from deduped, not filtered)
        const catCounts: Record<string, number> = { charter: 0, positioning: 0, maintenance: 0, other: 0 };
        for (const f of deduped) {
          const cat = getFilterCategory(inferFlightType(f));
          catCounts[cat] = (catCounts[cat] ?? 0) + 1;
        }

        // Group flights by tail number (merge all no-tail flights into one group)
        const byTail = new Map<string, Flight[]>();
        for (const f of filtered) {
          const key = f.tail_number || "_no_tail";
          const arr = byTail.get(key) ?? [];
          arr.push(f);
          byTail.set(key, arr);
        }
        // Sort each aircraft's legs by departure time
        for (const legs of byTail.values()) {
          legs.sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
        }
        // Sort aircraft groups: tailed first by first departure, no-tail last
        const groups = Array.from(byTail.entries()).sort((a, b) => {
          if (a[0] === "_no_tail") return 1;
          if (b[0] === "_no_tail") return -1;
          return a[1][0].scheduled_departure.localeCompare(b[1][0].scheduled_departure);
        });
        const uniqueTails = groups.filter(([key]) => key !== "_no_tail").length;
        const totalLegs = filtered.length;

        return (
          <div className="space-y-3">
            <div className="text-sm text-gray-500">
              {fmtLongDate(selectedDate)} · {uniqueTails} aircraft · {totalLegs} legs
            </div>

            {/* Flight type filter pills */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {SCHED_FILTERS.map(({ key, label }) => {
                const isActive = schedTypeFilter === key;
                const count = key === "all" ? deduped.length : catCounts[key] ?? 0;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSchedTypeFilter(key)}
                    className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                      isActive
                        ? key === "charter" ? "bg-green-700 text-white border-green-700"
                        : key === "positioning" ? "bg-purple-700 text-white border-purple-700"
                        : key === "maintenance" ? "bg-orange-600 text-white border-orange-600"
                        : key === "other" ? "bg-gray-700 text-white border-gray-700"
                        : "bg-slate-800 text-white border-slate-800"
                        : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
                    }`}
                  >
                    {label}
                    {count > 0 && (
                      <span className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold rounded-full ${
                        isActive ? "bg-white/30 text-white" : "bg-gray-100 text-gray-600"
                      }`}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {groups.length === 0 ? (
              <div className="bg-white border rounded-xl px-6 py-8 text-center text-sm text-gray-400">
                No flights match the current filter.
              </div>
            ) : (
              <div className="space-y-3">
                {groups.map(([key, legs]) => {
                  const tail = legs[0].tail_number;
                  return (
                    <div key={key} className="bg-white border rounded-xl overflow-hidden shadow-sm">
                      <div className="px-4 py-2.5 border-b bg-gray-50 flex items-center gap-3">
                        <span className="font-mono font-bold text-sm">
                          {tail ?? <span className="text-gray-400">No tail</span>}
                        </span>
                        <span className="text-xs text-gray-400">{legs.length} leg{legs.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="divide-y">
                        {legs.map((f) => {
                          const ft = inferFlightType(f);
                          const dep = f.departure_icao?.replace(/^K/, "") ?? "?";
                          const arr = f.arrival_icao?.replace(/^K/, "") ?? "?";
                          const fi = f.tail_number ? flightInfoMap.get(f.tail_number) : undefined;
                          // Match FA flight to this leg by checking origin matches
                          const faMatchesLeg = fi && fi.origin_icao && f.departure_icao && fi.origin_icao === f.departure_icao;
                          const isEnRoute = faMatchesLeg && (fi?.status === "En Route" || (fi?.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100));
                          const isLanded = faMatchesLeg && (fi?.status === "Landed" || fi?.status === "Arrived");
                          return (
                            <div key={f.id} className="px-4 py-2.5 flex items-center gap-4 flex-wrap">
                              <div className="flex items-center gap-2 min-w-[140px]">
                                <span className="font-mono text-sm text-gray-700">{dep}</span>
                                <span className="text-gray-400">&rarr;</span>
                                <span className="font-mono text-sm text-gray-700">{arr}</span>
                              </div>
                              <div className="text-xs text-gray-600 min-w-[80px]">
                                {fmtTime(f.scheduled_departure, f.departure_icao)}
                              </div>
                              <div className="text-xs text-gray-500 hidden sm:block min-w-[80px]">
                                Arr {fmtTime(f.scheduled_arrival, f.arrival_icao)}
                              </div>
                              <div className="text-xs text-gray-400 hidden md:block min-w-[50px]">
                                {f.scheduled_arrival ? fmtDuration(f.scheduled_departure, f.scheduled_arrival) : "—"}
                              </div>
                              {ft && (
                                <span className={`text-xs rounded px-1.5 py-0.5 font-medium ${
                                  ft === "Revenue" || ft === "Owner" ? "bg-green-100 text-green-700" :
                                  ft === "Positioning" || ft === "Ferry" || ft === "Ferry / Cargo" ? "bg-purple-100 text-purple-700" :
                                  ft === "Maintenance" ? "bg-orange-100 text-orange-700" :
                                  ft === "Training" ? "bg-blue-100 text-blue-700" :
                                  ft === "Transient" ? "bg-yellow-100 text-yellow-700" :
                                  "bg-gray-100 text-gray-600"
                                }`}>
                                  {ft}
                                </span>
                              )}
                              {isEnRoute && (
                                <span className="text-xs rounded-full px-2 py-0.5 font-semibold bg-blue-100 text-blue-700">
                                  En Route{fi?.progress_percent != null ? ` ${fi.progress_percent}%` : ""}
                                </span>
                              )}
                              {isLanded && (
                                <span className="text-xs rounded-full px-2 py-0.5 font-semibold bg-green-100 text-green-700">
                                  Landed
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {/* MX notes from JetInsight */}
                      {(mxNotesByTail.get(tail ?? "") ?? []).length > 0 && (
                        <div className="border-t border-orange-100 px-4 py-2 space-y-1">
                          {(mxNotesByTail.get(tail ?? "") ?? []).map((n) => (
                            <div key={n.id} className="flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-1.5">
                              <span className="text-orange-500 font-bold text-xs mt-0.5 shrink-0">MX</span>
                              <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
                                <span className="text-xs font-medium text-orange-700">{n.airport_icao}</span>
                                <span className="text-xs text-gray-700">{n.body}</span>
                                {n.start_time && (
                                  <span className="text-[11px] text-gray-400 ml-auto shrink-0">
                                    {new Date(n.start_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                    {n.end_time && n.end_time !== n.start_time && ` – ${new Date(n.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

    </div>
  );
}
