"use client";

import dynamic from "next/dynamic";
import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import type { Flight, MxNote, AircraftTag } from "@/lib/opsApi";
import {
  computeOvernightPositions,
  computeOvernightPositionsFromFlights,
  assignVans,
  getDateRange,
  isContiguous48,
  haversineKm,
  FIXED_VAN_ZONES,
  FALLBACK_TAILS,
  BAKER_FLEET,
  VanAssignment,
  AircraftOvernightPosition,
} from "@/lib/maintenanceData";
import { getAirportInfo } from "@/lib/airportCoords";
import type { AircraftPosition } from "./MapView";
import MxBoard from "./MxBoard";
import type { MelItem } from "@/lib/opsApi";

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
  actual_arrival: string | null; route_distance_nm: number | null; diverted: boolean;
  aircraft_type?: string | null; // ICAO type code e.g. "C750", "CL30"
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

    // Walk forward: if there's a same-day departure from this airport, follow it.
    // Stop at the last revenue/charter leg — don't follow positioning/repo legs
    // so the van is assigned to the service airport, not the repo destination.
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
      // If the next leg is positioning/repo, stop here — van services at current airport
      if (isPositioningFlight(nextLeg)) break;
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
// Turn label helpers
// ---------------------------------------------------------------------------

/** Compute the turn status label for an aircraft.
 * < 2h:  "Quick Turn - Aircraft leaving after HH:MM TZ"
 * 2–8h:  "Aircraft Shutting Down - Aircraft leaving in X hours"
 * ≥ 8h or no next dep:  "Done for the Day - Aircraft leaving in X hours" (or just "Done for the Day")
 */
function computeTurnLabel(nextDep: Flight | null, gapMs: number): string {
  if (!nextDep) return "Done for the Day";
  const hours = Math.round(gapMs / 3600000);
  if (gapMs < 2 * 3600000) {
    const depTime = fmtUtcHM(nextDep.scheduled_departure, nextDep.departure_icao);
    return `Quick Turn - Aircraft leaving after ${depTime}`;
  }
  if (gapMs < 8 * 3600000) {
    return `Aircraft Shutting Down - Aircraft leaving in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `Done for the Day - Aircraft leaving in ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Badge colors for turn labels */
function turnBadgeClass(label: string): string {
  if (label.startsWith("Quick Turn")) return "bg-amber-100 text-amber-700";
  if (label.startsWith("Aircraft Shutting Down")) return "bg-orange-100 text-orange-700";
  return "bg-green-100 text-green-700";
}

// ---------------------------------------------------------------------------
// Slack share modal for a van's schedule
// ---------------------------------------------------------------------------

type SlackChannel = { id: string; name: string };
/** Build Slack-ready item payloads from VanFlightItems. Used by single share and bulk share. */
function buildSlackItems(items: VanFlightItem[], flightInfoMap: Map<string, FlightInfoEntry>, fboMap?: Record<string, string>, mxNotesByTail?: Map<string, MxNote[]>) {
  return items.map((item) => {
    const fi = flightInfoMap.get(item.arrFlight.tail_number ?? "");
    const arrMs = item.arrFlight.scheduled_arrival ? new Date(item.arrFlight.scheduled_arrival).getTime() : null;
    const gapMs = item.nextDep && arrMs
      ? new Date(item.nextDep.scheduled_departure).getTime() - arrMs : Infinity;
    const turnLabel = computeTurnLabel(item.nextDep, gapMs);
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
    // Look up FBO name from trip_salespersons (try both ICAO formats)
    const arrIcao = item.arrFlight.arrival_icao ?? "";
    const arrIcaoStripped = arrIcao.replace(/^K/, "");
    const fbo = fboMap?.[`${item.arrFlight.tail_number}:${arrIcao}`]
      ?? fboMap?.[`${item.arrFlight.tail_number}:${arrIcaoStripped}`]
      ?? null;
    // Gather today's MX notes for this tail (ET timezone, same logic as MxNoteInline)
    const tailNotes = mxNotesByTail?.get(item.arrFlight.tail_number ?? "") ?? [];
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const toEtDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const mxNoteTexts = tailNotes
      .filter((n) => {
        if (isMel(n)) return false;
        const startDate = n.start_time ? toEtDate(n.start_time) : null;
        const endDate = n.end_time ? toEtDate(n.end_time) : startDate; // no end_time = single-day
        if (!startDate && !endDate) return true;
        if (startDate && startDate > todayStr) return false; // future
        if (endDate && endDate < todayStr) return false; // past
        return true;
      })
      .map((n) => `${n.airport_icao ?? ""} — ${n.body ?? ""}`.trim());

    return {
      tail: item.arrFlight.tail_number ?? "—",
      airport: item.airport,
      fbo,
      arrivalTime: item.arrFlight.scheduled_arrival ? fmtUtcHM(item.arrFlight.scheduled_arrival, item.arrFlight.arrival_icao) : "—",
      status: slackStatus,
      nextDep: item.nextDep
        ? `Flying again ${fmtUtcHM(item.nextDep.scheduled_departure, item.nextDep.departure_icao)}`
        : "Staying Overnight",
      turnStatus: turnLabel,
      driveTime: item.distKm > 0 ? fmtDriveTime(item.distKm) : undefined,
      mxNotes: mxNoteTexts.length > 0 ? mxNoteTexts : undefined,
    };
  });
}

type SlackShareState = "idle" | "loading-channels" | "picking" | "sending" | "success" | "error";

function SlackShareModal({
  vanName,
  vanId,
  homeAirport,
  date,
  items,
  flightInfoMap,
  fboMap,
  mxNotesByTail,
  onClose,
}: {
  vanName: string;
  vanId: number;
  homeAirport: string;
  date: string;
  items: VanFlightItem[];
  flightInfoMap: Map<string, FlightInfoEntry>;
  fboMap?: Record<string, string>;
  mxNotesByTail?: Map<string, MxNote[]>;
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
        items: buildSlackItems(items, flightInfoMap, fboMap, mxNotesByTail),
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

function isMel(note: MxNote): boolean {
  const text = (note.body ?? note.subject ?? "").trim().toLowerCase();
  return text.startsWith("mel ");
}

function fmtTimeRemaining(endTime: string | null): string | null {
  if (!endTime) return null;
  const end = new Date(endTime).getTime() + 24 * 60 * 60 * 1000; // end of that day
  const diff = end - Date.now();
  if (diff <= 0) return "overdue";
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days > 1) return `${days}d left`;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours > 0) return `${hours}h left`;
  return "<1h left";
}

/** Returns days remaining until midnight of end_time day. Negative = overdue. */
function daysRemaining(endTime: string | null): number {
  if (!endTime) return Infinity;
  const end = new Date(endTime).getTime() + 24 * 60 * 60 * 1000;
  return Math.floor((end - Date.now()) / (24 * 60 * 60 * 1000));
}

/** Single MX note row with expandable description */
function MxNoteRow({ note, onHideForToday, vanOverride, onVanOverride }: {
  note: MxNote;
  onHideForToday?: (id: string) => void;
  vanOverride?: number | null;
  onVanOverride?: (noteId: string, vanId: number | null) => void;
}) {
  const [descOpen, setDescOpen] = useState(false);
  const effectiveVan = note.assigned_van ?? vanOverride ?? null;
  return (
    <div className="rounded-lg px-3 py-1.5 bg-orange-50 border border-orange-200">
      <div className="flex items-start gap-2">
        <span className="font-bold text-xs mt-0.5 shrink-0 text-orange-500">MX</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-orange-700">{note.airport_icao}</span>
            <span className="text-xs text-gray-700">{note.subject || note.body}</span>
            {note.description && (
              <button
                onClick={() => setDescOpen((v) => !v)}
                className="text-[10px] font-medium text-orange-500 hover:text-orange-700 transition-colors"
              >
                {descOpen ? "hide notes" : "notes"}
                <svg className={`w-2.5 h-2.5 inline ml-0.5 transition-transform ${descOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 10 10" stroke="currentColor" strokeWidth={2}><path d="M2.5 3.5l2.5 2.5 2.5-2.5" /></svg>
              </button>
            )}
            {effectiveVan && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">
                V{effectiveVan}{note.scheduled_date ? ` · ${new Date(note.scheduled_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
              </span>
            )}
            {note.end_time && (
              <span className="text-[11px] text-gray-400 ml-auto shrink-0">
                Due {new Date(note.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{(() => { const d = new Date(note.end_time); return d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; })()}
              </span>
            )}
          </div>
          {descOpen && note.description && (
            <div className="mt-1 text-xs text-gray-600 bg-white/60 rounded px-2 py-1 whitespace-pre-wrap border border-orange-100">
              {note.description}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1">
            {onHideForToday && (
              <button
                onClick={() => onHideForToday(note.id)}
                className="text-[10px] font-medium text-orange-400 hover:text-orange-700 hover:bg-orange-50 border border-orange-200 rounded px-2 py-0.5 transition-colors"
              >
                Hide for Today
              </button>
            )}
            {onVanOverride && (
              <select
                value={vanOverride ?? ""}
                onChange={(e) => onVanOverride(note.id, e.target.value ? Number(e.target.value) : null)}
                className="text-[10px] border border-orange-200 rounded px-1.5 py-0.5 bg-white text-gray-600"
              >
                <option value="">Default Van</option>
                {FIXED_VAN_ZONES.map((z) => (
                  <option key={z.vanId} value={z.vanId}>V{z.vanId} {z.name}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Inline MX notes per aircraft — only non-MEL MX items (MELs moved to van-level accordion) */
function MxNoteInline({ notes, hiddenIds, onHideForToday, vanOverrides, onVanOverride, viewDate }: { notes: MxNote[]; hiddenIds?: Set<string>; onHideForToday?: (id: string) => void; vanOverrides?: Map<string, number>; onVanOverride?: (noteId: string, vanId: number | null) => void; viewDate?: string }) {
  const targetDate = viewDate ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const toEtDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const visible = notes.filter((n) => {
    if (hiddenIds?.has(n.id)) return false;
    if (isMel(n)) return false;
    // Compare dates in ET timezone (ISO strings are UTC, display is ET)
    const startDate = n.start_time ? toEtDate(n.start_time) : null;
    const endDate = n.end_time ? toEtDate(n.end_time) : startDate;
    if (!startDate && !endDate) return true;
    if (startDate && startDate > targetDate) return false; // future
    if (endDate && endDate < targetDate) return false; // past
    return true;
  });
  if (visible.length === 0) return null;
  return (
    <div className="ml-8 mt-1 space-y-1">
      {visible.map((n) => (
        <MxNoteRow key={n.id} note={n} onHideForToday={onHideForToday} vanOverride={vanOverrides?.get(n.id) ?? null} onVanOverride={onVanOverride} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Van-level Maintenance Notes accordion — collects all MEL items across aircraft
// ---------------------------------------------------------------------------

// Per-aircraft-type service checklists (ICAO type code → steps)
const DEFAULT_SERVICE_CHECKLISTS: Record<string, { label: string; steps: string[] }> = {
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

// Known tail → type mapping for when FlightAware data isn't available
const TAIL_TYPE_MAP: Record<string, string> = {
  // Challenger 300 (CL30)
  N520FX: "CL30", N541FX: "CL30", N533FX: "CL30", N526FX: "CL30",
  N548FX: "CL30", N555FX: "CL30", N554FX: "CL30", N521FX: "CL30",
  N371BD: "CL30", N883TR: "CL30", N416F: "CL30", N519FX: "CL30",
  N552FX: "CL30", N553FX: "CL30",
  // Cessna Citation X (C750)
  N992MG: "C750", N513JB: "C750", N957JS: "C750", N954JS: "C750",
  N860TX: "C750", N700LH: "C750", N106PC: "C750", N818CF: "C750",
  N733FL: "C750", N988TX: "C750", N703TX: "C750", N910E: "C750",
  N102VR: "C750", N998CX: "C750", N51GB: "C750", N939TX: "C750",
  N301HR: "C750", N971JS: "C750", N125DZ: "C750", N955GH: "C750",
  N125TH: "C750", N201HR: "C750",
};

function getServiceChecklists(): Record<string, { label: string; steps: string[] }> {
  try {
    const saved = localStorage.getItem("vanServiceChecklists");
    if (saved) return JSON.parse(saved);
  } catch {}
  return DEFAULT_SERVICE_CHECKLISTS;
}

function VanMaintenanceAccordion({ items, mxNotesByTail, hiddenIds, onHideForToday, flightInfoMap }: {
  items: VanFlightItem[];
  mxNotesByTail: Map<string, MxNote[]>;
  hiddenIds: Set<string>;
  onHideForToday: (id: string) => void;
  flightInfoMap: Map<string, FlightInfoEntry>;
}) {
  const [melOpen, setMelOpen] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState<string | null>(null);

  // Collect all MEL items across all aircraft in this van
  const allMels: { tail: string; note: MxNote }[] = [];
  for (const item of items) {
    const tail = item.arrFlight.tail_number ?? "";
    const notes = mxNotesByTail.get(tail) ?? [];
    for (const n of notes) {
      if (hiddenIds.has(n.id)) continue;
      if (isMel(n)) allMels.push({ tail, note: n });
    }
  }

  return (
    <div className="border-t">
      {/* Maintenance Notes (MEL) accordion */}
      <button
        onClick={() => setMelOpen((v) => !v)}
        className="w-full px-4 py-2 flex items-center justify-between text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
      >
        <span>Maintenance Notes {allMels.length > 0 && `(${allMels.length})`}</span>
        <span className="text-gray-400">{melOpen ? "▲" : "▼"}</span>
      </button>
      {melOpen && (
        <div className="px-4 pb-2 space-y-1">
          {allMels.length === 0 ? (
            <div className="text-xs text-gray-400 py-1">No active MELs</div>
          ) : (
            allMels.map(({ tail, note: n }) => {
              const days = daysRemaining(n.end_time);
              const timeLeft = fmtTimeRemaining(n.end_time);
              const isUrgent = days < 5;
              return (
                <div key={n.id} className={`flex items-start gap-2 rounded-lg px-3 py-1.5 ${isUrgent ? "bg-red-50 border border-red-200" : "bg-green-50 border border-green-200"}`}>
                  <span className={`font-bold text-xs mt-0.5 shrink-0 ${isUrgent ? "text-red-600" : "text-green-600"}`}>MEL</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-semibold text-gray-700">{tail}</span>
                      <span className={`text-xs font-medium ${isUrgent ? "text-red-700" : "text-green-700"}`}>{n.airport_icao}</span>
                      <span className="text-xs text-gray-700">{n.body}</span>
                      <span className="flex items-center gap-1.5 ml-auto shrink-0">
                        {timeLeft && (
                          <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${
                            timeLeft === "overdue" ? "bg-red-100 text-red-700"
                            : isUrgent ? "bg-red-100 text-red-700"
                            : "bg-green-100 text-green-700"
                          }`}>
                            {timeLeft}
                          </span>
                        )}
                        {n.end_time && (
                          <span className="text-[11px] text-gray-400">
                            Due {new Date(n.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{(() => { const d = new Date(n.end_time); return d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; })()}
                          </span>
                        )}
                      </span>
                    </div>
                    <button
                      onClick={() => onHideForToday(n.id)}
                      className={`text-[10px] font-medium ${isUrgent ? "text-red-400 hover:text-red-700" : "text-green-500 hover:text-green-700"} border ${isUrgent ? "border-red-200" : "border-green-200"} rounded px-2 py-0.5 mt-1 transition-colors`}
                    >
                      Hide for Today
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Per-type Regular Service Checklists */}
      {(() => {
        const checklists = getServiceChecklists();
        // Determine unique aircraft types in this van
        const typesInVan = new Map<string, string>(); // typeCode → label
        for (const item of items) {
          const tail = item.arrFlight.tail_number ?? "";
          const fi = flightInfoMap.get(tail);
          const typeCode = fi?.aircraft_type ?? TAIL_TYPE_MAP[tail];
          if (typeCode && checklists[typeCode]) {
            typesInVan.set(typeCode, checklists[typeCode].label);
          }
        }
        // Fallback: show CL30 (Challenger 300) if no type detected
        if (typesInVan.size === 0 && items.length > 0) {
          typesInVan.set("CL30", "Challenger 300");
        }
        return [...typesInVan.entries()].map(([typeCode, label]) => {
          const cl = checklists[typeCode];
          if (!cl) return null;
          const isOpen = checklistOpen === typeCode;
          return (
            <div key={typeCode}>
              <button
                onClick={() => setChecklistOpen(isOpen ? null : typeCode)}
                className="w-full px-4 py-2 flex items-center justify-between text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors border-t"
              >
                <span className="text-green-600">Regular Service Check — {label}</span>
                <span className="text-gray-400">{isOpen ? "▲" : "▼"}</span>
              </button>
              {isOpen && (
                <div className="px-4 pb-3">
                  <ol className="space-y-1 list-decimal list-inside text-xs text-gray-600">
                    {cl.steps.map((step, i) => (
                      <li key={i} className="py-0.5">{step}</li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          );
        });
      })()}
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
// AircraftCompactRow — compact default with expandable detail
// ---------------------------------------------------------------------------

function AircraftCompactRow({
  arrFlight, nextDep, isRepo, nextIsRepo, airport, airportInfo, distKm,
  fi, arrTime, hasLanded, delayMin, isEnRoute, faLanded,
  turnBadgeLabel, hasMaintenance, extraLegs,
  color, zone, date,
  mxNotes, hiddenTodayMxIds, onHideMxForToday, mxVanOverrides, onVanOverride,
  legNote, onSaveNote, onDragStart, onDragOverItem, onRemove, onSetPrimaryAirport,
}: {
  arrFlight: Flight;
  nextDep: Flight | null;
  isRepo: boolean;
  nextIsRepo: boolean;
  airport: string;
  airportInfo: ReturnType<typeof getAirportInfo>;
  distKm: number;
  fi: FlightInfoEntry | null;
  arrTime: Date | null;
  hasLanded: boolean;
  delayMin: number;
  isEnRoute: boolean;
  faLanded: boolean;
  turnBadgeLabel: string;
  hasMaintenance: boolean;
  extraLegs: Flight[];
  color: string;
  zone: (typeof FIXED_VAN_ZONES)[number];
  date: string;
  mxNotes: MxNote[];
  hiddenTodayMxIds: Set<string>;
  onHideMxForToday: (id: string) => void;
  mxVanOverrides?: Map<string, number>;
  onVanOverride?: (noteId: string, vanId: number | null) => void;
  legNote: string;
  onSaveNote: (flightId: string, tailNumber: string | null, note: string) => void;
  onDragStart: (e: React.DragEvent, flightId: string, fromVanId: number) => void;
  onDragOverItem: (vanId: number, flightId: string, insertBefore: boolean) => void;
  onRemove: (flightId: string) => void;
  onSetPrimaryAirport?: (tail: string, airport: string) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, arrFlight.id, zone.vanId)}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        onDragOverItem(zone.vanId, arrFlight.id, e.clientY < rect.top + rect.height / 2);
      }}
      className="px-4 py-2 cursor-grab active:cursor-grabbing hover:bg-gray-50/50"
    >
      {/* ── Compact row: tail + airport + ETA/schedule + drive time + status + remove ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
            <svg className="w-3 h-3 text-gray-300 cursor-pointer" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2}>
              <path d="M2 4h8M2 8h8" />
            </svg>
          </div>
          <span className="font-mono font-semibold text-sm">{arrFlight.tail_number ?? "—"}</span>
          <span className="text-xs text-gray-500">{airport}{airportInfo ? ` · ${airportInfo.city}, ${airportInfo.state}` : ""}</span>
          <span className="text-xs text-gray-400">· {fmtDriveTime(distKm)}</span>
          <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${turnBadgeClass(turnBadgeLabel)}`}>{turnBadgeLabel}</span>
          {mxNotes.filter((n) => !isMel(n) && (n.assigned_van === zone.vanId || !n.assigned_van)).length > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-700">
              {mxNotes.filter((n) => !isMel(n) && (n.assigned_van === zone.vanId || !n.assigned_van)).length} MX
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Schedule times + ETA */}
          <div className="text-right text-xs whitespace-nowrap">
            {arrFlight.scheduled_departure && (
              <span className="text-gray-400">{fmtUtcHM(arrFlight.scheduled_departure, arrFlight.departure_icao)}</span>
            )}
            {arrTime && (
              <span className="text-gray-400">{" → "}<span className="font-medium text-gray-700">{fmtUtcHM(arrFlight.scheduled_arrival!, arrFlight.arrival_icao)}</span></span>
            )}
          </div>
          {/* Status badge */}
          {fi?.diverted ? (
            <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-red-100 text-red-700">DIVERTED</span>
          ) : faLanded ? (
            <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-green-100 text-green-700">Landed</span>
          ) : isEnRoute ? (
            <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-blue-100 text-blue-700">
              En Route
            </span>
          ) : (
            <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${hasLanded ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>
              {hasLanded ? "Landed" : "Scheduled"}
            </span>
          )}
          {/* Expand/collapse detail */}
          <button
            onClick={(e) => { e.stopPropagation(); setDetailOpen((v) => !v); }}
            className="p-1 rounded-md text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            title="Toggle details"
          >
            <svg className={`w-3 h-3 transition-transform ${detailOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2}>
              <path d="M3 4.5l3 3 3-3" />
            </svg>
          </button>
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

      {/* Next departure (always visible — key for driver) */}
      {nextDep && (
        <div className="ml-8 mt-0.5 text-xs">
          <span className={nextIsRepo ? "text-purple-600 font-medium" : "text-blue-600 font-medium"}>
            Flying again {fmtTimeUntil(nextDep.scheduled_departure) && `${fmtTimeUntil(nextDep.scheduled_departure)} · `}{fmtUtcHM(nextDep.scheduled_departure, nextDep.departure_icao)} → {nextDep.arrival_icao?.replace(/^K/, "") ?? "?"}
            {nextIsRepo && <span className="text-purple-400 font-normal"> (repo)</span>}
          </span>
        </div>
      )}

      {/* MX notes from JetInsight (non-MEL only — MELs in van accordion) */}
      <MxNoteInline notes={mxNotes} hiddenIds={hiddenTodayMxIds} onHideForToday={onHideMxForToday} vanOverrides={mxVanOverrides} onVanOverride={onVanOverride} viewDate={date} />

      {/* ── Expandable detail section ── */}
      {detailOpen && (
        <div className="ml-8 mt-1.5 space-y-1 border-l-2 border-gray-200 pl-3">
          {/* All legs for this tail, sorted chronologically */}
          {(() => {
            const allLegs = [arrFlight, ...extraLegs].sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
            return (
              <div className="space-y-0.5">
                {allLegs.map((f) => {
                  const ft = inferFlightType(f);
                  const cat = getFilterCategory(ft);
                  const dep = f.departure_icao?.replace(/^K/, "") ?? "?";
                  const arrIcao = f.arrival_icao?.replace(/^K/, "") ?? "?";
                  const isNextLeg = nextDep && f.id === nextDep.id;
                  const isRevenue = cat === "charter";
                  const borderColor = cat === "charter" ? "border-green-400"
                    : cat === "positioning" ? "border-purple-300"
                    : cat === "maintenance" ? "border-orange-300"
                    : "border-gray-200";
                  const isPrimary = arrIcao === airport;
                  return (
                    <div
                      key={f.id}
                      className={`flex items-center gap-2 text-xs pl-3 border-l-2 ${borderColor} ${
                        isRevenue ? "py-1 bg-green-50/60 rounded-r font-medium text-gray-700" : "py-px text-gray-400"
                      } ${onSetPrimaryAirport && !isPrimary ? "cursor-pointer hover:bg-blue-50/50" : ""}`}
                      onClick={(e) => {
                        if (!onSetPrimaryAirport || isPrimary) return;
                        e.stopPropagation();
                        onSetPrimaryAirport(arrFlight.tail_number ?? "", arrIcao);
                      }}
                      title={isPrimary ? "Current service airport" : "Click to set as service airport"}
                    >
                      {isPrimary && <span className="text-blue-500">📍</span>}
                      <span className={`font-mono ${isRevenue ? "text-gray-700" : "text-gray-500"}`}>{dep} → {arrIcao}</span>
                      <span>{fmtUtcHM(f.scheduled_departure, f.departure_icao)}{f.scheduled_arrival ? ` – ${fmtUtcHM(f.scheduled_arrival, f.arrival_icao)}` : ""}</span>
                      {ft && (
                        <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                          cat === "positioning" ? "bg-purple-50 text-purple-500"
                          : cat === "charter" ? "bg-green-100 text-green-700"
                          : cat === "maintenance" ? "bg-orange-50 text-orange-500"
                          : ft === "Owner" ? "bg-blue-50 text-blue-500"
                          : "bg-gray-50 text-gray-400"
                        }`}>
                          {ft}
                        </span>
                      )}
                      {isNextLeg && <span className="text-blue-500 font-medium">← next</span>}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {hasMaintenance && (
            <span className="text-xs font-semibold bg-orange-100 text-orange-700 rounded-full px-2 py-0.5">Maint</span>
          )}
          {/* MX director note */}
          <LegNoteInline
            flightId={arrFlight.id}
            tailNumber={arrFlight.tail_number ?? null}
            note={legNote}
            onSave={onSaveNote}
          />
        </div>
      )}
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
  hiddenTodayMxIds,
  onHideMxForToday,
  mxVanOverrides,
  onVanOverride,
  onSaveNote,
  onDragStart,
  onDragOverItem,
  onDragOver,
  onDrop,
  onDragLeave,
  onRemove,
  onSetPrimaryAirport,
  onPublishVan,
  fboMap,
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
  hiddenTodayMxIds: Set<string>;
  onHideMxForToday: (id: string) => void;
  mxVanOverrides?: Map<string, number>;
  onVanOverride?: (noteId: string, vanId: number | null) => void;
  onSaveNote: (flightId: string, tailNumber: string | null, note: string) => void;
  onDragStart: (e: React.DragEvent, flightId: string, fromVanId: number) => void;
  onDragOverItem: (vanId: number, flightId: string, insertBefore: boolean) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, toVanId: number) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onRemove: (flightId: string) => void;  // delete aircraft from this van
  onSetPrimaryAirport?: (tail: string, airport: string) => void;
  onPublishVan?: (vanId: number) => Promise<void>;
  fboMap?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showSlackModal, setShowSlackModal] = useState(false);
  const [publishingVan, setPublishingVan] = useState(false);
  const [showLocation, setShowLocation] = useState(false);
  const dragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      onDragEnter={() => {
        if (!expanded) {
          dragTimerRef.current = setTimeout(() => setExpanded(true), 800);
        }
      }}
      onDrop={(e) => { if (dragTimerRef.current) clearTimeout(dragTimerRef.current); onDrop(e, zone.vanId); }}
      onDragLeave={(e) => { if (dragTimerRef.current) clearTimeout(dragTimerRef.current); onDragLeave(e); }}
    >
      {showSlackModal && (
        <SlackShareModal
          vanName={samsaraVanName ?? zone.name}
          vanId={zone.vanId}
          homeAirport={zone.homeAirport}
          date={date}
          items={items}
          flightInfoMap={flightInfoMap}
          fboMap={fboMap}
          mxNotesByTail={mxNotesByTail}
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
                for (let i = 1; i < parts.length; i++) {
                  const stateMatch = parts[i].match(/^([A-Z]{2})$/);
                  if (stateMatch && i >= 1) {
                    liveCityState = `${parts[i - 1]}, ${stateMatch[1]}`;
                    break;
                  }
                }
              }
              const locationLabel = liveCityState ?? ((samsaraVanName && parseVanDisplayName(samsaraVanName)) || null);
              return (
                <div className="font-semibold text-sm">
                  {zone.name}{locationLabel ? <span className="text-gray-400 font-normal"> ({locationLabel})</span> : ""} <span className="text-gray-400 font-normal">({items.length} aircraft)</span>
                </div>
              );
            })()}
            {showLocation && liveAddress ? (
              <div className="text-xs text-green-600 mt-0.5 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block flex-shrink-0" />
                {liveAddress}
              </div>
            ) : showLocation && liveVanPos ? (
              <div className="text-xs text-gray-400 mt-0.5">
                {liveVanPos.lat.toFixed(3)}, {liveVanPos.lon.toFixed(3)}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {(liveAddress || liveVanPos) && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowLocation((v) => !v); }}
              className={`text-xs border rounded-lg px-2 py-1 transition-colors font-medium ${showLocation ? "text-green-700 bg-green-50 border-green-300" : "text-gray-400 hover:text-green-600 hover:bg-green-50 border-gray-200 hover:border-green-300"}`}
              title={showLocation ? "Hide location" : "Show van location"}
            >
              <svg className="w-3.5 h-3.5 inline -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </button>
          )}
          {onPublishVan && (
            <button
              onClick={async (e) => { e.stopPropagation(); setPublishingVan(true); await onPublishVan(zone.vanId); setPublishingVan(false); }}
              disabled={publishingVan}
              className="text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 border border-gray-200 hover:border-blue-300 rounded-lg px-2 py-1 transition-colors font-medium disabled:opacity-50"
              title="Update this van's driver page"
            >
              {publishingVan ? "Updating..." : "Update Schedule"}
            </button>
          )}
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
                // Only use FA live data when viewing today — tomorrow's flights aren't flying yet
                const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
                const isViewingToday = date === todayEt;
                const fi = isViewingToday ? flightInfoMap.get(arrFlight.tail_number ?? "") : undefined;
                const arrTime = arrFlight.scheduled_arrival ? new Date(arrFlight.scheduled_arrival) : null;
                const hasLanded = isViewingToday && arrTime !== null && arrTime < now;
                const faEtaMs = fi?.arrival_time ? new Date(fi.arrival_time).getTime() : null;
                const schedMs = arrTime ? arrTime.getTime() : null;
                const delayMs = (faEtaMs != null && schedMs != null) ? faEtaMs - schedMs : 0;
                const delayMin = Math.round(delayMs / 60000);
                const isEnRoute = fi?.status?.includes("En Route") ?? false;
                const faLanded = fi?.status?.includes("Landed") ?? false;
                const groundMs = nextDep && arrTime
                  ? new Date(nextDep.scheduled_departure).getTime() - arrTime.getTime()
                  : Infinity;
                const turnBadgeLabel = computeTurnLabel(nextDep, groundMs);
                const extraLegs = (allFlights && arrFlight.tail_number)
                  ? allFlights.filter((f) => {
                      if (f.tail_number !== arrFlight.tail_number) return false;
                      if (f.id === arrFlight.id) return false;
                      if (!(isOnEtDate(f.scheduled_departure, date) || isOnEtDate(f.scheduled_arrival, date))) return false;
                      return getFilterCategory(inferFlightType(f)) !== "other";
                    }).sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure))
                  : [];
                const hasMaintenance = !!(allFlights && arrFlight.tail_number) && allFlights.some((f) =>
                  f.tail_number === arrFlight.tail_number &&
                  f.departure_icao && f.arrival_icao &&
                  f.departure_icao === f.arrival_icao &&
                  (isOnEtDate(f.scheduled_departure, date) || isOnEtDate(f.scheduled_arrival, date))
                );
                return (
                  <AircraftCompactRow
                    key={arrFlight.id}
                    arrFlight={arrFlight}
                    nextDep={nextDep}
                    isRepo={isRepo}
                    nextIsRepo={nextIsRepo}
                    airport={airport}
                    airportInfo={airportInfo}
                    distKm={distKm}
                    fi={fi ?? null}
                    arrTime={arrTime}
                    hasLanded={hasLanded}
                    delayMin={delayMin}
                    isEnRoute={isEnRoute}
                    faLanded={faLanded}
                    turnBadgeLabel={turnBadgeLabel}
                    hasMaintenance={hasMaintenance}
                    extraLegs={extraLegs}
                    color={color}
                    zone={zone}
                    date={date}
                    mxNotes={mxNotesByTail.get(arrFlight.tail_number ?? "") ?? []}
                    hiddenTodayMxIds={hiddenTodayMxIds}
                    onHideMxForToday={onHideMxForToday}
                    mxVanOverrides={mxVanOverrides}
                    onVanOverride={onVanOverride}
                    legNote={legNotes.get(arrFlight.id) ?? ""}
                    onSaveNote={onSaveNote}
                    onDragStart={onDragStart}
                    onDragOverItem={onDragOverItem}
                    onRemove={onRemove}
                    onSetPrimaryAirport={onSetPrimaryAirport}
                  />
                );
              })}
            </div>
          )}
          {/* Maintenance Notes + Service Checklists moved to van driver view (/van/[vanId]) */}
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
  longTermMxTails,
  hiddenTodayMxIds,
  onHideMxForToday,
  mxVanOverrides,
  onVanOverride,
  fboMap,
  wontSeeTodayTails,
  onMarkWontSee,
  onRestoreWontSee,
  onSyncDraftUiState,
  dismissedConflictsRef: parentDismissedConflictsRef,
  dismissedConflictVersion,
}: {
  allFlights: Flight[];
  date: string;
  liveVanPositions: Map<number, { lat: number; lon: number }>;
  liveVanAddresses: Map<number, string | null>;
  vanZoneNames: Map<number, string>;
  flightInfoMap: Map<string, FlightInfoEntry>;
  mxNotesByTail: Map<string, MxNote[]>;
  longTermMxTails: Set<string>;
  hiddenTodayMxIds: Set<string>;
  onHideMxForToday: (id: string) => void;
  mxVanOverrides?: Map<string, number>;
  onVanOverride?: (noteId: string, vanId: number | null) => void;
  fboMap?: Record<string, string>;
  wontSeeTodayTails: Set<string>;
  onMarkWontSee: (tail: string) => void;
  onRestoreWontSee: (tail: string) => void;
  onSyncDraftUiState?: (data: { wont_see_tails?: string[]; dismissed_conflicts?: Record<string, string>; hidden_mx_ids?: string[] }) => void;
  dismissedConflictsRef?: React.MutableRefObject<Record<string, string>>;
  dismissedConflictVersion?: number;
}) {
  const hasLive = liveVanPositions.size > 0;

  // Build dropdown labels that match van box headers (live GPS city → Samsara name → static)
  const vanDropdownLabels = useMemo(() => {
    const map = new Map<number, string>();
    for (const z of FIXED_VAN_ZONES) {
      let label = z.name; // fallback
      const samsaraName = vanZoneNames.get(z.vanId);
      if (samsaraName) {
        const parsed = parseVanDisplayName(samsaraName);
        if (parsed) label = parsed;
      }
      const addr = liveVanAddresses.get(z.vanId);
      if (addr) {
        const parts = addr.split(",").map((p) => p.trim());
        for (let i = 1; i < parts.length; i++) {
          const stateMatch = parts[i].match(/^([A-Z]{2})$/);
          if (stateMatch && i >= 1) {
            label = `${parts[i - 1]}, ${stateMatch[1]}`;
            break;
          }
        }
      }
      map.set(z.vanId, label);
    }
    return map;
  }, [liveVanAddresses, vanZoneNames]);

  const [unassignedOpen, setUnassignedOpen] = useState(false);
  const [unscheduledOpen, setUnscheduledOpen] = useState(false);
  const [wontSeeOpen, setWontSeeOpen] = useState(false);
  const unassignedDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unscheduledDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Manual overrides: flightId → target vanId (moves) + removed flight IDs
  // Shared via database so all admins see the same draft state
  const [overrides, setOverrides] = useState<Map<string, number>>(new Map());
  const [removals, setRemovals] = useState<Set<string>>(new Set());
  // Unscheduled aircraft assigned to vans: tail → vanId
  const [unscheduledOverrides, setUnscheduledOverrides] = useState<Map<string, number>>(new Map());
  // Airport overrides: tail → IATA airport (user clicked a specific leg to set primary)
  const [airportOverrides, setAirportOverrides] = useState<Map<string, string>>(() => {
    try {
      const saved = localStorage.getItem(`vanAirportOverrides-${date}`);
      return saved ? new Map(JSON.parse(saved)) : new Map();
    } catch { return new Map(); }
  });

  const [sortOverrides, setSortOverrides] = useState<Map<number, string[]>>(new Map());

  // Track the last DB updated_at to avoid overwriting fresher data
  const draftUpdatedAtRef = useRef<string | null>(null);
  // Suppress DB save while loading from DB — start suppressed until initial load completes
  const suppressSaveRef = useRef(true);

  // DB-backed UI state refs — synced from parent props for inclusion in draft saves
  const wontSeeTailsRef = useRef<string[]>([]);
  const hiddenMxIdsRef = useRef<string[]>([]);
  useEffect(() => { wontSeeTailsRef.current = [...wontSeeTodayTails]; }, [wontSeeTodayTails]);
  useEffect(() => { hiddenMxIdsRef.current = [...hiddenTodayMxIds]; }, [hiddenTodayMxIds]);

  // Save drafts to DB (debounced) + localStorage fallback
  const saveDraftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveDraftToDb = useCallback((o: Map<string, number>, r: Set<string>, u: Map<string, number>, a: Map<string, string>, s: Map<number, string[]>) => {
    // localStorage fallback (immediate)
    try {
      if (o.size > 0) localStorage.setItem(`vanOverrides-${date}`, JSON.stringify([...o]));
      else localStorage.removeItem(`vanOverrides-${date}`);
      if (r.size > 0) localStorage.setItem(`vanRemovals-${date}`, JSON.stringify([...r]));
      else localStorage.removeItem(`vanRemovals-${date}`);
      if (u.size > 0) localStorage.setItem(`vanUnscheduled-${date}`, JSON.stringify([...u]));
      else localStorage.removeItem(`vanUnscheduled-${date}`);
      if (a.size > 0) localStorage.setItem(`vanAirportOverrides-${date}`, JSON.stringify([...a]));
      else localStorage.removeItem(`vanAirportOverrides-${date}`);
    } catch {}
    // DB save (debounced 500ms)
    if (suppressSaveRef.current) return;
    if (saveDraftTimer.current) clearTimeout(saveDraftTimer.current);
    saveDraftTimer.current = setTimeout(() => {
      // Suppress polling while save is in-flight so it doesn't revert our changes
      suppressSaveRef.current = true;
      fetch("/api/vans/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          overrides: [...o],
          removals: [...r],
          unscheduled: [...u],
          wont_see_tails: wontSeeTailsRef.current,
          dismissed_conflicts: parentDismissedConflictsRef?.current ?? {},
          hidden_mx_ids: hiddenMxIdsRef.current,
          airport_overrides: [...a],
          sort_overrides: [...s],
        }),
      }).then(async (res) => {
        if (res.ok) {
          const d = await res.json().catch(() => null);
          if (d?.updated_at) draftUpdatedAtRef.current = d.updated_at;
        }
      }).catch(() => {}).finally(() => {
        suppressSaveRef.current = false;
      });
    }, 500);
  }, [date]);

  // Suppress auto-save during date transitions — runs synchronously before
  // useEffect so the auto-save can't write stale overrides to the new date.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { suppressSaveRef.current = true; }, [date]);

  // Auto-save on every change (including parent UI-state props)
  useEffect(() => {
    saveDraftToDb(overrides, removals, unscheduledOverrides, airportOverrides, sortOverrides);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, removals, unscheduledOverrides, airportOverrides, sortOverrides, wontSeeTodayTails, hiddenTodayMxIds, dismissedConflictVersion, saveDraftToDb]);

  // Load drafts from DB on mount/date change, fall back to localStorage
  const loadDraftsFromDb = useCallback(async (targetDate: string) => {
    suppressSaveRef.current = true;
    try {
      const res = await fetch(`/api/vans/drafts?date=${targetDate}`);
      if (res.ok) {
        const d = await res.json();
        if (d.updated_at) {
          draftUpdatedAtRef.current = d.updated_at;
          setOverrides(new Map(d.overrides ?? []));
          setRemovals(new Set(d.removals ?? []));
          setUnscheduledOverrides(new Map(d.unscheduled ?? []));
          setAirportOverrides(new Map(d.airport_overrides ?? []));
          setSortOverrides(new Map(d.sort_overrides ?? []));
          // Sync DB-backed UI state to parent
          onSyncDraftUiState?.({
            wont_see_tails: d.wont_see_tails ?? [],
            dismissed_conflicts: d.dismissed_conflicts ?? {},
            hidden_mx_ids: d.hidden_mx_ids ?? [],
          });
          suppressSaveRef.current = false;
          return;
        }
      }
    } catch {}
    // Fall back to localStorage if DB has nothing
    try {
      const savedO = localStorage.getItem(`vanOverrides-${targetDate}`);
      setOverrides(savedO ? new Map(JSON.parse(savedO)) : new Map());
    } catch { setOverrides(new Map()); }
    try {
      const savedR = localStorage.getItem(`vanRemovals-${targetDate}`);
      setRemovals(savedR ? new Set(JSON.parse(savedR)) : new Set());
    } catch { setRemovals(new Set()); }
    try {
      const savedU = localStorage.getItem(`vanUnscheduled-${targetDate}`);
      setUnscheduledOverrides(savedU ? new Map(JSON.parse(savedU)) : new Map());
    } catch { setUnscheduledOverrides(new Map()); }
    try {
      const savedA = localStorage.getItem(`vanAirportOverrides-${targetDate}`);
      setAirportOverrides(savedA ? new Map(JSON.parse(savedA)) : new Map());
    } catch { setAirportOverrides(new Map()); }
    suppressSaveRef.current = false;
  }, []);

  // Poll DB every 15s for other admins' changes
  useEffect(() => {
    const poll = setInterval(async () => {
      // Don't poll while a save is in-flight — would revert to stale data
      if (suppressSaveRef.current) return;
      // Don't poll while the debounce timer is pending — local changes haven't been saved yet
      if (saveDraftTimer.current) return;
      try {
        const res = await fetch(`/api/vans/drafts?date=${date}`);
        if (!res.ok) return;
        const d = await res.json();
        // Only apply if someone else saved something newer
        if (d.updated_at && d.updated_at !== draftUpdatedAtRef.current) {
          suppressSaveRef.current = true;
          draftUpdatedAtRef.current = d.updated_at;
          setOverrides(new Map(d.overrides ?? []));
          setRemovals(new Set(d.removals ?? []));
          setUnscheduledOverrides(new Map(d.unscheduled ?? []));
          setAirportOverrides(new Map(d.airport_overrides ?? []));
          setSortOverrides(new Map(d.sort_overrides ?? []));
          // Sync DB-backed UI state from other admins
          onSyncDraftUiState?.({
            wont_see_tails: d.wont_see_tails ?? [],
            dismissed_conflicts: d.dismissed_conflicts ?? {},
            hidden_mx_ids: d.hidden_mx_ids ?? [],
          });
          setTimeout(() => { suppressSaveRef.current = false; }, 100);
        }
      } catch {}
    }, 15000);
    return () => clearInterval(poll);
  }, [date]);

  // Publish state
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Snapshot of edits at last publish — used to detect unpublished changes
  const [publishedEditsSnapshot, setPublishedEditsSnapshot] = useState<string>("");
  // Slack bulk share state
  const [slackBulkStatus, setSlackBulkStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [slackTestStatus, setSlackTestStatus] = useState<"idle" | "sending" | "success" | "error">("idle");

  // MX director notes per leg
  const [legNotes, setLegNotes] = useState<Map<string, string>>(new Map());

  // Published assignments used to restore overrides
  const [publishedAssignments, setPublishedAssignments] = useState<{ vanId: number; flightIds: string[] }[]>([]);

  // Check existing publish status + load notes + restore overrides on mount / date change
  useEffect(() => {
    setPublishedAt(null);
    setPublishError(null);
    setPublishedEditsSnapshot("");
    setPublishedAssignments([]);
    // Load shared draft overrides from DB (falls back to localStorage)
    loadDraftsFromDb(date);
    fetch(`/api/vans/publish?date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.published_at) setPublishedAt(d.published_at);
        if (d.assignments) setPublishedAssignments(d.assignments);
      })
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
  }, [date, loadDraftsFromDb]);

  const totalEdits = overrides.size + removals.size + unscheduledOverrides.size + airportOverrides.size;

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

  // Auto-scroll when dragging near the top/bottom edge of the viewport
  useEffect(() => {
    const EDGE_ZONE = 120; // px from top/bottom edge to start scrolling
    const MAX_SPEED = 18; // max px per animation frame
    let animFrame: number | null = null;
    let curY = 0;
    let isDragging = false;

    function scroll() {
      const { innerHeight } = window;
      const distFromTop = curY;
      const distFromBottom = innerHeight - curY;
      let speed = 0;
      if (distFromTop < EDGE_ZONE) {
        speed = -Math.round(MAX_SPEED * (1 - distFromTop / EDGE_ZONE));
      } else if (distFromBottom < EDGE_ZONE) {
        speed = Math.round(MAX_SPEED * (1 - distFromBottom / EDGE_ZONE));
      }
      if (speed !== 0 && isDragging) {
        window.scrollBy(0, speed);
        animFrame = requestAnimationFrame(scroll);
      } else {
        animFrame = null;
      }
    }

    function onDragOver(e: DragEvent) {
      curY = e.clientY;
      if (animFrame === null) animFrame = requestAnimationFrame(scroll);
    }
    function onDragStart() { isDragging = true; }
    function onDragEnd() {
      isDragging = false;
      if (animFrame !== null) { cancelAnimationFrame(animFrame); animFrame = null; }
    }

    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragend", onDragEnd);
    document.addEventListener("drop", onDragEnd);
    return () => {
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragend", onDragEnd);
      document.removeEventListener("drop", onDragEnd);
      if (animFrame !== null) cancelAnimationFrame(animFrame);
    };
  }, []);

  // Compute base items for every zone, then deduplicate across zones
  // so each aircraft only appears in the closest van's card.
  // MX preference: if an aircraft has MX notes at an airport within a zone,
  // prefer that zone over pure distance (end-of-day MX servicing).
  const baseItemsByVan = useMemo(() => {
    const raw = new Map<number, VanFlightItem[]>();
    for (const zone of FIXED_VAN_ZONES) {
      const baseLat = liveVanPositions.get(zone.vanId)?.lat ?? zone.lat;
      const baseLon = liveVanPositions.get(zone.vanId)?.lon ?? zone.lon;
      raw.set(zone.vanId, computeZoneItems(zone, allFlights, date, baseLat, baseLon));
    }
    // Deduplicate: if an aircraft appears in multiple zones, prefer zones
    // where the tail has MX notes at nearby airports, then fallback to closest distance
    const claimedFlights = new Set<string>();
    const assignments: { vanId: number; flightId: string; distKm: number; item: VanFlightItem; hasMxInZone: boolean }[] = [];
    for (const [vanId, items] of raw) {
      const zone = FIXED_VAN_ZONES.find((z) => z.vanId === vanId);
      for (const item of items) {
        // Check if this tail has MX notes at an airport within this zone
        const tail = item.arrFlight.tail_number;
        const tailNotes = tail ? (mxNotesByTail.get(tail) ?? []) : [];
        const hasMxInZone = zone ? tailNotes.some((n) => {
          if (!n.airport_icao) return false;
          const iata = n.airport_icao.replace(/^K/, "");
          const info = getAirportInfo(iata);
          return info ? haversineKm(zone.lat, zone.lon, info.lat, info.lon) <= SCHEDULE_ARRIVAL_RADIUS_KM : false;
        }) : false;
        assignments.push({ vanId, flightId: item.arrFlight.id, distKm: item.distKm, item, hasMxInZone });
      }
    }
    // Sort: MX-in-zone first, then by distance
    assignments.sort((a, b) => {
      if (a.hasMxInZone !== b.hasMxInZone) return a.hasMxInZone ? -1 : 1;
      return a.distKm - b.distKm;
    });
    const map = new Map<number, VanFlightItem[]>();
    for (const zone of FIXED_VAN_ZONES) map.set(zone.vanId, []);
    for (const { vanId, flightId, item } of assignments) {
      if (claimedFlights.has(flightId)) continue;
      claimedFlights.add(flightId);
      map.get(vanId)!.push(item);
    }
    return map;
  }, [allFlights, date, liveVanPositions, mxNotesByTail]);

  // Fallback: restore overrides from published assignments if localStorage was empty
  const overridesRestoredRef = useRef<string>("");
  useEffect(() => {
    if (publishedAssignments.length === 0 || baseItemsByVan.size === 0) return;
    if (overridesRestoredRef.current === date) return;
    overridesRestoredRef.current = date;
    // Skip if localStorage already had overrides for this date
    if (overrides.size > 0) return;
    const newOverrides = new Map<string, number>();
    for (const a of publishedAssignments) {
      for (const fid of a.flightIds) {
        let baseVanId: number | undefined;
        for (const [vanId, items] of baseItemsByVan) {
          if (items.some((item) => item.arrFlight.id === fid)) {
            baseVanId = vanId;
            break;
          }
        }
        if (baseVanId !== undefined && baseVanId !== a.vanId) {
          newOverrides.set(fid, a.vanId);
        }
      }
    }
    if (newOverrides.size > 0) setOverrides(newOverrides);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishedAssignments, baseItemsByVan, date]);

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
        pic: null,
        sic: null,
        pax_count: null,
        jetinsight_url: null,
        fa_flight_id: null,
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

    // MX note van overrides: duplicate aircraft to the target van
    if (mxVanOverrides && mxVanOverrides.size > 0) {
      // Build noteId → tail lookup from mxNotesByTail
      const noteToTail = new Map<string, string>();
      for (const [tail, notes] of mxNotesByTail) {
        for (const n of notes) noteToTail.set(n.id, tail);
      }

      for (const [noteId, targetVanId] of mxVanOverrides) {
        const tail = noteToTail.get(noteId);
        if (!tail) continue;

        // Check if this aircraft is already in the target van
        const targetItems = result.get(targetVanId) ?? [];
        if (targetItems.some((item) => item.arrFlight.tail_number === tail)) continue;

        // Find the aircraft in any other van and duplicate it to the target
        let sourceItem: VanFlightItem | undefined;
        for (const items of result.values()) {
          sourceItem = items.find((item) => item.arrFlight.tail_number === tail);
          if (sourceItem) break;
        }
        // Also check allDayArrivals if not in any van
        if (!sourceItem) {
          sourceItem = allDayArrivals.find((a) => a.arrFlight.tail_number === tail);
        }
        if (sourceItem) {
          targetItems.push({ ...sourceItem });
          result.set(targetVanId, targetItems);
        }
      }
    }

    // Apply airport overrides (user clicked a specific leg to set primary airport)
    if (airportOverrides.size > 0) {
      for (const items of result.values()) {
        for (const item of items) {
          const tail = item.arrFlight.tail_number;
          if (!tail) continue;
          const overrideAirport = airportOverrides.get(tail);
          if (!overrideAirport || overrideAirport === item.airport) continue;
          const info = getAirportInfo(overrideAirport);
          if (info) {
            item.airport = overrideAirport;
            item.airportInfo = info;
          }
        }
      }
    }

    // Tail-level dedup: if the same tail ended up in multiple vans (e.g. MX
    // override duplicated it, or base recomputation shifted zone ownership),
    // keep only the explicitly overridden placement, else the closest van.
    const tailVanWinner = new Map<string, number>(); // tail → winning vanId
    for (const [vanId, items] of result) {
      for (const item of items) {
        const tail = item.arrFlight.tail_number;
        if (!tail) continue;
        const existing = tailVanWinner.get(tail);
        if (existing === undefined) {
          tailVanWinner.set(tail, vanId);
        } else {
          // Prefer the van with an explicit override for this flight
          const thisHasOverride = overrides.get(item.arrFlight.id) === vanId;
          const existingItem = result.get(existing)?.find((i) => i.arrFlight.tail_number === tail);
          const existingHasOverride = existingItem ? overrides.get(existingItem.arrFlight.id) === existing : false;
          if (thisHasOverride && !existingHasOverride) {
            tailVanWinner.set(tail, vanId);
          } else if (!thisHasOverride && existingHasOverride) {
            // keep existing
          } else if (item.distKm < (existingItem?.distKm ?? Infinity)) {
            tailVanWinner.set(tail, vanId);
          }
        }
      }
    }
    // Remove losers
    for (const [vanId, items] of result) {
      result.set(vanId, items.filter((item) => {
        const tail = item.arrFlight.tail_number;
        return !tail || tailVanWinner.get(tail) === vanId;
      }));
    }

    // Recalculate distances + apply sort overrides or default arrival-time sort
    for (const zone of FIXED_VAN_ZONES) {
      const items = result.get(zone.vanId) ?? [];
      const baseLat = liveVanPositions.get(zone.vanId)?.lat ?? zone.lat;
      const baseLon = liveVanPositions.get(zone.vanId)?.lon ?? zone.lon;
      const withDist = recalcDist(items, baseLat, baseLon);
      const customOrder = sortOverrides.get(zone.vanId);
      if (customOrder && customOrder.length > 0) {
        // Apply manual sort: items in customOrder first (in that order), then remaining by arrival time
        const orderIndex = new Map(customOrder.map((id, i) => [id, i]));
        withDist.sort((a, b) => {
          const ai = orderIndex.get(a.arrFlight.id);
          const bi = orderIndex.get(b.arrFlight.id);
          if (ai !== undefined && bi !== undefined) return ai - bi;
          if (ai !== undefined) return -1;
          if (bi !== undefined) return 1;
          return (a.arrFlight.scheduled_arrival ?? "").localeCompare(b.arrFlight.scheduled_arrival ?? "");
        });
      } else {
        withDist.sort((a, b) =>
          (a.arrFlight.scheduled_arrival ?? "").localeCompare(b.arrFlight.scheduled_arrival ?? ""),
        );
      }
      result.set(zone.vanId, withDist);
    }

    return result;
  }, [baseItemsByVan, overrides, removals, liveVanPositions, allDayArrivals, flightInfoMap, unscheduledOverrides, allFlights, date, airportOverrides, sortOverrides]);

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
  const dragOverTargetRef = useRef<{ vanId: number; flightId: string; insertBefore: boolean } | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, flightId: string, fromVanId: number) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ flightId, fromVanId }));
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDragOverItem = useCallback((vanId: number, flightId: string, insertBefore: boolean) => {
    dragOverTargetRef.current = { vanId, flightId, insertBefore };
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toVanId: number) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDropTargetVan(null);

    try {
      const { flightId, fromVanId } = JSON.parse(e.dataTransfer.getData("text/plain"));

      // Same-van drop = reorder within the van
      if (fromVanId === toVanId && fromVanId > 0) {
        const target = dragOverTargetRef.current;
        dragOverTargetRef.current = null;
        if (!target || target.flightId === flightId) return; // dropped on itself
        const items = finalItemsByVan.get(toVanId) ?? [];
        const ids = items.map((i) => i.arrFlight.id);
        // Remove the dragged item
        const fromIdx = ids.indexOf(flightId);
        if (fromIdx === -1) return;
        ids.splice(fromIdx, 1);
        // Insert at target position
        const toIdx = ids.indexOf(target.flightId);
        if (toIdx === -1) return;
        ids.splice(target.insertBefore ? toIdx : toIdx + 1, 0, flightId);
        setSortOverrides((prev) => {
          const next = new Map(prev);
          next.set(toVanId, ids);
          return next;
        });
        return;
      }
      dragOverTargetRef.current = null;
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
  }, [finalItemsByVan]);

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

  const shareVansToSlack = useCallback(async (vanIds?: number[]) => {
    setSlackBulkStatus("sending");
    try {
      const isTest = !!vanIds;
      const vans = FIXED_VAN_ZONES
        .filter((zone) => !vanIds || vanIds.includes(zone.vanId))
        .map((zone) => {
          const items = finalItemsByVan.get(zone.vanId) ?? [];
          return {
            vanName: zone.name,
            vanId: zone.vanId,
            homeAirport: zone.homeAirport,
            items: buildSlackItems(items, flightInfoMap, fboMap, mxNotesByTail),
          };
        });
      if (vans.length === 0) {
        setSlackBulkStatus("idle");
        return;
      }
      const res = await fetch("/api/vans/share-slack-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, vans }),
      });
      const data = await res.json();
      setSlackBulkStatus(data.ok ? "success" : "error");
      if (data.ok) setTimeout(() => setSlackBulkStatus("idle"), 3000);
    } catch {
      setSlackBulkStatus("error");
    }
  }, [date, finalItemsByVan, flightInfoMap, fboMap, mxNotesByTail]);

  const shareAllToSlack = useCallback(() => shareVansToSlack(), [shareVansToSlack]);

  const testVanToSlack = useCallback(async (vanId: number) => {
    setSlackTestStatus("sending");
    try {
      const zone = FIXED_VAN_ZONES.find((z) => z.vanId === vanId);
      if (!zone) { setSlackTestStatus("error"); return; }
      const items = finalItemsByVan.get(vanId) ?? [];
      const res = await fetch("/api/vans/share-slack-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          test: true,
          vans: [{
            vanName: zone.name,
            vanId: zone.vanId,
            homeAirport: zone.homeAirport,
            items: buildSlackItems(items, flightInfoMap, fboMap, mxNotesByTail),
          }],
        }),
      });
      const data = await res.json();
      setSlackTestStatus(data.ok ? "success" : "error");
      if (!data.ok) console.error("Slack test failed:", data);
      if (data.ok) setTimeout(() => setSlackTestStatus("idle"), 3000);
    } catch (err) {
      console.error("Slack test error:", err);
      setSlackTestStatus("error");
    }
  }, [date, finalItemsByVan, flightInfoMap]);

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

  const handlePublishVan = useCallback(async (vanId: number) => {
    try {
      const items = finalItemsByVan.get(vanId) ?? [];
      const res = await fetch("/api/vans/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          assignments: [{ vanId, flightIds: items.map((item) => item.arrFlight.id) }],
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setPublishedAt(data.published_at);
      }
    } catch { /* ignore */ }
  }, [date, finalItemsByVan]);

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
              onClick={() => {
                setOverrides(new Map()); setRemovals(new Set()); setUnscheduledOverrides(new Map()); setAirportOverrides(new Map()); setSortOverrides(new Map());
                try { localStorage.removeItem(`vanOverrides-${date}`); localStorage.removeItem(`vanRemovals-${date}`); localStorage.removeItem(`vanUnscheduled-${date}`); localStorage.removeItem(`vanAirportOverrides-${date}`); } catch {}
                // Also clear DB so polling/refresh don't restore old overrides
                fetch("/api/vans/drafts", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ date, overrides: [], removals: [], unscheduled: [], airport_overrides: [] }),
                }).then(async (res) => {
                  const d = await res.json().catch(() => null);
                  if (d?.updated_at) draftUpdatedAtRef.current = d.updated_at;
                }).catch(() => {});
                // Prevent published-assignments restore from immediately re-applying
                overridesRestoredRef.current = date;
              }}
              className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 hover:bg-amber-100 transition-colors"
            >
              Reset all edits ({totalEdits})
            </button>
          )}
          <button
            onClick={() => testVanToSlack(1)}
            disabled={slackTestStatus === "sending"}
            className={`text-xs font-medium border rounded-lg px-2 py-1.5 transition-colors ${
              slackTestStatus === "success" ? "text-green-700 bg-green-50 border-green-200" :
              slackTestStatus === "error" ? "text-red-700 bg-red-50 border-red-200" :
              "text-gray-600 bg-gray-50 hover:bg-gray-100 border-gray-200 hover:border-gray-300"
            } disabled:opacity-50`}
            title="Test: Send only Van 1 (North FL) to Slack"
          >
            {slackTestStatus === "sending" ? "Sending…" : slackTestStatus === "success" ? "Sent!" : slackTestStatus === "error" ? "Failed" : "Test Van 1"}
          </button>
          <button
            onClick={shareAllToSlack}
            disabled={slackBulkStatus === "sending"}
            className="text-sm font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 hover:border-purple-300 disabled:opacity-50 rounded-lg px-3 py-1.5 transition-colors"
          >
            {slackBulkStatus === "sending" ? "Sharing…" : slackBulkStatus === "success" ? "Shared!" : "Share All to Slack"}
          </button>
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

        const uncoveredTails = Array.from(uncoveredByTail.keys()).filter(
          (t) => t === "_no_tail" || !wontSeeTodayTails.has(t),
        );

        if (uncoveredTails.length === 0) return null;

        return (
          <div
            className="border-2 border-dashed border-red-200 rounded-xl bg-red-50/50 overflow-hidden"
            onDragOver={(e) => e.preventDefault()}
            onDragEnter={() => {
              if (!unassignedOpen) {
                unassignedDragTimerRef.current = setTimeout(() => setUnassignedOpen(true), 800);
              }
            }}
            onDragLeave={() => { if (unassignedDragTimerRef.current) clearTimeout(unassignedDragTimerRef.current); }}
          >
            <div
              className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-red-50"
              onClick={() => setUnassignedOpen((v) => !v)}
            >
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center text-xs">
                  !
                </div>
                <div>
                  <div className="text-sm font-semibold text-red-800">
                    Unassigned Aircraft
                    <span className="ml-1.5 text-xs font-normal text-red-600">({uncoveredTails.filter((t) => t !== "_no_tail").length})</span>
                  </div>
                  {!unassignedOpen && (
                    <div className="text-xs text-red-600">
                      drag into a van to assign
                    </div>
                  )}
                </div>
              </div>
              <span className="text-gray-400 text-sm">{unassignedOpen ? "▲" : "▼"}</span>
            </div>
            {unassignedOpen && <div className="border-t border-red-200 divide-y divide-red-100">
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
                      {tail && tail !== "_no_tail" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onMarkWontSee(tail); }}
                          className="text-[10px] font-medium text-gray-400 hover:text-gray-700 hover:bg-gray-100 border border-gray-200 rounded px-2 py-1 shrink-0 transition-colors"
                          title="Mark as reviewed — won't be seen today"
                        >
                          Won&apos;t See
                        </button>
                      )}
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
                    <MxNoteInline notes={mxNotesByTail.get(tail ?? "") ?? []} hiddenIds={hiddenTodayMxIds} onHideForToday={onHideMxForToday} vanOverrides={mxVanOverrides} onVanOverride={onVanOverride} viewDate={date} />
                  </div>
                );
              })}
            </div>}
          </div>
        );
      })()}

      {/* ── Unscheduled aircraft (no flights today) ── */}
      {(() => {
        // Filter out tails already assigned to a van via unscheduledOverrides
        const visibleUnscheduled = unscheduledAircraft.filter(
          (a) => !unscheduledOverrides.has(a.tail) && !longTermMxTails.has(a.tail) && !wontSeeTodayTails.has(a.tail),
        );
        if (visibleUnscheduled.length === 0) return null;

        return (
          <div
            className={`border-2 border-dashed border-amber-200 rounded-xl bg-amber-50/50 overflow-hidden ${!isAfter5pmET ? "opacity-60" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDragEnter={() => {
              if (!unscheduledOpen) {
                unscheduledDragTimerRef.current = setTimeout(() => setUnscheduledOpen(true), 800);
              }
            }}
            onDragLeave={() => { if (unscheduledDragTimerRef.current) clearTimeout(unscheduledDragTimerRef.current); }}
          >
            <div
              className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-amber-50"
              onClick={() => setUnscheduledOpen((v) => !v)}
            >
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center text-xs text-amber-700 font-bold">
                  ?
                </div>
                <div>
                  <div className="text-sm font-semibold text-amber-800">
                    Unscheduled Aircraft
                    <span className="ml-1.5 text-xs font-normal text-amber-600">({visibleUnscheduled.length})</span>
                  </div>
                  {!unscheduledOpen && (
                    <div className="text-xs text-amber-600">
                      {isAfter5pmET
                        ? "No flights today — drag into a van to assign"
                        : "Available after 5pm ET — drag into a van to assign early"}
                    </div>
                  )}
                </div>
              </div>
              <span className="text-gray-400 text-sm">{unscheduledOpen ? "▲" : "▼"}</span>
            </div>
            {unscheduledOpen && <div className="border-t border-amber-200 divide-y divide-amber-100">
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
                    <button
                      onClick={(e) => { e.stopPropagation(); onMarkWontSee(ac.tail); }}
                      className="text-[10px] font-medium text-gray-400 hover:text-gray-700 hover:bg-gray-100 border border-gray-200 rounded px-2 py-1 shrink-0 transition-colors"
                      title="Mark as reviewed — won't be seen today"
                    >
                      Won&apos;t See
                    </button>
                  </div>
                  {ac.airportInfo && (
                    <div className="ml-5 text-xs text-gray-500 mt-0.5">
                      {ac.airportInfo.name}, {ac.airportInfo.state}
                    </div>
                  )}
                  <MxNoteInline notes={mxNotesByTail.get(ac.tail) ?? []} hiddenIds={hiddenTodayMxIds} onHideForToday={onHideMxForToday} vanOverrides={mxVanOverrides} onVanOverride={onVanOverride} viewDate={date} />
                </div>
              ))}
            </div>}
          </div>
        );
      })()}

      {/* ── Reviewed — Won't Be Seen Today ── */}
      {(() => {
        // Collect won't-see tails from both unassigned and unscheduled pools
        const wontSeeTails: { tail: string; airport: string | null; source: string }[] = [];
        // From unassigned (uncovered items)
        if (uncoveredItems.length > 0) {
          const uncoveredByTailWS = new Map<string, VanFlightItem[]>();
          for (const item of uncoveredItems) {
            const key = item.arrFlight.tail_number || "_no_tail";
            const arr = uncoveredByTailWS.get(key) ?? [];
            arr.push(item);
            uncoveredByTailWS.set(key, arr);
          }
          for (const tailKey of uncoveredByTailWS.keys()) {
            if (tailKey === "_no_tail") continue;
            if (wontSeeTodayTails.has(tailKey)) {
              const items = uncoveredByTailWS.get(tailKey) ?? [];
              const apt = items[0]?.airport ?? null;
              wontSeeTails.push({ tail: tailKey, airport: apt, source: "Unassigned" });
            }
          }
        }
        // From unscheduled
        for (const ac of unscheduledAircraft) {
          if (unscheduledOverrides.has(ac.tail) || longTermMxTails.has(ac.tail)) continue;
          if (wontSeeTodayTails.has(ac.tail)) {
            wontSeeTails.push({ tail: ac.tail, airport: ac.airport, source: "Unscheduled" });
          }
        }
        return (
          <div
            className="border-2 border-dashed border-slate-300 rounded-xl bg-slate-50/50 overflow-hidden"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
            onDrop={(e) => {
              e.preventDefault();
              try {
                const data = JSON.parse(e.dataTransfer.getData("text/plain"));
                const tail = data?.tailNumber ?? data?.tail;
                if (tail) onMarkWontSee(tail);
              } catch { /* ignore non-JSON drags */ }
            }}
          >
            <div
              className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-slate-100"
              onClick={() => setWontSeeOpen((v) => !v)}
            >
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-xs text-slate-600 font-bold">
                  &#10003;
                </div>
                <div>
                  <div className="text-sm font-semibold text-slate-700">
                    Reviewed — Won&apos;t Be Seen Today
                    <span className="ml-1.5 text-xs font-normal text-slate-500">({wontSeeTails.length})</span>
                  </div>
                  {!wontSeeOpen && (
                    <div className="text-xs text-slate-500">
                      {wontSeeTails.length === 0
                        ? "Drag aircraft here or click \"Won\u2019t See\" to mark as reviewed"
                        : "Aircraft reviewed and marked as not needing service today"}
                    </div>
                  )}
                </div>
              </div>
              <span className="text-gray-400 text-sm">{wontSeeOpen ? "\u25B2" : "\u25BC"}</span>
            </div>
            {wontSeeOpen && (
              <div className="border-t border-slate-200 divide-y divide-slate-100">
                {wontSeeTails.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-slate-400 italic">No aircraft reviewed yet</div>
                ) : wontSeeTails.map((item) => (
                  <div key={item.tail} className="px-4 py-2 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-slate-300 flex-shrink-0" />
                      <span className="font-mono font-semibold text-sm">{item.tail}</span>
                      {item.airport && (
                        <span className="text-xs text-gray-500 font-mono">{item.airport}</span>
                      )}
                      <span className="text-[10px] bg-slate-200 text-slate-600 rounded px-1.5 py-0.5">{item.source}</span>
                    </div>
                    <button
                      onClick={() => onRestoreWontSee(item.tail)}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2.5 py-1 shrink-0 transition-colors hover:bg-blue-50"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
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
              hiddenTodayMxIds={hiddenTodayMxIds}
              onHideMxForToday={onHideMxForToday}
              mxVanOverrides={mxVanOverrides}
              onVanOverride={onVanOverride}
              onSaveNote={saveLegNote}
              onDragStart={handleDragStart}
              onDragOverItem={handleDragOverItem}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragLeave={() => handleDragLeaveZone()}
              onRemove={handleRemove}
              onPublishVan={handlePublishVan}
              onSetPrimaryAirport={(tail, apt) => {
                setAirportOverrides((prev) => {
                  const next = new Map(prev);
                  next.set(tail, apt);
                  return next;
                });
              }}
              fboMap={fboMap}
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

// ---------------------------------------------------------------------------
// MX Admin Tab — manage per-type service checklists
// ---------------------------------------------------------------------------

function MxAdminTab() {
  const [checklists, setChecklists] = useState(() => getServiceChecklists());
  const [editingType, setEditingType] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [saved, setSaved] = useState(false);

  function startEdit(typeCode: string) {
    setEditingType(typeCode);
    setEditText(checklists[typeCode]?.steps.join("\n") ?? "");
    setSaved(false);
  }

  function saveEdit() {
    if (!editingType) return;
    const steps = editText.split("\n").map((s) => s.replace(/^\d+[\.\-\)]\s*/, "").trim()).filter(Boolean);
    const updated = {
      ...checklists,
      [editingType]: { ...checklists[editingType], steps },
    };
    setChecklists(updated);
    try { localStorage.setItem("vanServiceChecklists", JSON.stringify(updated)); } catch {}
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function resetToDefaults() {
    setChecklists(DEFAULT_SERVICE_CHECKLISTS);
    try { localStorage.removeItem("vanServiceChecklists"); } catch {}
    setEditingType(null);
    setSaved(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Service Checklists by Aircraft Type</h3>
        <button
          onClick={resetToDefaults}
          className="text-xs text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded px-2 py-1 transition-colors"
        >
          Reset to Defaults
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Object.entries(checklists).map(([typeCode, cl]) => (
          <div key={typeCode} className="border border-gray-200 rounded-xl p-4 bg-white">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-sm font-semibold text-gray-800">{cl.label}</span>
                <span className="text-xs text-gray-400 ml-2">({typeCode})</span>
              </div>
              <button
                onClick={() => editingType === typeCode ? setEditingType(null) : startEdit(typeCode)}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                {editingType === typeCode ? "Cancel" : "Edit"}
              </button>
            </div>
            {editingType === typeCode ? (
              <div className="space-y-2">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full text-xs border border-gray-200 rounded-lg p-2 h-40 font-mono focus:outline-none focus:ring-1 focus:ring-blue-400"
                  placeholder="One step per line..."
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={saveEdit}
                    className="text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded px-3 py-1 transition-colors"
                  >
                    Save
                  </button>
                  {saved && <span className="text-xs text-green-600 font-medium">Saved!</span>}
                </div>
              </div>
            ) : (
              <ol className="space-y-0.5 list-decimal list-inside text-xs text-gray-600">
                {cl.steps.map((step, i) => (
                  <li key={i} className="py-0.5">{step}</li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
      <div className="text-xs text-gray-400">
        Checklists are stored locally in your browser. Changes apply immediately to the Regular Service Check section in each van.
      </div>
    </div>
  );
}

export default function VanPositioningClient({ initialFlights, mxNotes, melItems = [], aircraftTags = [], fboMap = {} }: { initialFlights: Flight[]; mxNotes?: MxNote[]; melItems?: MelItem[]; aircraftTags?: AircraftTag[]; fboMap?: Record<string, string> }) {
  const dates = useMemo(() => getDateRange(2), []); // today + tomorrow
  const [dayIdx, setDayIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<"map" | "schedule" | "flights" | "mx-admin">("schedule");
  const [viewMode, setViewMode] = useState<"map" | "list">("map");
  const [selectedVan, setSelectedVan] = useState<number | null>(null);
  const [mxNotesOpen, setMxNotesOpen] = useState(false);
  const [melAccordionOpen, setMelAccordionOpen] = useState(false);
  const [mxConflictsOpen, setMxConflictsOpen] = useState(false);
  const [dismissedMxIds, setDismissedMxIds] = useState<Set<string>>(new Set());

  // DB-backed UI state (shared across all admins via drafts API)
  const [wontSeeTodayTails, setWontSeeTodayTails] = useState<Set<string>>(new Set());
  const [hiddenTodayMxIds, setHiddenTodayMxIds] = useState<Set<string>>(new Set());
  const dismissedConflictHashesRef = useRef<Record<string, string>>({});

  // Van overrides for MX notes — allows assigning individual MX notes to different vans
  const [mxVanOverrides, setMxVanOverrides] = useState<Map<string, number>>(new Map());

  // Load van overrides on mount
  useEffect(() => {
    fetch("/api/ops/mx-van-override")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.overrides) return;
        const map = new Map<string, number>();
        for (const o of data.overrides as { mx_note_id: string; van_id: number }[]) {
          map.set(o.mx_note_id, o.van_id);
        }
        setMxVanOverrides(map);
      })
      .catch(() => {});
  }, []);

  const handleVanOverride = useCallback(async (noteId: string, vanId: number | null) => {
    // Optimistic update
    setMxVanOverrides((prev) => {
      const next = new Map(prev);
      if (vanId == null) next.delete(noteId);
      else next.set(noteId, vanId);
      return next;
    });
    try {
      await fetch("/api/ops/mx-van-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mxNoteId: noteId, vanId }),
      });
    } catch { /* non-fatal */ }
  }, []);

  const dismissMxNote = useCallback(async (id: string) => {
    // Optimistic UI update
    setDismissedMxIds((prev) => new Set(prev).add(id));
    try {
      await fetch(`/api/ops/alerts/${id}/acknowledge`, { method: "POST" });
    } catch {
      // Revert on failure
      setDismissedMxIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, []);

  // Dismissed MX notes — fetch from API for restore UI
  const [dismissedNotes, setDismissedNotes] = useState<Array<{
    id: string; tail_number: string | null; airport_icao: string | null;
    body: string | null; end_time: string | null; acknowledged_at: string;
  }>>([]);
  const [dismissedOpen, setDismissedOpen] = useState(false);
  const [dismissedLoaded, setDismissedLoaded] = useState(false);

  const loadDismissed = useCallback(async () => {
    if (dismissedLoaded) { setDismissedOpen((v) => !v); return; }
    try {
      const res = await fetch("/api/ops/alerts/dismissed");
      const json = await res.json();
      setDismissedNotes(json.notes ?? []);
      setDismissedLoaded(true);
      setDismissedOpen(true);
    } catch { /* ignore */ }
  }, [dismissedLoaded]);

  const restoreMxNote = useCallback(async (id: string) => {
    try {
      await fetch(`/api/ops/alerts/${id}/acknowledge`, { method: "DELETE" });
      setDismissedNotes((prev) => prev.filter((n) => n.id !== id));
      setDismissedMxIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    } catch { /* ignore */ }
  }, []);

  // Dismiss conflicts by content hash — reappears if MX note changes (DB-backed via drafts)
  const getMxNoteHash = useCallback((note: { body?: string | null; start_time?: string | null; end_time?: string | null; airport_icao?: string | null }) => {
    return `${note.body ?? ""}|${note.start_time ?? ""}|${note.end_time ?? ""}|${note.airport_icao ?? ""}`;
  }, []);

  const [dismissedConflictVersion, setDismissedConflictVersion] = useState(0);
  const dismissConflict = useCallback((id: string, mxNote: { body?: string | null; start_time?: string | null; end_time?: string | null; airport_icao?: string | null }) => {
    const hash = getMxNoteHash(mxNote);
    dismissedConflictHashesRef.current = { ...dismissedConflictHashesRef.current, [id]: hash };
    setDismissedConflictVersion((c) => c + 1);
  }, [getMxNoteHash]);

  const [schedTypeFilter, setSchedTypeFilter] = useState<string>("all");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  // "Hide for Today" — DB-backed via drafts (shared across all admins)
  const hideMxForToday = useCallback((id: string) => {
    setHiddenTodayMxIds((prev) => new Set(prev).add(id));
  }, []);

  // Callback for ScheduleTab to sync UI state loaded from drafts DB
  const handleSyncDraftUiState = useCallback((data: { wont_see_tails?: string[]; dismissed_conflicts?: Record<string, string>; hidden_mx_ids?: string[] }) => {
    if (data.wont_see_tails) setWontSeeTodayTails(new Set(data.wont_see_tails));
    if (data.dismissed_conflicts) {
      dismissedConflictHashesRef.current = data.dismissed_conflicts;
      setDismissedConflictVersion((c) => c + 1);
    }
    if (data.hidden_mx_ids) setHiddenTodayMxIds(new Set(data.hidden_mx_ids));
  }, []);

  // "Won't Be Seen Today" — DB-backed via drafts (shared across all admins)
  const handleMarkWontSee = useCallback((tail: string) => {
    setWontSeeTodayTails((prev) => new Set(prev).add(tail));
  }, []);

  const handleRestoreWontSee = useCallback((tail: string) => {
    setWontSeeTodayTails((prev) => { const next = new Set(prev); next.delete(tail); return next; });
  }, []);

  async function handleResync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/ops/sync-schedule", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setSyncMsg(data.error ?? "Sync failed");
        return;
      }
      const upserted = data.upserted ?? 0;
      const skipped = data.skipped ?? 0;
      setSyncMsg(`${upserted} upserted, ${skipped} skipped`);
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : "Network error");
    } finally {
      setSyncing(false);
    }
  }

  // ── Long-Term Maintenance detection ──────────────────────────────────────
  type LongTermMxAircraft = {
    tail: string;
    reason: string;
    airport: string | null;
    mxDescription: string | null;
    startDate: string | null;
    endDate: string | null;
  };

  const longTermMxAircraft = useMemo(() => {
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const result: LongTermMxAircraft[] = [];
    const qualifiedTails = new Set<string>();

    const allTails = new Set<string>([...FALLBACK_TAILS, ...BAKER_FLEET]);
    for (const f of initialFlights) {
      if (f.tail_number) allTails.add(f.tail_number);
    }

    // 1. MX_NOTE alerts with span > 3 days
    for (const note of mxNotes ?? []) {
      if (!note.tail_number || qualifiedTails.has(note.tail_number)) continue;
      if (note.start_time && note.end_time) {
        const span = new Date(note.end_time).getTime() - new Date(note.start_time).getTime();
        if (span > THREE_DAYS_MS) {
          qualifiedTails.add(note.tail_number);
          result.push({ tail: note.tail_number, reason: "MX event >3 days", airport: note.airport_icao, mxDescription: note.subject || note.body, startDate: note.start_time, endDate: note.end_time });
        }
      }
    }

    // 2. MX flights spanning >3 days (same departure/arrival = stationary)
    const mxFlightsByTail = new Map<string, Flight[]>();
    for (const f of initialFlights) {
      if (!f.tail_number || qualifiedTails.has(f.tail_number)) continue;
      if (f.flight_type === "Maintenance") {
        if (!mxFlightsByTail.has(f.tail_number)) mxFlightsByTail.set(f.tail_number, []);
        mxFlightsByTail.get(f.tail_number)!.push(f);
      }
    }
    for (const [tail, mxFlts] of mxFlightsByTail) {
      if (qualifiedTails.has(tail)) continue;
      const sorted = [...mxFlts].sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
      if (sorted.length > 0) {
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const endTime = last.scheduled_arrival ?? last.scheduled_departure;
        const span = new Date(endTime).getTime() - new Date(first.scheduled_departure).getTime();
        if (span > THREE_DAYS_MS && first.departure_icao === first.arrival_icao) {
          qualifiedTails.add(tail);
          result.push({ tail, reason: "MX flights >3 days", airport: first.departure_icao, mxDescription: first.summary, startDate: first.scheduled_departure, endDate: endTime });
        }
      }
    }

    // 3. Tails with zero non-MX flights in next 3 days
    const threeDaysOut = now + THREE_DAYS_MS;
    for (const tail of allTails) {
      if (qualifiedTails.has(tail)) continue;
      const pastDay = now - 24 * 60 * 60 * 1000;
      const hasNonMxFlight = initialFlights.some(
        (f) =>
          f.tail_number === tail &&
          f.flight_type !== "Maintenance" &&
          new Date(f.scheduled_departure).getTime() >= pastDay &&
          new Date(f.scheduled_departure).getTime() <= threeDaysOut,
      );
      if (!hasNonMxFlight) {
        let lastAirport: string | null = null;
        for (const f of initialFlights) {
          if (f.tail_number === tail && f.arrival_icao) lastAirport = f.arrival_icao;
        }
        const lastMxNote = (mxNotes ?? []).find((n) => n.tail_number === tail);
        qualifiedTails.add(tail);
        result.push({ tail, reason: "No flights for 3+ days", airport: lastMxNote?.airport_icao ?? lastAirport, mxDescription: lastMxNote?.subject ?? null, startDate: null, endDate: null });
      }
    }

    return result;
  }, [initialFlights, mxNotes]);

  const longTermMxTails = useMemo(
    () => new Set(longTermMxAircraft.map((a) => a.tail)),
    [longTermMxAircraft],
  );

  // ── Conformity tags ─────────────────────────────────────────────────────
  const [localTags, setLocalTags] = useState<Map<string, AircraftTag>>(new Map());
  const [removedTags, setRemovedTags] = useState<Set<string>>(new Set());

  const effectiveTags = useMemo(() => {
    const map = new Map<string, AircraftTag>();
    for (const t of aircraftTags) {
      if (!removedTags.has(t.tail_number + "|" + t.tag)) map.set(t.tail_number + "|" + t.tag, t);
    }
    for (const [key, t] of localTags) map.set(key, t);
    return map;
  }, [aircraftTags, localTags, removedTags]);

  // MX airport — read saved values from tags, allow inline editing
  const mxAirportFromTags = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of aircraftTags) {
      if (t.tag === "MX_Airport" && t.note) map.set(t.tail_number, t.note);
    }
    for (const [key, t] of localTags) {
      if (t.tag === "MX_Airport" && t.note) map.set(t.tail_number, t.note);
    }
    return map;
  }, [aircraftTags, localTags]);

  const [editingMxAirport, setEditingMxAirport] = useState<string | null>(null);
  const [mxAirportDraft, setMxAirportDraft] = useState("");

  const saveMxAirport = useCallback(async (tail: string, airport: string) => {
    const code = airport.trim().toUpperCase();
    const key = tail + "|MX_Airport";
    if (!code) {
      // Remove
      setRemovedTags((prev) => new Set(prev).add(key));
      setLocalTags((prev) => { const next = new Map(prev); next.delete(key); return next; });
      try { await fetch("/api/ops/aircraft-tags", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tail_number: tail, tag: "MX_Airport" }) }); } catch { /* ignore */ }
    } else {
      const optimistic: AircraftTag = { id: "local-" + Date.now(), tail_number: tail, tag: "MX_Airport", note: code, created_by: null, created_at: new Date().toISOString() };
      setLocalTags((prev) => new Map(prev).set(key, optimistic));
      setRemovedTags((prev) => { const next = new Set(prev); next.delete(key); return next; });
      try { await fetch("/api/ops/aircraft-tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tail_number: tail, tag: "MX_Airport", note: code }) }); } catch { /* ignore */ }
    }
    setEditingMxAirport(null);
  }, []);

  const toggleConformity = useCallback(async (tail: string) => {
    const key = tail + "|Conformity";
    const hasTag = effectiveTags.has(key);
    if (hasTag) {
      setRemovedTags((prev) => new Set(prev).add(key));
      setLocalTags((prev) => { const next = new Map(prev); next.delete(key); return next; });
      try { await fetch("/api/ops/aircraft-tags", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tail_number: tail, tag: "Conformity" }) }); } catch { /* ignore */ }
    } else {
      const optimistic: AircraftTag = { id: "local-" + Date.now(), tail_number: tail, tag: "Conformity", note: null, created_by: null, created_at: new Date().toISOString() };
      setLocalTags((prev) => new Map(prev).set(key, optimistic));
      setRemovedTags((prev) => { const next = new Set(prev); next.delete(key); return next; });
      try { await fetch("/api/ops/aircraft-tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tail_number: tail, tag: "Conformity" }) }); } catch { /* ignore */ }
    }
  }, [effectiveTags]);

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

  // ── MX Conflict Detection ──────────────────────────────────────────────
  // For each MX note, check if the aircraft visits the MX airport at any point
  // during the MX window. If it never touches that airport → alert.
  type MxConflict = {
    tail: string;
    mxNote: MxNote;
    reason: string;
  };

  const mxConflicts = useMemo<MxConflict[]>(() => {
    if (!mxNotes || mxNotes.length === 0) return [];
    const conflicts: MxConflict[] = [];
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Only show conflicts for yesterday, today, tomorrow
    const windowStart = now - DAY_MS;
    const windowEnd = now + 2 * DAY_MS;

    for (const note of mxNotes) {
      if (!note.tail_number || !note.start_time) continue;
      const mxStart = new Date(note.start_time).getTime();
      const mxEnd = note.end_time ? new Date(note.end_time).getTime() + DAY_MS : mxStart + DAY_MS;
      // Skip MX notes whose due date has already passed (overdue items
      // shouldn't generate position conflicts — they need manual resolution)
      if (mxEnd < now) continue;
      // Only show if MX window overlaps today–tomorrow
      if (mxEnd < windowStart || mxStart > windowEnd) continue;
      const mxIcao = note.airport_icao?.toUpperCase();
      if (!mxIcao) continue;

      // Check if the aircraft is ever at the MX airport during the window
      const tailFlights = activeFlights.filter((f) => f.tail_number === note.tail_number);
      const windowFlights = tailFlights.filter((f) => {
        const depTime = new Date(f.scheduled_departure).getTime();
        const arrTime = f.scheduled_arrival ? new Date(f.scheduled_arrival).getTime() : depTime;
        // Flight overlaps with MX window
        return depTime < mxEnd && arrTime > mxStart;
      });

      // Does the aircraft arrive at or depart from the MX airport during the window?
      const touchesMxAirport = windowFlights.some((f) =>
        f.arrival_icao?.toUpperCase() === mxIcao || f.departure_icao?.toUpperCase() === mxIcao
      );

      // Also check: if no flights in window, where was the aircraft last?
      // (it might already be sitting at the MX airport)
      let alreadyThere = false;
      if (windowFlights.length === 0) {
        const priorFlights = tailFlights
          .filter((f) => new Date(f.scheduled_departure).getTime() < mxStart)
          .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
        const lastFlight = priorFlights[priorFlights.length - 1];
        if (lastFlight?.arrival_icao?.toUpperCase() === mxIcao) {
          alreadyThere = true;
        }
      }

      if (!touchesMxAirport && !alreadyThere) {
        // Figure out where the aircraft actually is during the window
        const locations = windowFlights.map((f) => f.arrival_icao).filter(Boolean);
        const lastLoc = locations[locations.length - 1] ?? "unknown";
        const mxDate = (() => { const d = new Date(note.start_time!); const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); const time = d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; return `${date}${time}`; })();
        conflicts.push({
          tail: note.tail_number,
          mxNote: note,
          reason: `not at ${note.airport_icao} — scheduled at ${lastLoc} (MX: ${mxDate})`,
        });
      }
    }
    return conflicts;
  }, [mxNotes, activeFlights]);

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

      {/* ── Stats + Resync ── */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <StatsBar positions={positions} vans={vans} flightCount={flightsForDay.length} aogVanCount={aogSamsaraVans.length} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {syncMsg && <span className="text-xs text-gray-500">{syncMsg}</span>}
          <button
            onClick={handleResync}
            disabled={syncing}
            className="px-2.5 py-1 text-xs font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 rounded transition-colors disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Resync JI"}
          </button>
        </div>
      </div>

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

      {/* ── MX Conflict Alerts (accordion) ── */}
      {(() => {
        const nowMsConf = Date.now();
        const visibleConflicts = mxConflicts.filter((c) => {
          if (c.mxNote.end_time && new Date(c.mxNote.end_time).getTime() < nowMsConf) return false;
          if (hiddenTodayMxIds.has(c.mxNote.id)) return false;
          const storedHash = dismissedConflictHashesRef.current[c.mxNote.id];
          if (!storedHash) return true;
          return storedHash !== getMxNoteHash(c.mxNote);
        });
        return (
      <div className={`rounded-xl border-2 px-5 py-4 shadow-sm ${
        visibleConflicts.length > 0
          ? "border-red-300 bg-red-50"
          : "border-green-300 bg-green-50"
      }`}>
        <button
          onClick={() => setMxConflictsOpen((v) => !v)}
          className="flex items-center gap-3 w-full text-left"
        >
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 font-bold ${
            visibleConflicts.length > 0
              ? "bg-red-100 text-red-600"
              : "bg-green-100 text-green-600"
          }`}>
            {visibleConflicts.length > 0 ? "!!" : "\u2713"}
          </div>
          <div className={`text-base font-bold flex-1 ${visibleConflicts.length > 0 ? "text-red-800" : "text-green-800"}`}>
            {visibleConflicts.length > 0
              ? `Jawad's Ops Changes that Affect James's Plan (${visibleConflicts.length})`
              : "Jawad's Ops Changes that Affect James's Plan — 0 alerts"
            }
          </div>
          {visibleConflicts.length > 0 && (
            <svg
              className={`w-5 h-5 text-red-600 transition-transform ${mxConflictsOpen ? "rotate-180" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </button>
        {visibleConflicts.length > 0 && mxConflictsOpen && (
          <div className="flex flex-col gap-2 ml-[52px] mt-2">
            {visibleConflicts.map((c, i) => {
              const mxDateStr = c.mxNote.end_time
                ? `Due ${new Date(c.mxNote.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}${(() => { const d = new Date(c.mxNote.end_time); return d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; })()}`
                : c.mxNote.start_time
                  ? new Date(c.mxNote.start_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                  : "";
              const mxEndStr = "";
              return (
                <div key={`mx-conflict-${i}`} className="bg-white border border-red-200 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-red-800">{c.tail}</span>
                    <span className="text-xs text-red-600">{c.reason}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <div className="text-[11px] text-orange-600">
                      <span className={`font-bold ${isMel(c.mxNote) ? "text-yellow-600" : "text-orange-600"}`}>{isMel(c.mxNote) ? "MEL" : "MX"}:</span>{" "}
                      {c.mxNote.body} ({mxDateStr}{mxEndStr})
                      {isMel(c.mxNote) && fmtTimeRemaining(c.mxNote.end_time) && (
                        <span className={`ml-1.5 text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${fmtTimeRemaining(c.mxNote.end_time) === "overdue" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                          {fmtTimeRemaining(c.mxNote.end_time)}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); dismissConflict(c.mxNote.id, c.mxNote); }}
                      className="text-[10px] font-medium text-red-400 hover:text-red-700 hover:bg-red-50 border border-red-200 rounded px-2 py-0.5 shrink-0 transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
        );
      })()}

      {/* ── MEL Items from JetInsight (standalone accordion — no end_time filter) ── */}
      {(() => {
        const melOnly = (mxNotes ?? []).filter((n) => {
          if (hiddenTodayMxIds.has(n.id)) return false;
          return isMel(n);
        });
        return (
          <div className={`rounded-xl border-2 px-5 py-4 shadow-sm ${melOnly.length > 0 ? "border-yellow-300 bg-yellow-50" : "border-slate-200 bg-slate-50"}`}>
            <button
              onClick={() => setMelAccordionOpen((v) => !v)}
              className="flex items-center gap-3 w-full text-left"
            >
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 font-bold ${melOnly.length > 0 ? "bg-yellow-100 text-yellow-700" : "bg-slate-100 text-slate-400"}`}>!</div>
              <div className={`text-base font-bold flex-1 ${melOnly.length > 0 ? "text-yellow-800" : "text-slate-500"}`}>
                MEL Items ({melOnly.length})
              </div>
              <svg className={`w-5 h-5 transition-transform ${melOnly.length > 0 ? "text-yellow-600" : "text-slate-400"} ${melAccordionOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {melAccordionOpen && (
              <div className="flex flex-col gap-2 ml-[52px] mt-2">
                {melOnly.length === 0 ? (
                  <div className="text-xs text-slate-400 italic py-1">No active MEL items</div>
                ) : melOnly.map((note) => {
                  const timeLeft = fmtTimeRemaining(note.end_time);
                  const days = daysRemaining(note.end_time);
                  const isUrgent = days < 5;
                  return (
                    <div key={note.id} className={`bg-white rounded-lg px-3 py-2 ${isUrgent ? "border border-red-300" : "border border-green-300"}`}>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${isUrgent ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>MEL</span>
                        <span className="text-xs font-bold text-gray-800">{note.tail_number}</span>
                        <span className="text-xs text-gray-600">{note.airport_icao}</span>
                        {timeLeft && (
                          <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${timeLeft === "overdue" ? "bg-red-100 text-red-700" : isUrgent ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                            {timeLeft}
                          </span>
                        )}
                        {note.end_time && (
                          <span className="text-[11px] text-gray-500 ml-auto">
                            Due {new Date(note.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{(() => { const d = new Date(note.end_time); return d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; })()}
                          </span>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); hideMxForToday(note.id); }} className="text-gray-400 hover:text-red-600 text-xs ml-2 shrink-0" title="Hide for today">&times;</button>
                      </div>
                      <div className="text-sm text-gray-700 mt-0.5">{note.body}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── MX Notes from JetInsight (accordion — excludes MEL) ── */}
      {(() => {
        const nowMs = Date.now();
        const mxOnly = (mxNotes ?? []).filter((n) => {
          if (hiddenTodayMxIds.has(n.id)) return false;
          if (n.end_time && new Date(n.end_time).getTime() < nowMs) return false;
          if (isMel(n)) return false;
          return true;
        });
        if (mxOnly.length === 0) return null;
        return (
          <div className="rounded-xl border-2 border-orange-300 bg-orange-50 px-5 py-4 shadow-sm">
            <button
              onClick={() => setMxNotesOpen((v) => !v)}
              className="flex items-center gap-3 w-full text-left"
            >
              <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 bg-orange-100">!</div>
              <div className="text-base font-bold text-orange-800 flex-1">
                Maintenance Notes ({mxOnly.length})
              </div>
              <svg className={`w-5 h-5 text-orange-600 transition-transform ${mxNotesOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {mxNotesOpen && (
              <div className="flex flex-col gap-2 ml-[52px] mt-2">
                {mxOnly.map((note) => (
                  <div key={note.id} className="bg-white rounded-lg px-3 py-2 border border-orange-200">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">MX</span>
                      <span className="text-xs font-bold text-orange-800">{note.tail_number}</span>
                      <span className="text-xs text-orange-600">{note.airport_icao}</span>
                      {note.end_time && (
                        <span className="text-[11px] text-gray-500 ml-auto">
                          Due {new Date(note.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{(() => { const d = new Date(note.end_time); return d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; })()}
                        </span>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); hideMxForToday(note.id); }} className="text-gray-400 hover:text-red-600 text-xs ml-2 shrink-0" title="Hide for today">&times;</button>
                    </div>
                    <div className="text-sm text-gray-700 mt-0.5">{note.body}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Dismissed MX Notes (restore) ── */}
      <div className="rounded-xl border-2 border-gray-200 bg-white px-5 py-4 shadow-sm">
        <button
          onClick={loadDismissed}
          className="flex items-center gap-3 w-full text-left"
        >
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0 bg-gray-100 text-gray-500">
            &#x21A9;
          </div>
          <div className="text-base font-bold text-gray-600 flex-1">
            {dismissedOpen ? "Dismissed MX Notes" : "Dismissed MX Notes"} {dismissedLoaded && `(${dismissedNotes.length})`}
          </div>
          <svg
            className={`w-5 h-5 text-gray-400 transition-transform ${dismissedOpen ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {dismissedOpen && (
          <div className="ml-[52px] mt-2">
            {dismissedNotes.length === 0 ? (
              <div className="text-xs text-gray-400 py-2">No dismissed items in the last 30 days</div>
            ) : (
              <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
                {dismissedNotes.map((note) => (
                  <div key={note.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-1.5 border border-gray-200">
                    <span className="text-xs font-bold text-gray-400">MX</span>
                    <span className="text-xs font-mono font-semibold text-gray-600">{note.tail_number}</span>
                    <span className="text-xs text-gray-500">{note.airport_icao}</span>
                    <span className="text-xs text-gray-600 flex-1">{note.body}</span>
                    {note.end_time && (
                      <span className="text-[11px] text-gray-400 shrink-0">
                        Due {new Date(note.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{(() => { const d = new Date(note.end_time); return d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; })()}
                      </span>
                    )}
                    <button
                      onClick={() => restoreMxNote(note.id)}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2.5 py-1 shrink-0 transition-colors hover:bg-blue-50"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

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
        <TabBtn active={activeTab === "mx-admin"} onClick={() => setActiveTab("mx-admin")}>
          MX Admin
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
              <MapView vans={displayedVans} colors={VAN_COLORS} liveVanPositions={liveVanPositions} liveVanIsLive={liveVanIsLive} aircraftPositions={[]} flightInfo={flightInfoMap} />
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
        <ScheduleTab allFlights={activeFlights} date={selectedDate} liveVanPositions={liveVanPositions} liveVanAddresses={liveVanAddresses} vanZoneNames={vanZoneNames} flightInfoMap={flightInfoMap} mxNotesByTail={mxNotesByTail} longTermMxTails={longTermMxTails} hiddenTodayMxIds={hiddenTodayMxIds} onHideMxForToday={hideMxForToday} mxVanOverrides={mxVanOverrides} onVanOverride={handleVanOverride} fboMap={fboMap} wontSeeTodayTails={wontSeeTodayTails} onMarkWontSee={handleMarkWontSee} onRestoreWontSee={handleRestoreWontSee} onSyncDraftUiState={handleSyncDraftUiState} dismissedConflictsRef={dismissedConflictHashesRef} dismissedConflictVersion={dismissedConflictVersion} />
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
                                  En Route
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
                      {(mxNotesByTail.get(tail ?? "") ?? []).filter((n) => { if (hiddenTodayMxIds.has(n.id)) return false; if (n.end_time && new Date(n.end_time).getTime() < Date.now()) return false; return true; }).length > 0 && (
                        <div className="border-t border-orange-100 px-4 py-2 space-y-1">
                          {(mxNotesByTail.get(tail ?? "") ?? []).filter((n) => { if (hiddenTodayMxIds.has(n.id)) return false; if (n.end_time && new Date(n.end_time).getTime() < Date.now()) return false; return true; }).map((n) => {
                            const mel = isMel(n);
                            const timeLeft = mel ? fmtTimeRemaining(n.end_time) : null;
                            return (
                            <div key={n.id} className={`flex items-start gap-2 rounded-lg px-3 py-1.5 ${mel ? "bg-yellow-50 border border-yellow-300" : "bg-orange-50 border border-orange-200"}`}>
                              <span className={`font-bold text-xs mt-0.5 shrink-0 ${mel ? "text-yellow-600" : "text-orange-500"}`}>{mel ? "MEL" : "MX"}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={`text-xs font-medium ${mel ? "text-yellow-700" : "text-orange-700"}`}>{n.airport_icao}</span>
                                  <span className="text-xs text-gray-700">{n.body}</span>
                                  <span className="flex items-center gap-1.5 ml-auto shrink-0">
                                    {timeLeft && (
                                      <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${timeLeft === "overdue" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                                        {timeLeft}
                                      </span>
                                    )}
                                    {n.start_time && (
                                      <span className="text-[11px] text-gray-400">
                                        {new Date(n.start_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{(() => { const d = new Date(n.start_time); return d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; })()}
                                        {n.end_time && n.end_time !== n.start_time && (() => { const endDate = new Date(n.end_time).toLocaleDateString("en-US", { month: "short", day: "numeric" }); const endTime = (() => { const d = new Date(n.end_time); return d.getHours() !== 0 || d.getMinutes() !== 0 ? `, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""; })(); return ` – ${endDate}${endTime}`; })()}
                                      </span>
                                    )}
                                  </span>
                                </div>
                                <button
                                  onClick={() => hideMxForToday(n.id)}
                                  className="text-[10px] font-medium text-orange-400 hover:text-orange-700 hover:bg-orange-50 border border-orange-200 rounded px-2 py-0.5 mt-1 transition-colors"
                                >
                                  Hide for Today
                                </button>
                              </div>
                            </div>
                            );
                          })}
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

      {/* ── MX Admin tab ── */}
      {activeTab === "mx-admin" && (
        <div className="space-y-8">
          <MxBoard flights={initialFlights} mxNotes={mxNotes} melItems={melItems} />
          <hr className="border-gray-200" />
          <MxAdminTab />
        </div>
      )}

      {/* ── Long-Term Maintenance section ── */}
      {longTermMxAircraft.length > 0 && (
        <div className="space-y-3 mt-6">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-50 border border-purple-200">
              <span className="w-2 h-2 rounded-full bg-purple-400" />
              <span className="text-sm font-semibold text-purple-800">Long-Term Maintenance</span>
              <span className="text-xs text-purple-500">{longTermMxAircraft.length} aircraft</span>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {longTermMxAircraft.map((ac) => {
              const hasConformity = effectiveTags.has(ac.tail + "|Conformity");
              const displayAirport = ac.airport || mxAirportFromTags.get(ac.tail) || null;
              const isEditingAirport = editingMxAirport === ac.tail;
              return (
                <div key={ac.tail} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-purple-50/60 border-b border-purple-100">
                    <span className="font-mono font-bold text-gray-900">{ac.tail}</span>
                    <div className="flex items-center gap-2">
                      {isEditingAirport ? (
                        <input
                          autoFocus
                          className="w-16 text-xs font-mono text-gray-700 border border-purple-300 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-purple-400 uppercase"
                          placeholder="ICAO"
                          maxLength={4}
                          defaultValue={displayAirport ?? ""}
                          onBlur={(e) => saveMxAirport(ac.tail, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveMxAirport(ac.tail, (e.target as HTMLInputElement).value);
                            if (e.key === "Escape") setEditingMxAirport(null);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setEditingMxAirport(ac.tail); setMxAirportDraft(displayAirport ?? ""); }}
                          className="text-xs font-mono text-gray-500 hover:text-purple-600 hover:underline cursor-pointer"
                          title="Click to set MX airport"
                        >
                          {displayAirport || "+ airport"}
                        </button>
                      )}
                      <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-purple-100 text-purple-700">
                        MX
                      </span>
                    </div>
                  </div>
                  <div className="px-4 py-3 space-y-2">
                    <div className="text-xs text-gray-600">{ac.reason}</div>
                    {ac.mxDescription && (
                      <div className="text-xs text-gray-500 truncate" title={ac.mxDescription}>
                        {ac.mxDescription}
                      </div>
                    )}
                    {(ac.startDate || ac.endDate) && (
                      <div className="text-[10px] text-gray-400">
                        {ac.startDate && new Date(ac.startDate).toLocaleDateString()}
                        {ac.startDate && ac.endDate && " – "}
                        {ac.endDate && new Date(ac.endDate).toLocaleDateString()}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleConformity(ac.tail)}
                      className={`mt-1 inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
                        hasConformity
                          ? "bg-green-100 text-green-700 border border-green-300 hover:bg-green-200"
                          : "bg-white text-gray-500 border border-gray-300 hover:bg-gray-50 hover:text-gray-700"
                      }`}
                    >
                      {hasConformity ? (
                        <>
                          <span className="text-green-600">&#10003;</span>
                          Conformity
                        </>
                      ) : (
                        "Add Conformity"
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}
