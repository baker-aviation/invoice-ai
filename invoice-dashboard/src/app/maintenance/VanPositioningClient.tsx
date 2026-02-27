"use client";

import dynamic from "next/dynamic";
import { useState, useMemo } from "react";
import type { Flight } from "@/lib/opsApi";
import {
  computeOvernightPositions,
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
      className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
        active ? "bg-white shadow text-slate-800" : "text-gray-500 hover:text-gray-700"
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

/** Max one-way driving radius for schedule arrivals (≈3.3h drive). */
const SCHEDULE_ARRIVAL_RADIUS_KM = 300;

type VanFlightItem = {
  arrFlight: Flight;
  nextDep:   Flight | null;
  isRepo:     boolean;   // arriving leg is positioning
  nextIsRepo: boolean;   // next departure is positioning
  airport:    string;    // IATA
  airportInfo: ReturnType<typeof getAirportInfo>;
  distKm:     number;
};

function VanScheduleCard({
  zone,
  color,
  allFlights,
  date,
}: {
  zone: (typeof FIXED_VAN_ZONES)[number];
  color: string;
  allFlights: Flight[];
  date: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const now = new Date();

  // Arrivals near this zone's home base on the selected date
  const items = useMemo<VanFlightItem[]>(() => {
    const arrivalsToday = allFlights.filter((f) => {
      if (!f.arrival_icao || !f.scheduled_arrival) return false;
      if (!f.scheduled_arrival.startsWith(date)) return false;
      const iata = f.arrival_icao.replace(/^K/, "");
      const info = getAirportInfo(iata);
      if (!info || !isContiguous48(info.state)) return false;
      return haversineKm(zone.lat, zone.lon, info.lat, info.lon) <= SCHEDULE_ARRIVAL_RADIUS_KM;
    });

    return arrivalsToday.map((arr) => {
      const iata = arr.arrival_icao!.replace(/^K/, "");
      const info = getAirportInfo(iata);
      const distKm = info ? Math.round(haversineKm(zone.lat, zone.lon, info.lat, info.lon)) : 0;

      // Find the next departure of this tail from the same airport after it lands
      const nextDep = allFlights
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
    }).sort((a, b) =>
      (a.arrFlight.scheduled_arrival ?? "").localeCompare(b.arrFlight.scheduled_arrival ?? ""),
    );
  }, [allFlights, zone, date]);

  const totalDistKm = items.reduce((sum, i) => sum + i.distKm, 0);
  const totalDriveH = totalDistKm / 90;
  const overLimit = totalDriveH > 5;

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
            V{zone.vanId}
          </div>
          <div>
            <div className="font-semibold text-sm">{zone.name}</div>
            <div className="text-xs text-gray-500">
              Base: <span className="font-medium">{zone.homeAirport}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
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
            <div className="px-4 py-6 text-sm text-gray-400 text-center">No arrivals in area today.</div>
          ) : (
            <div className="divide-y">
              {items.map(({ arrFlight, nextDep, isRepo, nextIsRepo, airport, airportInfo, distKm }) => {
                const arrTime = arrFlight.scheduled_arrival ? new Date(arrFlight.scheduled_arrival) : null;
                const hasLanded = arrTime !== null && arrTime < now;
                const doneForDay = !nextDep;
                return (
                  <div key={arrFlight.id} className="px-4 py-3 flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1" style={{ background: color }} />
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
                              Flying again {fmtUtcHM(nextDep.scheduled_departure)} → {nextDep.arrival_icao?.replace(/^K/, "") ?? "?"}
                            </span>
                            {nextIsRepo && <span className="ml-1 text-xs text-purple-400">(repo)</span>}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0 space-y-1 min-w-[90px]">
                      {arrTime && (
                        <div className="text-xs font-medium text-gray-700">
                          Lands {fmtUtcHM(arrFlight.scheduled_arrival!)}
                        </div>
                      )}
                      <span className={`inline-block text-xs font-semibold rounded-full px-2 py-0.5 ${hasLanded ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>
                        {hasLanded ? "✓ Landed" : "En-route"}
                      </span>
                      {doneForDay && (
                        <div>
                          <span className="inline-block text-xs font-semibold bg-green-100 text-green-700 rounded-full px-2 py-0.5">
                            Done for day
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScheduleTab({
  allFlights,
  date,
}: {
  allFlights: Flight[];
  date: string;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm text-gray-500 mb-1">
        Arrivals plan for {fmtLongDate(date)} · aircraft landing within 300 km of each home base
      </div>
      {FIXED_VAN_ZONES.map((zone) => {
        const color = VAN_COLORS[(zone.vanId - 1) % VAN_COLORS.length];
        return (
          <VanScheduleCard
            key={zone.vanId}
            zone={zone}
            color={color}
            allFlights={allFlights}
            date={date}
          />
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

/** Vehicles whose name contains "VAN", "AOG", "OG", or "TRAN" are AOG support vans. */
function isAogVehicle(name: string): boolean {
  const u = (name || "").toUpperCase();
  return u.includes("VAN") || u.includes("AOG") || u.includes(" OG") || u.includes("TRAN");
}

function VehicleRow({ v }: { v: SamsaraVan }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-gray-800">{v.name || v.id}</div>
        {/* Tracker ID shown as sublabel — replace with Samsara label field once available */}
        <div className="text-xs text-gray-400 font-mono">{v.id}</div>
        <div className="text-xs text-gray-500 truncate mt-0.5">
          {v.address || (v.lat != null ? `${v.lat.toFixed(4)}, ${v.lon?.toFixed(4)}` : "No location")}
        </div>
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        {v.speed_mph != null && (
          <div className="text-sm font-semibold text-gray-700">
            {Math.round(v.speed_mph)} mph
          </div>
        )}
        {v.gps_time && (
          <div className="text-xs text-gray-400">{fmtTime(v.gps_time)}</div>
        )}
      </div>
    </div>
  );
}


function VanLiveLocations() {
  const [vans, setVans]           = useState<SamsaraVan[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/vans", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setVans(data.vans ?? []);
      setLastFetch(new Date());
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useMemo(() => { load(); }, []);
  useMemo(() => {
    const id = setInterval(load, 240_000);
    return () => clearInterval(id);
  }, []);

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
            {unconfigured ? "Add SAMSARA_API_KEY to ops-monitor secrets to enable live locations." : `Samsara error: ${error}`}
          </div>
        </div>
      </div>
    );
  }

  const aogVans = vans.filter((v) => isAogVehicle(v.name));

  if (aogVans.length === 0) {
    return (
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 text-sm text-gray-400">
        No AOG vans found in Samsara.
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="text-sm font-semibold text-gray-800">
          🚐 AOG Van Live Locations
          <span className="ml-2 text-xs font-normal text-gray-400">via Samsara · {aogVans.length} vans</span>
        </div>
        <div className="flex items-center gap-3">
          {lastFetch && (
            <span className="text-xs text-gray-400">
              Updated {lastFetch.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button onClick={load} disabled={loading} className="text-xs text-blue-600 hover:underline disabled:opacity-50">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="divide-y">
        {aogVans.map((v) => <VehicleRow key={v.id} v={v} />)}
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

function OutOfRangeAlerts({ vans }: { vans: VanAssignment[] }) {
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

  if (outOfRange.length === 0) return null;

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-red-700">
        ⚠ {outOfRange.length} aircraft outside 3-hour van range
      </div>
      <div className="flex flex-wrap gap-2">
        {outOfRange.map(({ vanId, color, tail, airport, distKm }) => (
          <div
            key={`${vanId}-${tail}`}
            className="flex items-center gap-1.5 bg-white border border-red-200 rounded-lg px-2.5 py-1.5 text-xs"
          >
            <span
              className="inline-block w-3 h-3 rounded-full flex-shrink-0"
              style={{ background: color }}
            />
            <span className="font-semibold">Van {vanId}</span>
            <span className="text-gray-400">→</span>
            <span className="font-mono font-semibold">{tail}</span>
            <span className="text-gray-500">@ {airport}</span>
            <span className="text-red-600 font-semibold">
              ~{Math.round(distKm / (THREE_HOUR_RADIUS_KM / 3))}h away
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

export default function VanPositioningClient({ initialFlights }: { initialFlights: Flight[] }) {
  const dates = useMemo(() => getDateRange(7), []);
  const [dayIdx, setDayIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<"map" | "schedule">("map");
  const [viewMode, setViewMode] = useState<"map" | "list">("map");
  const [selectedVan, setSelectedVan] = useState<number | null>(null);

  const selectedDate = dates[dayIdx];

  const positions = useMemo(() => computeOvernightPositions(selectedDate), [selectedDate]);
  const vans       = useMemo(() => assignVans(positions), [positions]);
  const displayedVans = selectedVan === null ? vans : vans.filter((v) => v.vanId === selectedVan);

  // Flights arriving on the selected date (for schedule tab)
  const flightsForDay = useMemo(
    () => initialFlights.filter((f) =>
      (f.scheduled_arrival ?? f.scheduled_departure).startsWith(selectedDate)
    ),
    [initialFlights, selectedDate],
  );

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

      {/* ── Out-of-range alerts ── */}
      <OutOfRangeAlerts vans={vans} />

      {/* ── Tab bar ── */}
      <div className="flex bg-gray-100 rounded-xl p-1 gap-1 w-fit">
        <TabBtn active={activeTab === "map"} onClick={() => setActiveTab("map")}>
          Van Map
        </TabBtn>
        <TabBtn active={activeTab === "schedule"} onClick={() => setActiveTab("schedule")}>
          Schedule
          {vans.length > 0 && (
            <span className="ml-1.5 bg-blue-100 text-blue-700 rounded-full px-1.5 py-0.5 text-xs">
              {vans.length}
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
              <MapView vans={displayedVans} colors={VAN_COLORS} />
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
          <VanLiveLocations />

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
        <ScheduleTab allFlights={initialFlights} date={selectedDate} />
      )}
    </div>
  );
}
