"use client";

import dynamic from "next/dynamic";
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import type { Flight } from "@/lib/opsApi";
import {
  computeOvernightPositions,
  computeOvernightPositionsFromFlights,
  assignVans,
  getDateRange,
  isContiguous48,
  haversineKm,
  findNearestAirport,
  FIXED_VAN_ZONES,
  VanAssignment,
  AircraftOvernightPosition,
} from "@/lib/maintenanceData";
import type { VanZone } from "@/lib/maintenanceData";
import { getAirportInfo } from "@/lib/airportCoords";

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

function fmtLongDate(d: string) {
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return (
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }) + " UTC"
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
  totalVans,
}: {
  positions: AircraftOvernightPosition[];
  vans: VanAssignment[];
  flightCount: number;
  totalVans: number;
}) {
  const covered = vans.flatMap((v) => v.aircraft).length;
  const airports = new Set(positions.map((p) => p.airport)).size;
  const vansCovering = vans.filter((v) => v.aircraft.length > 0).length;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: "Aircraft Positioned", value: covered },
        { label: "Airports Covered",    value: airports },
        { label: "Vans Deployed",        value: `${vansCovering}/${totalVans}` },
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

/** Format a UTC ISO timestamp to "HH:MM UTC". */
function fmtUtcHM(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return (
    d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }) + " UTC"
  );
}

/** True if the flight is a positioning / ferry / repo leg (not revenue). */
function isPositioningFlight(f: Flight): boolean {
  const ft = inferFlightType(f);
  if (ft === "Positioning" || ft === "Ferry" || ft === "Needs pos") return true;
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
const AOG_ACTIVE_TYPES = new Set(["Revenue", "Owner", "Positioning"]);

/**
 * Filter out "parking" / placeholder ICS entries where departure == arrival
 * (e.g. "Aircraft away from home base" entries from JetInsight).
 * These aren't real flights and should be excluded from scheduling and display.
 */
function isRealFlight(f: Flight): boolean {
  if (!f.departure_icao || !f.arrival_icao) return true; // keep flights with missing data
  return f.departure_icao !== f.arrival_icao;
}

/** Flight types to display — Revenue and Positioning legs only */
const DISPLAY_FLIGHT_TYPES = new Set(["Revenue", "Owner", "Positioning"]);

/** "Needs pos" / "Aircraft needs repositioning" are placeholders, not real legs */
const PLACEHOLDER_TYPES = new Set(["Needs pos"]);

/** Is this a displayable operational leg (Revenue/Positioning, not a placeholder)? */
function isOperationalLeg(f: Flight): boolean {
  const ft = inferFlightType(f);
  if (!ft) return false;
  if (PLACEHOLDER_TYPES.has(ft)) return false;
  return DISPLAY_FLIGHT_TYPES.has(ft);
}

/** "in 2h 15m" or "in 45m" until a future ISO timestamp. Returns "" if in the past. */
function fmtTimeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h === 0 ? `in ${m}m` : `in ${h}h ${m}m`;
}

/** Max one-way driving radius for initial arrival pool (~5.5h drive at 90 km/h). */
const SCHEDULE_ARRIVAL_RADIUS_KM = 500;

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

/**
 * Van scheduling rules:
 *  - Max 5 hours total drive time per van per day
 *  - If total drive time < 4 hours: up to 10 aircraft
 *  - If total drive time >= 4 hours: up to 5 aircraft
 */
const MAX_AIRCRAFT_SHORT_DRIVE = 10;  // drive < 4h
const MAX_AIRCRAFT_LONG_DRIVE  = 5;   // drive >= 4h
const MAX_DRIVE_HOURS          = 5;   // hard cap
const LONG_DRIVE_THRESHOLD_H   = 4;   // hours threshold for reduced limit
const AVG_SPEED_KMH            = 90;  // average driving speed

// ---------------------------------------------------------------------------
// Compute schedule items for a single zone (extracted so ScheduleTab can
// centrally compute items for all zones and manage drag-and-drop overrides)
// ---------------------------------------------------------------------------

function computeZoneItems(
  zone: VanZone,
  allFlights: Flight[],
  date: string,
  baseLat: number,
  baseLon: number,
): VanFlightItem[] {
  const arrivalsToday = allFlights.filter((f) => {
    if (!f.arrival_icao || !f.scheduled_arrival) return false;
    if (!f.scheduled_arrival.startsWith(date)) return false;
    const iata = f.arrival_icao.replace(/^K/, "");
    const info = getAirportInfo(iata);
    if (!info || !isContiguous48(info.state)) return false;
    return haversineKm(baseLat, baseLon, info.lat, info.lon) <= SCHEDULE_ARRIVAL_RADIUS_KM;
  });

  const rawItems = arrivalsToday
    .map((arr) => {
      const iata = arr.arrival_icao!.replace(/^K/, "");
      const info = getAirportInfo(iata);
      const distKm = info ? Math.round(haversineKm(baseLat, baseLon, info.lat, info.lon)) : 0;

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
        distKm,
      };
    })
    .filter(({ nextDep }) => {
      if (!nextDep) return true;
      if (isPositioningFlight(nextDep)) return true;
      return !nextDep.scheduled_departure.startsWith(date);
    });

  // Deduplicate by tail — keep only the last arrival per aircraft per day
  const byTail = new Map<string, VanFlightItem>();
  for (const item of rawItems) {
    const tail = item.arrFlight.tail_number ?? "";
    const existing = byTail.get(tail);
    if (
      !existing ||
      (item.arrFlight.scheduled_arrival ?? "") > (existing.arrFlight.scheduled_arrival ?? "")
    ) {
      byTail.set(tail, item);
    }
  }

  // Greedy nearest-neighbor with drive-time limits:
  //   - Max 5h total drive
  //   - If cumulative drive < 4h → up to 10 aircraft
  //   - If cumulative drive >= 4h → up to 5 aircraft
  const candidates = greedySort(
    Array.from(byTail.values()),
    baseLat,
    baseLon,
  );

  const selected: VanFlightItem[] = [];
  let totalDriveKm = 0;
  let curLat = baseLat;
  let curLon = baseLon;

  for (const item of candidates) {
    if (!item.airportInfo) continue;
    const legKm = haversineKm(curLat, curLon, item.airportInfo.lat, item.airportInfo.lon);
    const newTotalKm = totalDriveKm + legKm;
    const newDriveH = newTotalKm / AVG_SPEED_KMH;

    // Hard cap: 5 hours total drive
    if (newDriveH > MAX_DRIVE_HOURS) break;

    // If adding this would push past 4h, cap aircraft at 5
    if (newDriveH >= LONG_DRIVE_THRESHOLD_H && selected.length >= MAX_AIRCRAFT_LONG_DRIVE) break;

    // Hard cap: 10 aircraft max
    if (selected.length >= MAX_AIRCRAFT_SHORT_DRIVE) break;

    selected.push(item);
    totalDriveKm = newTotalKm;
    curLat = item.airportInfo.lat;
    curLon = item.airportInfo.lon;
  }

  return selected;
}

/**
 * Compute ALL arrivals for a given date across all airports (no zone proximity
 * filter). Used to build the "unassigned aircraft" pool in the schedule tab.
 */
function computeAllDayArrivals(allFlights: Flight[], date: string): VanFlightItem[] {
  const arrivalsToday = allFlights.filter((f) => {
    if (!f.arrival_icao || !f.scheduled_arrival) return false;
    if (!f.scheduled_arrival.startsWith(date)) return false;
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
    .filter(({ nextDep }) => {
      if (!nextDep) return true;
      if (isPositioningFlight(nextDep)) return true;
      return !nextDep.scheduled_departure.startsWith(date);
    });

  // Deduplicate by tail — keep last arrival
  const byTail = new Map<string, VanFlightItem>();
  for (const item of rawItems) {
    const tail = item.arrFlight.tail_number ?? "";
    const existing = byTail.get(tail);
    if (
      !existing ||
      (item.arrFlight.scheduled_arrival ?? "") > (existing.arrFlight.scheduled_arrival ?? "")
    ) {
      byTail.set(tail, item);
    }
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
  onClose,
}: {
  vanName: string;
  vanId: number;
  homeAirport: string;
  date: string;
  items: VanFlightItem[];
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
        items: items.map((item) => ({
          tail: item.arrFlight.tail_number ?? "—",
          route: `${item.arrFlight.departure_icao?.replace(/^K/, "") ?? "?"} → ${item.airport}`,
          arrivalTime: item.arrFlight.scheduled_arrival ? fmtUtcHM(item.arrFlight.scheduled_arrival) : "—",
          status: item.arrFlight.scheduled_arrival && new Date(item.arrFlight.scheduled_arrival) < new Date() ? "~Landed" : "Scheduled",
          nextDep: item.nextDep ? `Flying again ${fmtUtcHM(item.nextDep.scheduled_departure)} → ${item.nextDep.arrival_icao?.replace(/^K/, "") ?? "?"}` : undefined,
          driveTime: item.distKm > 0 ? fmtDriveTime(item.distKm) : undefined,
        })),
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
// VanScheduleCard — now receives items as props (no internal computation)
// ---------------------------------------------------------------------------

function VanScheduleCard({
  zone,
  color,
  items,
  date,
  liveVanPos,
  liveAddress,
  samsaraVanName,
  isDropTarget,
  hasOverrides,
  onDragStart,
  onDragOver,
  onDrop,
  onDragLeave,
  onRemove,
}: {
  zone: VanZone;
  color: string;
  items: VanFlightItem[];
  date: string;
  liveVanPos?: { lat: number; lon: number };
  liveAddress?: string | null;
  samsaraVanName?: string | null;
  isDropTarget: boolean;
  hasOverrides: boolean;
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
            <div className="font-semibold text-sm">
              {zone.name}
              {samsaraVanName && (
                <span className="ml-1.5 text-xs font-normal text-blue-600">({samsaraVanName})</span>
              )}
            </div>
            <div className="text-xs text-gray-500">
              Base: <span className="font-medium">{zone.homeAirport}</span>
            </div>
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
                const arrTime = arrFlight.scheduled_arrival ? new Date(arrFlight.scheduled_arrival) : null;
                const hasLanded = arrTime !== null && arrTime < now;
                const doneForDay = !nextDep;
                return (
                  <div
                    key={arrFlight.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, arrFlight.id, zone.vanId)}
                    className="px-4 py-3 flex items-start justify-between gap-4 cursor-grab active:cursor-grabbing hover:bg-gray-50/50"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex flex-col items-center gap-0.5 flex-shrink-0 mt-1">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                        <svg className="w-3 h-3 text-gray-300" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2}>
                          <path d="M2 4h8M2 8h8" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-semibold text-sm">{arrFlight.tail_number ?? "—"}</span>
                          <span className="text-xs text-gray-500 font-mono">
                            {arrFlight.departure_icao?.replace(/^K/, "") ?? "?"} → {airport}
                          </span>
                          {isRepo ? (
                            <span className="text-xs bg-purple-100 text-purple-700 rounded px-1.5 py-0.5">Positioning</span>
                          ) : (
                            <span className="text-xs bg-green-100 text-green-700 rounded px-1.5 py-0.5">Revenue</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {airport}{airportInfo ? ` · ${airportInfo.city}, ${airportInfo.state}` : ""}
                          {" · "}<span className="text-gray-400">{fmtDriveTime(distKm)}</span>
                        </div>
                        {nextDep && (
                          <div className="text-xs mt-1 font-medium">
                            <span className={nextIsRepo ? "text-purple-700" : "text-blue-700"}>
                              Flying again {fmtTimeUntil(nextDep.scheduled_departure) && `${fmtTimeUntil(nextDep.scheduled_departure)} · `}{fmtUtcHM(nextDep.scheduled_departure)} → {nextDep.arrival_icao?.replace(/^K/, "") ?? "?"}
                            </span>
                            {nextIsRepo && <span className="ml-1 text-xs text-purple-400">(repo)</span>}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-2 shrink-0">
                      <div className="text-right space-y-1 min-w-[90px]">
                        {arrTime && (
                          <div className="text-xs font-medium text-gray-700">
                            Lands {fmtUtcHM(arrFlight.scheduled_arrival!)}
                          </div>
                        )}
                        <span className={`inline-block text-xs font-semibold rounded-full px-2 py-0.5 ${hasLanded ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>
                          {hasLanded ? "~Landed" : "Scheduled"}
                        </span>
                        {doneForDay && (
                          <div>
                            <span className="inline-block text-xs font-semibold bg-green-100 text-green-700 rounded-full px-2 py-0.5">
                              Done for day
                            </span>
                          </div>
                        )}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); onRemove(arrFlight.id); }}
                        className="mt-0.5 p-1 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Remove from this van"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 14 14" stroke="currentColor" strokeWidth={2}>
                          <path d="M3 3l8 8M11 3l-8 8" />
                        </svg>
                      </button>
                    </div>
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
  zones,
  liveVanPositions,
  liveVanAddresses,
  vanZoneNames,
}: {
  allFlights: Flight[];
  date: string;
  zones: VanZone[];
  liveVanPositions: Map<number, { lat: number; lon: number }>;
  liveVanAddresses: Map<number, string | null>;
  vanZoneNames: Map<number, string>;
}) {
  const hasLive = liveVanPositions.size > 0;

  // Manual overrides: flightId → target vanId (moves) + removed flight IDs
  const [overrides, setOverrides] = useState<Map<string, number>>(new Map());
  const [removals, setRemovals] = useState<Set<string>>(new Set());
  // Reset overrides when date changes
  const prevDateRef = useRef(date);
  if (prevDateRef.current !== date) {
    prevDateRef.current = date;
    if (overrides.size > 0) setOverrides(new Map());
    if (removals.size > 0) setRemovals(new Set());
  }

  const totalEdits = overrides.size + removals.size;

  // DnD visual state
  const [dropTargetVan, setDropTargetVan] = useState<number | null>(null);
  const dragCounterRef = useRef(0);

  // Compute base items for every zone, then deduplicate across zones
  // so each aircraft tail only appears in ONE van (the closest one).
  const baseItemsByVan = useMemo(() => {
    const map = new Map<number, VanFlightItem[]>();
    for (const zone of zones) {
      const baseLat = liveVanPositions.get(zone.vanId)?.lat ?? zone.lat;
      const baseLon = liveVanPositions.get(zone.vanId)?.lon ?? zone.lon;
      map.set(zone.vanId, computeZoneItems(zone, allFlights, date, baseLat, baseLon));
    }

    // Cross-zone deduplication: if the same tail appears in multiple vans,
    // keep it only in the van where it's closest (smallest distKm).
    const tailBestVan = new Map<string, { vanId: number; distKm: number }>();
    for (const [vanId, items] of map) {
      for (const item of items) {
        const tail = item.arrFlight.tail_number ?? "";
        if (!tail) continue;
        const existing = tailBestVan.get(tail);
        if (!existing || item.distKm < existing.distKm) {
          tailBestVan.set(tail, { vanId, distKm: item.distKm });
        }
      }
    }
    // Remove duplicates — keep each tail only in its best van
    for (const [vanId, items] of map) {
      map.set(
        vanId,
        items.filter((item) => {
          const tail = item.arrFlight.tail_number ?? "";
          return tailBestVan.get(tail)?.vanId === vanId;
        }),
      );
    }

    return map;
  }, [allFlights, date, liveVanPositions, zones]);

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

    // Recalculate distances + greedy sort for each van
    for (const zone of zones) {
      const items = result.get(zone.vanId) ?? [];
      const baseLat = liveVanPositions.get(zone.vanId)?.lat ?? zone.lat;
      const baseLon = liveVanPositions.get(zone.vanId)?.lon ?? zone.lon;
      const sorted = greedySort(recalcDist(items, baseLat, baseLon), baseLat, baseLon);
      result.set(zone.vanId, sorted);
    }

    return result;
  }, [baseItemsByVan, overrides, removals, liveVanPositions, allDayArrivals, zones]);

  // Uncovered aircraft: arrivals today not assigned to any van
  const uncoveredItems = useMemo(() => {
    const assignedIds = new Set<string>();
    for (const items of finalItemsByVan.values()) {
      for (const item of items) assignedIds.add(item.arrFlight.id);
    }
    return allDayArrivals.filter((item) => !assignedIds.has(item.arrFlight.id));
  }, [allDayArrivals, finalItemsByVan]);

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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-gray-500">
          Arrivals plan for {fmtLongDate(date)} · up to {MAX_AIRCRAFT_SHORT_DRIVE} aircraft per van · {MAX_DRIVE_HOURS}h drive limit
          {hasLive && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-green-600 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
              distances from live GPS
            </span>
          )}
        </div>
        {totalEdits > 0 && (
          <button
            onClick={() => { setOverrides(new Map()); setRemovals(new Set()); }}
            className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 hover:bg-amber-100 transition-colors"
          >
            Reset all edits ({totalEdits})
          </button>
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
        // Group uncovered items by tail number, collect day legs per tail
        const tailMap = new Map<string, { items: typeof uncoveredItems; legs: Flight[] }>();
        for (const item of uncoveredItems) {
          const tail = item.arrFlight.tail_number ?? "Unknown";
          if (!tailMap.has(tail)) {
            // Get all operational legs for this tail on this date
            const dayLegs = allFlights
              .filter((f) => {
                if (f.tail_number !== tail) return false;
                if (!isOperationalLeg(f)) return false;
                const depDate = f.scheduled_departure?.slice(0, 10);
                const arrDate = f.scheduled_arrival?.slice(0, 10);
                return depDate === date || arrDate === date;
              })
              .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
            tailMap.set(tail, { items: [], legs: dayLegs });
          }
          tailMap.get(tail)!.items.push(item);
        }

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
                    {tailMap.size} aircraft not covered by any van — drag into a van to assign
                  </div>
                </div>
              </div>
            </div>
            <div className="border-t border-red-200 divide-y divide-red-100">
              {Array.from(tailMap.entries()).map(([tail, { items, legs }]) => {
                const firstItem = items[0];
                const { airport, airportInfo } = firstItem;
                return (
                  <div
                    key={tail}
                    draggable
                    onDragStart={(e) => handleDragStart(e, firstItem.arrFlight.id, 0)}
                    className="px-4 py-2.5 cursor-grab active:cursor-grabbing hover:bg-red-50"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                          <div className="w-2.5 h-2.5 rounded-full bg-red-300" />
                          <svg className="w-3 h-3 text-red-300" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2}>
                            <path d="M2 4h8M2 8h8" />
                          </svg>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-semibold text-sm">{tail}</span>
                            <span className="text-xs text-gray-500">
                              {airport}{airportInfo ? ` · ${airportInfo.city}` : ""}
                            </span>
                            <span className="text-xs bg-red-100 text-red-600 rounded px-1.5 py-0.5">No Van</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    {/* Compact legs for the day */}
                    {legs.length > 0 && (
                      <div className="ml-8 mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1">
                        {legs.map((leg, idx) => {
                          const dep = leg.departure_icao?.replace(/^K/, "") ?? "?";
                          const arr = leg.arrival_icao?.replace(/^K/, "") ?? "?";
                          const ft = inferFlightType(leg);
                          const isPos = ft === "Positioning" || ft === "Ferry";
                          const arrTime = leg.scheduled_arrival ? new Date(leg.scheduled_arrival) : null;
                          const hasLanded = arrTime !== null && arrTime < new Date();
                          return (
                            <span key={leg.id} className="inline-flex items-center gap-1 text-xs">
                              {idx > 0 && <span className="text-gray-300 mx-0.5">·</span>}
                              <span className={`font-mono font-medium ${hasLanded ? "text-gray-400" : "text-gray-700"}`}>
                                {dep}→{arr}
                              </span>
                              <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                                isPos ? "bg-purple-100 text-purple-600" : "bg-green-100 text-green-600"
                              }`}>
                                {ft === "Owner" ? "Rev" : isPos ? "Pos" : "Rev"}
                              </span>
                              <span className="text-gray-400">{fmtUtcHM(leg.scheduled_departure)}</span>
                              {hasLanded && <span className="text-gray-400">✓</span>}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {zones.map((zone) => {
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
              liveVanPos={liveVanPositions.get(zone.vanId)}
              liveAddress={liveVanAddresses.get(zone.vanId)}
              samsaraVanName={vanZoneNames.get(zone.vanId)}
              isDropTarget={dropTargetVan === zone.vanId}
              hasOverrides={editedVans.has(zone.vanId)}
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
// FlightScheduleTab — raw flight data per aircraft for the selected day
// ---------------------------------------------------------------------------

function FlightScheduleTab({
  allFlights,
  date,
}: {
  allFlights: Flight[];
  date: string;
}) {
  const [search, setSearch] = useState("");
  const [expandAll, setExpandAll] = useState(true);

  // Get operational flights for the selected date (Revenue/Positioning only, no placeholders)
  const dayFlights = useMemo(() => {
    return allFlights.filter((f) => {
      if (!isOperationalLeg(f)) return false;
      const depDate = f.scheduled_departure?.slice(0, 10);
      const arrDate = f.scheduled_arrival?.slice(0, 10);
      return depDate === date || arrDate === date;
    });
  }, [allFlights, date]);

  // Group by tail number
  const byTail = useMemo(() => {
    const map = new Map<string, Flight[]>();
    for (const f of dayFlights) {
      const tail = f.tail_number ?? "Unknown";
      const arr = map.get(tail) ?? [];
      arr.push(f);
      map.set(tail, arr);
    }
    // Sort legs within each tail by departure time
    for (const legs of map.values()) {
      legs.sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
    }
    // Sort tails alphabetically
    return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }, [dayFlights]);

  // Filter by search
  const filtered = useMemo(() => {
    if (!search) return byTail;
    const q = search.toLowerCase();
    const result = new Map<string, Flight[]>();
    for (const [tail, legs] of byTail) {
      if (
        tail.toLowerCase().includes(q) ||
        legs.some(
          (f) =>
            f.departure_icao?.toLowerCase().includes(q) ||
            f.arrival_icao?.toLowerCase().includes(q) ||
            f.summary?.toLowerCase().includes(q) ||
            inferFlightType(f)?.toLowerCase().includes(q),
        )
      ) {
        result.set(tail, legs);
      }
    }
    return result;
  }, [byTail, search]);

  const totalLegs = dayFlights.length;
  const totalAircraft = byTail.size;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-gray-500">
          Flight schedule for {fmtLongDate(date)} · {totalAircraft} aircraft · {totalLegs} legs
        </div>
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tails, airports..."
            className="max-w-xs rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-gray-400"
          />
          <button
            onClick={() => setExpandAll((v) => !v)}
            className="text-xs text-blue-600 hover:underline whitespace-nowrap"
          >
            {expandAll ? "Collapse All" : "Expand All"}
          </button>
        </div>
      </div>

      {filtered.size === 0 ? (
        <div className="bg-white border rounded-xl px-4 py-8 text-center text-gray-400 text-sm">
          {search ? "No matching aircraft" : "No flights scheduled for this day"}
        </div>
      ) : (
        <div className="space-y-2">
          {Array.from(filtered.entries()).map(([tail, legs]) => (
            <FlightScheduleAircraft
              key={tail}
              tail={tail}
              legs={legs}
              date={date}
              defaultExpanded={expandAll}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FlightScheduleAircraft({
  tail,
  legs,
  date,
  defaultExpanded,
}: {
  tail: string;
  legs: Flight[];
  date: string;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Sync with parent toggle
  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  // Determine overnight airport (last arrival on this date)
  const lastArrival = [...legs]
    .filter((f) => f.scheduled_arrival?.startsWith(date))
    .sort((a, b) => (b.scheduled_arrival ?? "").localeCompare(a.scheduled_arrival ?? ""))[0];
  const overnightApt = lastArrival?.arrival_icao?.replace(/^K/, "") ?? null;

  // First departure
  const firstDep = legs[0];
  const firstDepApt = firstDep?.departure_icao?.replace(/^K/, "") ?? null;

  // All unique airports touched
  const airports = new Set<string>();
  for (const f of legs) {
    if (f.departure_icao) airports.add(f.departure_icao.replace(/^K/, ""));
    if (f.arrival_icao) airports.add(f.arrival_icao.replace(/^K/, ""));
  }

  return (
    <div className="bg-white border rounded-xl overflow-hidden shadow-sm">
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <span className="font-mono font-bold text-sm text-gray-800">{tail}</span>
          <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5 font-medium">
            {legs.length} leg{legs.length !== 1 ? "s" : ""}
          </span>
          {firstDepApt && overnightApt && (
            <span className="text-xs text-gray-500 font-mono">
              {firstDepApt} → … → {overnightApt}
            </span>
          )}
          {overnightApt && (
            <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-1.5 py-0.5">
              Overnight: {overnightApt}
            </span>
          )}
        </div>
        <span className="text-gray-400 text-sm">{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div className="border-t">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-2 w-12">#</th>
                <th className="px-4 py-2">Route</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Depart</th>
                <th className="px-4 py-2">Arrive</th>
                <th className="px-4 py-2">Duration</th>
                <th className="px-4 py-2 hidden md:table-cell">Status</th>
                <th className="px-4 py-2 hidden lg:table-cell">Summary</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {legs.map((leg, idx) => {
                const dep = leg.departure_icao?.replace(/^K/, "") ?? "?";
                const arr = leg.arrival_icao?.replace(/^K/, "") ?? "?";
                const ft = inferFlightType(leg);
                const depInfo = getAirportInfo(dep);
                const arrInfo = getAirportInfo(arr);
                const isLastArrival = leg.id === lastArrival?.id;
                const depOnDate = leg.scheduled_departure?.startsWith(date);
                const arrOnDate = leg.scheduled_arrival?.startsWith(date);

                return (
                  <tr
                    key={leg.id}
                    className={`hover:bg-gray-50 ${isLastArrival ? "bg-blue-50/50" : ""} ${
                      !depOnDate && !arrOnDate ? "opacity-50" : ""
                    }`}
                  >
                    <td className="px-4 py-2 text-gray-400">{idx + 1}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-semibold text-gray-700">{dep}</span>
                        <span className="text-gray-400">→</span>
                        <span className="font-mono font-semibold text-gray-700">{arr}</span>
                      </div>
                      <div className="text-gray-400 mt-0.5">
                        {depInfo ? `${depInfo.city}` : ""} → {arrInfo ? `${arrInfo.city}` : ""}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {ft ? (
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                            ft === "Positioning" || ft === "Ferry" || ft === "Needs pos"
                              ? "bg-purple-100 text-purple-700"
                              : ft === "Maintenance"
                              ? "bg-orange-100 text-orange-700"
                              : ft === "Owner"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-green-100 text-green-700"
                          }`}
                        >
                          {ft}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {fmtUtcHM(leg.scheduled_departure)}
                      {!depOnDate && (
                        <div className="text-gray-400">{leg.scheduled_departure.slice(0, 10)}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {leg.scheduled_arrival ? fmtUtcHM(leg.scheduled_arrival) : "—"}
                      {leg.scheduled_arrival && !arrOnDate && (
                        <div className="text-gray-400">{leg.scheduled_arrival.slice(0, 10)}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-400">
                      {leg.scheduled_arrival
                        ? fmtDuration(leg.scheduled_departure, leg.scheduled_arrival)
                        : "—"}
                    </td>
                    <td className="px-4 py-2 hidden md:table-cell">
                      {(() => {
                        const arrTime = leg.scheduled_arrival ? new Date(leg.scheduled_arrival) : null;
                        const hasLanded = arrTime !== null && arrTime < new Date();
                        return hasLanded
                          ? <span className="text-xs font-medium text-green-700 bg-green-100 rounded-full px-2 py-0.5">Landed</span>
                          : <span className="text-xs font-medium text-slate-600 bg-slate-100 rounded-full px-2 py-0.5">Scheduled</span>;
                      })()}
                    </td>
                    <td className="px-4 py-2 hidden lg:table-cell text-gray-400 max-w-[200px] truncate">
                      {leg.summary ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
  // Exclude cleaning/detail vans — not AOG service vehicles
  if (u.includes("CLEAN") || u.includes("DETAIL")) return false;
  return u.includes("VAN") || u.includes("AOG") || u.includes(" OG") || u.includes("TRAN");
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

export default function VanPositioningClient({ initialFlights }: { initialFlights: Flight[] }) {
  const dates = useMemo(() => getDateRange(7), []); // 7-day window
  const [dayIdx, setDayIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<"map" | "schedule" | "flights">("map");
  const [viewMode, setViewMode] = useState<"map" | "list">("map");
  const [selectedVan, setSelectedVan] = useState<number | null>(null);

  const selectedDate = dates[dayIdx];

  // Filter out "parking" placeholder entries (departure == arrival, e.g. ADS→ADS)
  const flights = useMemo(
    () => initialFlights.filter(isRealFlight),
    [initialFlights],
  );

  // Use live JetInsight flight data for overnight positions; fall back to hardcoded TRIPS if no live data
  const positions = useMemo(() => {
    if (flights.length > 0) {
      const live = computeOvernightPositionsFromFlights(flights, selectedDate);
      if (live.length > 0) return live;
    }
    return computeOvernightPositions(selectedDate);
  }, [flights, selectedDate]);

  // Maintenance flights (for idle/maintenance section)
  const maintenanceFlights = useMemo(
    () => flights.filter((f) => {
      const ft = inferFlightType(f);
      return ft === "Maintenance";
    }),
    [flights],
  );

  // Collect all tail numbers that have any flights in the window
  const activeTails = useMemo(() => {
    const tails = new Set<string>();
    for (const f of flights) {
      if (f.tail_number) tails.add(f.tail_number);
    }
    return tails;
  }, [flights]);

  // Maintenance tails
  const maintenanceTails = useMemo(() => {
    const tails = new Set<string>();
    for (const f of maintenanceFlights) {
      if (f.tail_number) tails.add(f.tail_number);
    }
    return tails;
  }, [maintenanceFlights]);

  // All tails from positions (fleet)
  const allTails = useMemo(() => positions.map((p) => p.tail), [positions]);

  // Idle aircraft: tails in the fleet but NOT in any flights and NOT in maintenance
  const idleAircraft = useMemo(
    () => positions.filter((p) => !activeTails.has(p.tail) && !maintenanceTails.has(p.tail)),
    [positions, activeTails, maintenanceTails],
  );

  // Maintenance aircraft: tails with maintenance flights
  const maintenanceAircraft = useMemo(
    () => positions.filter((p) => maintenanceTails.has(p.tail)),
    [positions, maintenanceTails],
  );

  // ALL flights on the selected date (for stats bar)
  const flightsForDay = useMemo(
    () => flights.filter((f) =>
      (f.scheduled_arrival ?? f.scheduled_departure).startsWith(selectedDate)
    ),
    [flights, selectedDate],
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

  // ── Build dynamic zones from Samsara AOG vans ──
  // Each Samsara AOG van becomes its own zone. Falls back to 8 fixed zones
  // if Samsara data isn't available yet.
  const sortedAogVans = useMemo(
    () => [...aogSamsaraVans].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [aogSamsaraVans],
  );

  const dynamicZones = useMemo<VanZone[]>(() => {
    if (sortedAogVans.length === 0) return FIXED_VAN_ZONES;
    return sortedAogVans.map((v, i) => {
      const nearest = (v.lat != null && v.lon != null) ? findNearestAirport(v.lat, v.lon) : null;
      return {
        vanId: i + 1,
        name: v.name || `AOG Van ${i + 1}`,
        homeAirport: nearest?.code ?? "???",
        lat: v.lat ?? 0,
        lon: v.lon ?? 0,
      };
    });
  }, [sortedAogVans]);

  // ── Van assignment (must come after dynamicZones) ──
  const vans       = useMemo(() => assignVans(positions, dynamicZones, 10, flights, selectedDate), [positions, dynamicZones, flights, selectedDate]);
  const displayedVans = selectedVan === null ? vans : vans.filter((v) => v.vanId === selectedVan);

  /** Zone ID → last known GPS position (persists across refreshes if signal lost). */
  const lastKnownGpsRef = useRef<Map<number, { lat: number; lon: number }>>(new Map());
  /** Zone ID → last known street address. */
  const lastKnownAddressRef = useRef<Map<number, string>>(new Map());

  /** Zone ID → live GPS position (from Samsara van). */
  const liveVanPositions = useMemo<Map<number, { lat: number; lon: number }>>(() => {
    const map = new Map<number, { lat: number; lon: number }>();
    sortedAogVans.forEach((v, i) => {
      const zoneId = i + 1;
      if (v.lat !== null && v.lon !== null) {
        const pos = { lat: v.lat, lon: v.lon };
        lastKnownGpsRef.current.set(zoneId, pos);
        map.set(zoneId, pos);
      } else {
        const cached = lastKnownGpsRef.current.get(zoneId);
        if (cached) map.set(zoneId, cached);
      }
    });
    return map;
  }, [sortedAogVans]);

  /** Zone ID → true if the position is a fresh live reading. */
  const liveVanIsLive = useMemo<Map<number, boolean>>(() => {
    const map = new Map<number, boolean>();
    sortedAogVans.forEach((v, i) => {
      map.set(i + 1, v.lat !== null && v.lon !== null);
    });
    return map;
  }, [sortedAogVans]);

  /** Zone ID → street address (live, or last known). */
  const liveVanAddresses = useMemo<Map<number, string | null>>(() => {
    const map = new Map<number, string | null>();
    sortedAogVans.forEach((v, i) => {
      const zoneId = i + 1;
      if (v.address) lastKnownAddressRef.current.set(zoneId, v.address);
      map.set(zoneId, v.address ?? lastKnownAddressRef.current.get(zoneId) ?? null);
    });
    return map;
  }, [sortedAogVans]);

  /** Zone ID → Samsara van display name (for schedule cards). */
  const vanZoneNames = useMemo<Map<number, string>>(() => {
    const map = new Map<number, string>();
    sortedAogVans.forEach((v, i) => {
      if (v.name) map.set(i + 1, v.name);
    });
    return map;
  }, [sortedAogVans]);

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

  return (
    <div className="space-y-5">
      {/* ── 7-day date strip ── */}
      <DayStrip
        dates={dates}
        selectedIdx={dayIdx}
        onSelect={(i) => { setDayIdx(i); setSelectedVan(null); }}
      />

      {/* ── Stats ── */}
      <StatsBar positions={positions} vans={vans} flightCount={flightsForDay.length} totalVans={dynamicZones.length} />

      {/* ── AOG Status — aircraft coverage ── */}
      {(() => {
        // Aircraft assigned to a van but outside 3-hour driving range
        const outOfRange = vans.flatMap((van) => {
          const color = VAN_COLORS[(van.vanId - 1) % VAN_COLORS.length];
          return van.aircraft
            .filter((ac) => haversineKmClient(van.lat, van.lon, ac.lat, ac.lon) > THREE_HOUR_RADIUS_KM)
            .map((ac) => ({
              vanId: van.vanId,
              color,
              tail: ac.tail,
              airport: ac.airport,
              distKm: Math.round(haversineKmClient(van.lat, van.lon, ac.lat, ac.lon)),
            }));
        });

        // Aircraft overnighting but not assigned to any van at all
        const coveredTails = new Set(vans.flatMap((v) => v.aircraft.map((ac) => ac.tail)));
        const uncovered = positions.filter((p) => !coveredTails.has(p.tail));

        const totalIssues = outOfRange.length + uncovered.length;
        const totalCovered = positions.length - uncovered.length;
        const hasAlerts = totalIssues > 0;

        return (
          <div className={`rounded-xl border-2 px-5 py-4 shadow-sm ${
            hasAlerts
              ? uncovered.length > 0 ? "border-red-300 bg-red-50" : "border-yellow-300 bg-yellow-50"
              : "border-green-300 bg-green-50"
          }`}>
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 ${
                hasAlerts
                  ? uncovered.length > 0 ? "bg-red-100" : "bg-yellow-100"
                  : "bg-green-100"
              }`}>
                {hasAlerts ? "⚠" : "✓"}
              </div>
              <div className="flex-1">
                <div className={`text-base font-bold ${
                  hasAlerts
                    ? uncovered.length > 0 ? "text-red-800" : "text-yellow-800"
                    : "text-green-800"
                }`}>
                  AOG Status
                </div>
                {hasAlerts ? (
                  <div className={`text-sm font-semibold ${uncovered.length > 0 ? "text-red-600" : "text-yellow-700"}`}>
                    {[
                      uncovered.length > 0 && `${uncovered.length} aircraft not covered`,
                      outOfRange.length > 0 && `${outOfRange.length} aircraft outside 3-hour range`,
                    ].filter(Boolean).join(" · ")}
                    {" · "}{totalCovered}/{positions.length} covered
                  </div>
                ) : (
                  <div className="text-sm text-green-700 font-medium">
                    All {positions.length} aircraft covered by {vans.length} vans
                  </div>
                )}
              </div>
            </div>
            {/* Detail pills */}
            {hasAlerts && (
              <div className="flex flex-wrap gap-2 mt-3 ml-[52px]">
                {uncovered.map((ac) => (
                  <span key={`unc-${ac.tail}`} className="inline-flex items-center gap-1.5 bg-white border border-red-200 rounded-lg px-3 py-1.5 text-xs font-medium text-red-700">
                    <span className="font-mono font-semibold">{ac.tail}</span>
                    <span className="text-gray-500">@ {ac.airport}</span>
                    <span className="text-red-600">— No Van</span>
                  </span>
                ))}
                {outOfRange.map(({ vanId, color, tail, airport, distKm }) => (
                  <div
                    key={`oor-${vanId}-${tail}`}
                    className="flex items-center gap-1.5 bg-white border border-yellow-200 rounded-lg px-2.5 py-1.5 text-xs"
                  >
                    <span
                      className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                      style={{ background: color }}
                    />
                    <span className="font-semibold">Van {vanId}</span>
                    <span className="text-gray-400">&rarr;</span>
                    <span className="font-mono font-semibold">{tail}</span>
                    <span className="text-gray-500">@ {airport}</span>
                    <span className="text-yellow-700 font-semibold">
                      ~{Math.round(distKm / (THREE_HOUR_RADIUS_KM / 3))}h
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

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
              <MapView vans={displayedVans} colors={VAN_COLORS} liveVanPositions={liveVanPositions} liveVanIsLive={liveVanIsLive} />
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
        <ScheduleTab allFlights={flights} date={selectedDate} zones={dynamicZones} liveVanPositions={liveVanPositions} liveVanAddresses={liveVanAddresses} vanZoneNames={vanZoneNames} />
      )}

      {/* ── Flight Schedule tab ── */}
      {activeTab === "flights" && (
        <FlightScheduleTab allFlights={flights} date={selectedDate} />
      )}

      {/* Second "Unassigned Aircraft" table removed — the compact version in Schedule tab is preferred */}

      {/* ── Idle & Maintenance Aircraft ── */}
      {(idleAircraft.length > 0 || maintenanceAircraft.length > 0) && (
        <div className="space-y-4">
          {maintenanceAircraft.length > 0 && (
            <div className="rounded-xl border-2 border-orange-200 bg-orange-50/50 overflow-hidden">
              <div className="px-4 py-3 border-b border-orange-200 bg-orange-100/50">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-orange-800">Maintenance</span>
                  <span className="text-xs bg-orange-200 text-orange-700 rounded-full px-2 py-0.5 font-semibold">
                    {maintenanceAircraft.length}
                  </span>
                </div>
                <p className="text-xs text-orange-600 mt-0.5">Aircraft currently in maintenance — excluded from van scheduling</p>
              </div>
              <div className="divide-y divide-orange-100">
                {maintenanceAircraft.map((ac) => (
                  <div key={ac.tail} className="px-4 py-2.5 flex items-center gap-4">
                    <span className="font-mono font-semibold text-sm text-gray-800">{ac.tail}</span>
                    <span className="text-xs text-gray-500">{ac.airport}</span>
                    <span className="text-xs text-gray-400">{ac.airportName}</span>
                    <span className="text-xs bg-orange-100 text-orange-700 rounded px-1.5 py-0.5">Maintenance</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {idleAircraft.length > 0 && (
            <div className="rounded-xl border-2 border-gray-200 bg-gray-50/50 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-100/50">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-gray-700">Nothing Scheduled</span>
                  <span className="text-xs bg-gray-200 text-gray-600 rounded-full px-2 py-0.5 font-semibold">
                    {idleAircraft.length}
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">No flights in the 7-day window</p>
              </div>
              <div className="divide-y divide-gray-100">
                {idleAircraft.map((ac) => (
                  <div key={ac.tail} className="px-4 py-2.5 flex items-center gap-4">
                    <span className="font-mono font-semibold text-sm text-gray-800">{ac.tail}</span>
                    <span className="text-xs text-gray-500">{ac.airport}</span>
                    <span className="text-xs text-gray-400">{ac.airportName}</span>
                    <span className="text-xs bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">Idle</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
