"use client";

import dynamic from "next/dynamic";
import { useState, useMemo } from "react";
import type { Flight, OpsAlert } from "@/lib/opsApi";
import {
  computeOvernightPositions,
  assignVans,
  getDateRange,
  VanAssignment,
  AircraftOvernightPosition,
} from "@/lib/maintenanceData";

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

function severityClasses(severity: string) {
  if (severity === "critical") return "bg-red-100 text-red-800 border border-red-200";
  if (severity === "warning")  return "bg-amber-100 text-amber-800 border border-amber-200";
  return "bg-blue-100 text-blue-700 border border-blue-200";
}

const NOTAM_TYPE_LABELS: Record<string, string> = {
  EDCT: "EDCT",
  NOTAM_RUNWAY: "RWY",
  NOTAM_TAXIWAY: "TWY",
  NOTAM_TFR: "TFR",
  NOTAM_AERODROME: "AD",
  NOTAM_OTHER: "NOTAM",
};

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
// Schedule tab
// ---------------------------------------------------------------------------

function AlertRow({ alert }: { alert: OpsAlert }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border rounded-lg overflow-hidden text-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${severityClasses(alert.severity)}`}>
            {alert.severity === "critical" ? "⚠ " : ""}{alert.severity}
          </span>
          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-medium bg-slate-100 text-slate-700">
            {NOTAM_TYPE_LABELS[alert.alert_type] ?? alert.alert_type}
          </span>
          {alert.airport_icao && (
            <span className="font-mono font-semibold text-gray-800 text-xs">{alert.airport_icao}</span>
          )}
          {alert.edct_time && (
            <span className="text-gray-700 text-xs">EDCT <span className="font-semibold">{alert.edct_time}</span></span>
          )}
          {!alert.edct_time && alert.subject && (
            <span className="text-gray-600 text-xs truncate max-w-xs">{alert.subject}</span>
          )}
        </div>
        <span className="ml-auto text-gray-400 shrink-0 text-xs">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 bg-gray-50 border-t text-xs text-gray-700 space-y-1">
          {alert.subject && <p><span className="font-medium">Subject:</span> {alert.subject}</p>}
          {alert.body && (
            <pre className="whitespace-pre-wrap font-sans text-xs bg-white border rounded p-2 max-h-40 overflow-y-auto">
              {alert.body}
            </pre>
          )}
          <p className="text-gray-400">Received {fmtTime(alert.created_at)}</p>
        </div>
      )}
    </div>
  );
}

function ScheduleFlightCard({ flight }: { flight: Flight }) {
  const alerts = flight.alerts ?? [];
  const hasCritical = alerts.some((a) => a.severity === "critical");
  const hasWarning  = alerts.some((a) => a.severity === "warning");

  const borderColor = hasCritical ? "border-red-300" : hasWarning ? "border-amber-300" : "border-gray-200";
  const headerBg    = hasCritical ? "bg-red-50"     : hasWarning ? "bg-amber-50"     : "bg-white";

  return (
    <div className={`rounded-xl border-2 ${borderColor} overflow-hidden shadow-sm`}>
      <div className={`${headerBg} px-5 py-4 flex items-center justify-between gap-4`}>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xl font-bold font-mono tracking-wide">
            <span>{flight.departure_icao ?? "????"}</span>
            <span className="text-gray-400 text-base">→</span>
            <span>{flight.arrival_icao ?? "????"}</span>
          </div>
          <div className="text-sm text-gray-600 space-y-0.5">
            <div className="font-medium">{fmtTime(flight.scheduled_departure)}</div>
            {flight.scheduled_arrival && (
              <div className="text-gray-400 text-xs">
                → {fmtTime(flight.scheduled_arrival)}{" "}
                <span className="text-gray-400">({fmtDuration(flight.scheduled_departure, flight.scheduled_arrival)})</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {flight.tail_number && (
            <span className="font-mono text-sm font-semibold text-gray-700 bg-gray-100 rounded px-2 py-1">
              {flight.tail_number}
            </span>
          )}
          {alerts.length > 0 ? (
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              hasCritical ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
            }`}>
              {alerts.length} alert{alerts.length !== 1 ? "s" : ""}
            </span>
          ) : (
            <span className="text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">Clear</span>
          )}
        </div>
      </div>
      {alerts.length > 0 && (
        <div className="px-5 py-3 space-y-2 bg-white">
          {alerts.map((a) => <AlertRow key={a.id} alert={a} />)}
        </div>
      )}
    </div>
  );
}

function ScheduleTab({ flights, date }: { flights: Flight[]; date: string }) {
  if (flights.length === 0) {
    return (
      <div className="rounded-xl border bg-white px-6 py-12 text-center text-gray-400">
        No flights on schedule for {fmtLongDate(date)}.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="text-sm text-gray-500">
        {flights.length} flight{flights.length !== 1 ? "s" : ""} scheduled · {fmtLongDate(date)}
      </div>
      {flights.map((f) => <ScheduleFlightCard key={f.id} flight={f} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NOTAM tab
// ---------------------------------------------------------------------------

function NotamItemRow({ alert }: { alert: OpsAlert }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 text-sm"
      >
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${severityClasses(alert.severity)}`}>
          {alert.severity === "critical" ? "⚠ " : ""}{alert.severity}
        </span>
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono bg-slate-100 text-slate-700">
          {NOTAM_TYPE_LABELS[alert.alert_type] ?? alert.alert_type}
        </span>
        <span className="text-xs text-gray-600 truncate">{alert.subject || "—"}</span>
        <span className="ml-auto text-gray-400 shrink-0 text-xs">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && alert.body && (
        <div className="px-3 pb-3 pt-1 bg-gray-50 border-t">
          <pre className="whitespace-pre-wrap font-sans text-xs text-gray-700 bg-white border rounded p-2 max-h-48 overflow-y-auto">
            {alert.body}
          </pre>
          <p className="text-xs text-gray-400 mt-1">Received {fmtTime(alert.created_at)}</p>
        </div>
      )}
    </div>
  );
}

function AirportNotamCard({ airport, alerts }: { airport: string; alerts: OpsAlert[] }) {
  const [open, setOpen] = useState(true);
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const warning  = alerts.filter((a) => a.severity === "warning").length;

  return (
    <div className="border rounded-xl overflow-hidden bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50"
      >
        <div className="flex items-center gap-3">
          <span className="font-mono font-bold text-base text-slate-800">{airport}</span>
          <div className="flex gap-1">
            {critical > 0 && (
              <span className="bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                ⚠ {critical} critical
              </span>
            )}
            {warning > 0 && (
              <span className="bg-amber-100 text-amber-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                {warning} warning{warning !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        <span className="text-gray-400 text-sm">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t px-4 py-3 space-y-2">
          {alerts.map((a) => <NotamItemRow key={a.id} alert={a} />)}
        </div>
      )}
    </div>
  );
}

// Live NOTAM lookup (aviationweather.gov, no auth required)
function NotamSearch() {
  const [query, setQuery]   = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ text: string; notamNumber?: string; startDate?: string; endDate?: string }[]>([]);
  const [error, setError]   = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    const icao = query.trim().toUpperCase();
    if (!icao) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const res = await fetch(`/api/notams?airports=${icao}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Lookup failed");
      setResults(data.notams || []);
    } catch (e: unknown) {
      setError(String(e));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border rounded-xl bg-white shadow-sm p-4 space-y-3">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="ICAO (e.g. KTEB, KOPF)"
          maxLength={4}
          className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-slate-300"
        />
        <button
          onClick={handleSearch}
          disabled={loading || !query.trim()}
          className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-slate-700"
        >
          {loading ? "…" : "Search"}
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2">{error}</div>
      )}

      {searched && !loading && !error && results.length === 0 && (
        <div className="text-xs text-gray-400 text-center py-3">No NOTAMs found for {query}.</div>
      )}

      {results.length > 0 && (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {results.map((n, idx) => (
            <div key={idx} className="border rounded-lg p-3 text-xs space-y-1">
              {n.notamNumber && (
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-slate-700">{n.notamNumber}</span>
                  {n.startDate && <span className="text-gray-400">{n.startDate}</span>}
                  {n.endDate && <span className="text-gray-400">→ {n.endDate}</span>}
                </div>
              )}
              <pre className="whitespace-pre-wrap font-sans text-gray-700 bg-gray-50 rounded p-2 text-xs">
                {n.text || "No text available"}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotamTab({ flights }: { flights: Flight[] }) {
  const notamsByAirport = useMemo(() => {
    const seen = new Set<string>();
    const byAirport: Record<string, OpsAlert[]> = {};
    for (const f of flights) {
      for (const a of f.alerts ?? []) {
        if (!a.alert_type.startsWith("NOTAM")) continue;
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        const key = a.airport_icao || "Unknown";
        (byAirport[key] = byAirport[key] ?? []).push(a);
      }
    }
    return byAirport;
  }, [flights]);

  const entries = Object.entries(notamsByAirport).sort(([, a], [, b]) => {
    // Sort critical airports first
    const aCrit = a.some((x) => x.severity === "critical") ? 1 : 0;
    const bCrit = b.some((x) => x.severity === "critical") ? 1 : 0;
    return bCrit - aCrit;
  });

  return (
    <div className="space-y-6">
      {/* NOTAMs from ops pipeline */}
      <div>
        <div className="text-sm font-semibold text-gray-700 mb-1">Active NOTAMs from scheduled flights</div>
        <div className="text-xs text-gray-400 mb-3">
          Populated by ops-monitor every 30 min via FAA NOTAM API · linked to upcoming flight airports
        </div>
        {entries.length > 0 ? (
          <div className="space-y-3">
            {entries.map(([airport, alerts]) => (
              <AirportNotamCard key={airport} airport={airport} alerts={alerts} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border bg-white px-6 py-8 text-center text-gray-400 text-sm">
            No active NOTAMs in pipeline data.
          </div>
        )}
      </div>

      {/* Live airport lookup */}
      <div>
        <div className="text-sm font-semibold text-gray-700 mb-1">Live Airport NOTAM Lookup</div>
        <div className="text-xs text-gray-400 mb-3">
          Powered by aviationweather.gov · no authentication required · any ICAO
        </div>
        <NotamSearch />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Samsara live van locations — split into AOG Vans and Pilot Crew Cars
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
  const [vehicleTab, setVehicleTab] = useState<"aog" | "crew">("aog");

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

  useMemo(() => { load(); }, []); // run once on mount
  useMemo(() => {
    const id = setInterval(load, 60_000);
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
        <div className="w-9 h-9 rounded-full bg-white border flex items-center justify-center text-lg shrink-0">
          🚐
        </div>
        <div>
          <div className="text-sm font-semibold text-gray-700">Van Live Tracking</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {unconfigured
              ? "Add SAMSARA_API_KEY to ops-monitor secrets to enable live locations."
              : `Samsara error: ${error}`}
          </div>
        </div>
      </div>
    );
  }

  if (vans.length === 0) {
    return (
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 text-sm text-gray-400">
        No vehicles found in Samsara.
      </div>
    );
  }

  const aogVans  = vans.filter((v) => isAogVehicle(v.name));
  const crewCars = vans.filter((v) => !isAogVehicle(v.name));

  const displayed = vehicleTab === "aog" ? aogVans : crewCars;

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="text-sm font-semibold text-gray-800">
          🚐 Live Vehicle Locations
          <span className="ml-2 text-xs font-normal text-gray-400">via Samsara</span>
        </div>
        <div className="flex items-center gap-3">
          {lastFetch && (
            <span className="text-xs text-gray-400">
              Updated {lastFetch.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="text-xs text-blue-600 hover:underline disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-0 border-b">
        <button
          type="button"
          onClick={() => setVehicleTab("aog")}
          className={`flex-1 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
            vehicleTab === "aog"
              ? "bg-slate-800 text-white"
              : "bg-gray-50 text-gray-600 hover:bg-gray-100"
          }`}
        >
          AOG Vans
          <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
            vehicleTab === "aog" ? "bg-white/20 text-white" : "bg-gray-200 text-gray-700"
          }`}>
            {aogVans.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setVehicleTab("crew")}
          className={`flex-1 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-2 border-l ${
            vehicleTab === "crew"
              ? "bg-slate-800 text-white"
              : "bg-gray-50 text-gray-600 hover:bg-gray-100"
          }`}
        >
          Pilot Crew Cars
          <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
            vehicleTab === "crew" ? "bg-white/20 text-white" : "bg-gray-200 text-gray-700"
          }`}>
            {crewCars.length}
          </span>
        </button>
      </div>

      {/* Vehicle list */}
      {displayed.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400 text-center">
          No {vehicleTab === "aog" ? "AOG vans" : "pilot crew cars"} found in Samsara.
        </div>
      ) : (
        <div className="divide-y">
          {displayed.map((v) => <VehicleRow key={v.id} v={v} />)}
        </div>
      )}
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
  const vans       = useMemo(() => assignVans(positions, 16), [positions]);
  const displayedVans = selectedVan === null ? vans : vans.filter((v) => v.vanId === selectedVan);

  // Flights departing on the selected date (UTC date prefix match)
  const flightsForDay = useMemo(
    () => initialFlights.filter((f) => f.scheduled_departure.startsWith(selectedDate)),
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
          Schedule{flightsForDay.length > 0 && (
            <span className="ml-1.5 bg-blue-100 text-blue-700 rounded-full px-1.5 py-0.5 text-xs">
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
      {activeTab === "schedule" && <ScheduleTab flights={flightsForDay} date={selectedDate} />}
    </div>
  );
}
