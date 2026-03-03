"use client";

import dynamic from "next/dynamic";
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import type { Flight } from "@/lib/opsApi";
import {
  assignVans,
  getDateRange,
  isContiguous48,
  haversineKm,
  FIXED_VAN_ZONES,
  VanAssignment,
  AircraftOvernightPosition,
} from "@/lib/maintenanceData";
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
      (f) => f.scheduled_arrival?.startsWith(date),
    );
    const departingToday = sorted.filter(
      (f) => f.scheduled_departure.startsWith(date),
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
}: {
  positions: AircraftOvernightPosition[];
  vans: VanAssignment[];
  flightCount: number;
}) {
  const covered = vans.flatMap((v) => v.aircraft).length;
  const airports = new Set(positions.map((p) => p.airport)).size;
  const vansCovering = vans.filter((v) => v.aircraft.length > 0).length;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: "Aircraft Positioned", value: covered },
        { label: "Airports Covered",    value: airports },
        { label: "Vans Deployed",        value: `${vansCovering}/16` },
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
const AOG_ACTIVE_TYPES = new Set(["Revenue", "Owner", "Positioning", "Maintenance"]);

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

const MAX_ARRIVALS_PER_VAN = 4;

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
  const arrivalsToday = allFlights.filter((f) => {
    if (!f.arrival_icao || !f.scheduled_arrival) return false;
    if (!f.scheduled_arrival.startsWith(date)) return false;
    const iata = f.arrival_icao.replace(/^K/, "");
    const info = getAirportInfo(iata);
    if (!info || !isContiguous48(info.state)) return false;
    return haversineKm(zone.lat, zone.lon, info.lat, info.lon) <= SCHEDULE_ARRIVAL_RADIUS_KM;
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

  return Array.from(byTail.values())
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
  zone: (typeof FIXED_VAN_ZONES)[number];
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
                          {inferFlightType(arrFlight) === "Maintenance" ? (
                            <span className="text-xs bg-orange-100 text-orange-700 rounded px-1.5 py-0.5">Maintenance</span>
                          ) : isRepo ? (
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
  liveVanPositions,
  liveVanAddresses,
  vanZoneNames,
}: {
  allFlights: Flight[];
  date: string;
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

  // Compute base items for every zone
  const baseItemsByVan = useMemo(() => {
    const map = new Map<number, VanFlightItem[]>();
    for (const zone of FIXED_VAN_ZONES) {
      const baseLat = liveVanPositions.get(zone.vanId)?.lat ?? zone.lat;
      const baseLon = liveVanPositions.get(zone.vanId)?.lon ?? zone.lon;
      map.set(zone.vanId, computeZoneItems(zone, allFlights, date, baseLat, baseLon));
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

    // Recalculate distances + greedy sort for each van
    for (const zone of FIXED_VAN_ZONES) {
      const items = result.get(zone.vanId) ?? [];
      const baseLat = liveVanPositions.get(zone.vanId)?.lat ?? zone.lat;
      const baseLon = liveVanPositions.get(zone.vanId)?.lon ?? zone.lon;
      const sorted = greedySort(recalcDist(items, baseLat, baseLon), baseLat, baseLon);
      result.set(zone.vanId, sorted);
    }

    return result;
  }, [baseItemsByVan, overrides, removals, liveVanPositions, allDayArrivals]);

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
          Arrivals plan for {fmtLongDate(date)} · up to {MAX_ARRIVALS_PER_VAN} aircraft per van · 5 h drive limit
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
      {uncoveredItems.length > 0 && (
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
                  {uncoveredItems.length} aircraft not covered by any van — drag into a van to assign
                </div>
              </div>
            </div>
          </div>
          <div className="border-t border-red-200 divide-y divide-red-100">
            {uncoveredItems.map((item) => {
              const { arrFlight, nextDep, isRepo, nextIsRepo, airport, airportInfo } = item;
              const arrTime = arrFlight.scheduled_arrival ? new Date(arrFlight.scheduled_arrival) : null;
              return (
                <div
                  key={arrFlight.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, arrFlight.id, 0)}
                  className="px-4 py-2.5 flex items-start justify-between gap-4 cursor-grab active:cursor-grabbing hover:bg-red-50"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex flex-col items-center gap-0.5 flex-shrink-0 mt-1">
                      <div className="w-2.5 h-2.5 rounded-full bg-red-300" />
                      <svg className="w-3 h-3 text-red-300" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2}>
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
                        <span className="text-xs bg-red-100 text-red-600 rounded px-1.5 py-0.5">No Van</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {airport}{airportInfo ? ` · ${airportInfo.city}, ${airportInfo.state}` : ""}
                      </div>
                      {nextDep && (
                        <div className="text-xs mt-1 font-medium">
                          <span className={nextIsRepo ? "text-purple-700" : "text-blue-700"}>
                            Flying again {fmtTimeUntil(nextDep.scheduled_departure) && `${fmtTimeUntil(nextDep.scheduled_departure)} · `}{fmtUtcHM(nextDep.scheduled_departure)} → {nextDep.arrival_icao?.replace(/^K/, "") ?? "?"}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0 min-w-[90px]">
                    {arrTime && (
                      <div className="text-xs font-medium text-gray-700">
                        Lands {fmtUtcHM(arrFlight.scheduled_arrival!)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
  return u.includes("VAN") || u.includes("AOG") || u.includes(" OG") || u.includes("TRAN");
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

export default function VanPositioningClient({ initialFlights }: { initialFlights: Flight[] }) {
  const dates = useMemo(() => getDateRange(3), []); // 36h window ≈ 3 days
  const [dayIdx, setDayIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<"map" | "schedule" | "flights">("map");
  const [viewMode, setViewMode] = useState<"map" | "list">("map");
  const [selectedVan, setSelectedVan] = useState<number | null>(null);

  const selectedDate = dates[dayIdx];

  const positions = useMemo(() => computePositionsFromFlights(initialFlights, selectedDate), [initialFlights, selectedDate]);
  const vans       = useMemo(() => assignVans(positions), [positions]);
  const displayedVans = selectedVan === null ? vans : vans.filter((v) => v.vanId === selectedVan);

  // Filter flights to active types only (Charter/Revenue, Positioning, Owner)
  const activeFlights = useMemo(
    () => initialFlights.filter((f) => {
      const ft = inferFlightType(f);
      return ft !== null && AOG_ACTIVE_TYPES.has(ft);
    }),
    [initialFlights],
  );

  // Flights arriving on the selected date (for stats bar) — only active types
  const flightsForDay = useMemo(
    () => activeFlights.filter((f) =>
      (f.scheduled_arrival ?? f.scheduled_departure).startsWith(selectedDate)
    ),
    [activeFlights, selectedDate],
  );

  // ALL flights for the selected date (for the Flight Schedule tab)
  // Hide admin/scheduling entries that aren't actual flights
  const HIDDEN_FLIGHT_TYPES = new Set([
    "Aircraft away from home base",
    "Aircraft needs repositioning",
  ]);
  const allFlightsForDay = useMemo(
    () => initialFlights
      .filter((f) => {
        if (!f.scheduled_departure.startsWith(selectedDate)) return false;
        const ft = inferFlightType(f);
        if (ft && HIDDEN_FLIGHT_TYPES.has(ft)) return false;
        return true;
      })
      .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure)),
    [initialFlights, selectedDate],
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

  return (
    <div className="space-y-5">
      {/* ── 7-day date strip ── */}
      <DayStrip
        dates={dates}
        selectedIdx={dayIdx}
        onSelect={(i) => { setDayIdx(i); setSelectedVan(null); }}
      />

      {/* ── Stats ── */}
      <StatsBar positions={positions} vans={vans} flightCount={flightsForDay.length} />

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
        <ScheduleTab allFlights={activeFlights} date={selectedDate} liveVanPositions={liveVanPositions} liveVanAddresses={liveVanAddresses} vanZoneNames={vanZoneNames} />
      )}

      {/* ── Flight Schedule tab ── */}
      {activeTab === "flights" && (
        <div className="space-y-3">
          <div className="text-sm text-gray-500">
            All flights for {fmtLongDate(selectedDate)} · {allFlightsForDay.length} flights
          </div>
          {allFlightsForDay.length === 0 ? (
            <div className="bg-white border rounded-xl px-6 py-8 text-center text-sm text-gray-400">
              No flights scheduled for this date.
            </div>
          ) : (
            <div className="bg-white border rounded-xl overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-3">Tail</th>
                    <th className="px-4 py-3">Route</th>
                    <th className="px-4 py-3">Departure</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Arrival</th>
                    <th className="px-4 py-3 hidden md:table-cell">Duration</th>
                    <th className="px-4 py-3">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {allFlightsForDay.map((f) => {
                    const ft = inferFlightType(f);
                    const dep = f.departure_icao?.replace(/^K/, "") ?? "?";
                    const arr = f.arrival_icao?.replace(/^K/, "") ?? "?";
                    return (
                      <tr key={f.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-mono font-semibold">
                          {f.tail_number ?? <span className="text-gray-300">No tail</span>}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-gray-700">{dep}</span>
                          <span className="text-gray-400 mx-1">&rarr;</span>
                          <span className="font-mono text-gray-700">{arr}</span>
                        </td>
                        <td className="px-4 py-2.5 text-gray-600">{fmtTime(f.scheduled_departure)}</td>
                        <td className="px-4 py-2.5 text-gray-600 hidden sm:table-cell">{fmtTime(f.scheduled_arrival)}</td>
                        <td className="px-4 py-2.5 text-gray-400 hidden md:table-cell">
                          {f.scheduled_arrival ? fmtDuration(f.scheduled_departure, f.scheduled_arrival) : "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          {ft ? (
                            <span className={`inline-block text-xs rounded px-1.5 py-0.5 font-medium ${
                              ft === "Revenue" || ft === "Owner" ? "bg-green-100 text-green-700" :
                              ft === "Positioning" || ft === "Ferry" ? "bg-purple-100 text-purple-700" :
                              ft === "Maintenance" ? "bg-orange-100 text-orange-700" :
                              "bg-gray-100 text-gray-600"
                            }`}>
                              {ft}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
