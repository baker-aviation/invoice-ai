"use client";

import dynamic from "next/dynamic";
import { useState, useMemo } from "react";
import type { Flight } from "@/lib/opsApi";
import {
  computeOvernightPositions,
  assignVans,
  getDateRange,
  getTripById,
  haversineKm,
  FIXED_VAN_ZONES,
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

const CrewCarMapView = dynamic(() => import("./CrewCarMapView"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[380px] bg-gray-100 rounded-xl text-gray-500 text-sm">
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

/** Format YYYY-MM-DD trip end date for display. */
function fmtTripDate(dateStr: string): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [, mo, dy] = dateStr.split("-");
  return `${months[parseInt(mo) - 1]} ${parseInt(dy)}`;
}

function VanScheduleCard({
  van,
  color,
  flights,
}: {
  van: VanAssignment;
  color: string;
  flights: Flight[];
}) {
  const [expanded, setExpanded] = useState(true);
  const now = new Date();

  const items = van.aircraft.map((ac) => {
    const distKm = Math.round(haversineKm(van.lat, van.lon, ac.lat, ac.lon));

    // Try to find live flight data from ops-monitor
    const arrFlight = flights.find(
      (f) =>
        f.tail_number === ac.tail &&
        (f.arrival_icao === ac.airport ||
          f.arrival_icao === "K" + ac.airport ||
          f.arrival_icao?.replace(/^K/, "") === ac.airport)
    ) ?? null;

    // Fallback: use TRIPS data for the trip end date
    const trip = arrFlight ? null : getTripById(ac.tripId);

    const arrTime = arrFlight?.scheduled_arrival ? new Date(arrFlight.scheduled_arrival) : null;
    const doneForDay = arrTime !== null && arrTime < now;
    const enRoute = arrTime !== null && arrTime >= now;

    return { ac, arrFlight, trip, arrTime, doneForDay, enRoute, distKm };
  });

  const doneCount = items.filter((i) => i.doneForDay).length;

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
            <div className="font-semibold text-sm">{van.region}</div>
            <div className="text-xs text-gray-500">
              Base: <span className="font-medium">{van.homeAirport}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs bg-slate-100 text-slate-700 rounded-full px-2 py-0.5 font-medium">
            {van.aircraft.length} aircraft
          </span>
          {doneCount > 0 && (
            <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5 font-medium">
              {doneCount} done
            </span>
          )}
          <span className="text-gray-400 text-sm">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t divide-y">
          {items.map(({ ac, arrFlight, trip, arrTime, doneForDay, enRoute, distKm }) => (
            <div key={ac.tail + ac.tripId} className="px-4 py-3 flex items-start justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-semibold text-sm">{ac.tail}</span>
                    {arrFlight ? (
                      <span className="text-xs text-gray-500 font-mono">
                        {arrFlight.departure_icao ?? "?"} → {arrFlight.arrival_icao ?? ac.airport}
                      </span>
                    ) : trip ? (
                      <span className="text-xs text-gray-500 font-mono">
                        {trip.from} → {trip.to}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Overnight: <span className="font-medium">{ac.airport}</span>
                    {" · "}{ac.city}{ac.state ? `, ${ac.state}` : ""}
                    {" · "}<span className="text-gray-400">{fmtDriveTime(distKm)}</span>
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0 space-y-1">
                {arrTime ? (
                  <div className="text-xs font-medium text-gray-700">
                    {arrTime.toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                      timeZone: "UTC",
                    })} UTC
                  </div>
                ) : trip ? (
                  /* Fallback: show trip end date from TRIPS data */
                  <div className="text-xs text-gray-600 font-medium">
                    Trip ends {fmtTripDate(trip.tripEnd)}
                  </div>
                ) : null}
                {doneForDay && (
                  <span className="inline-block text-xs font-semibold bg-green-100 text-green-700 rounded-full px-2 py-0.5">
                    ✓ Done
                  </span>
                )}
                {enRoute && (
                  <span className="inline-block text-xs font-semibold bg-blue-100 text-blue-700 rounded-full px-2 py-0.5">
                    En-route
                  </span>
                )}
                {!arrTime && !trip && (
                  <span className="inline-block text-xs text-gray-400 rounded-full px-2 py-0.5 border">
                    No schedule data
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleTab({
  vans,
  flights,
  date,
}: {
  vans: VanAssignment[];
  flights: Flight[];
  date: string;
}) {
  const vanMap = new Map(vans.map((v) => [v.vanId, v]));
  const fixedZoneIds = FIXED_VAN_ZONES.map((z) => z.vanId);
  const overflowVans = vans.filter((v) => v.vanId > FIXED_VAN_ZONES.length);
  const activeCount = vans.length;

  return (
    <div className="space-y-3">
      <div className="text-sm text-gray-500 mb-1">
        Van plan for {fmtLongDate(date)} · {activeCount} van{activeCount !== 1 ? "s" : ""} deployed
      </div>

      {/* Fixed home zones */}
      {fixedZoneIds.map((zoneId) => {
        const zone = FIXED_VAN_ZONES.find((z) => z.vanId === zoneId)!;
        const van = vanMap.get(zoneId);
        const color = VAN_COLORS[(zoneId - 1) % VAN_COLORS.length];

        if (!van) {
          return (
            <div
              key={zoneId}
              className="border rounded-xl bg-gray-50 px-4 py-3 flex items-center gap-3 opacity-50"
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                style={{ background: color }}
              >
                V{zoneId}
              </div>
              <div>
                <div className="font-semibold text-sm text-gray-500">{zone.name}</div>
                <div className="text-xs text-gray-400">No aircraft in range · Base: {zone.homeAirport}</div>
              </div>
            </div>
          );
        }

        return <VanScheduleCard key={zoneId} van={van} color={color} flights={flights} />;
      })}

      {/* Overflow / flex vans (V9-V16) */}
      {overflowVans.length > 0 && (
        <>
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide pt-2">
            Flex Vans (overflow coverage)
          </div>
          {overflowVans.map((van) => {
            const color = VAN_COLORS[(van.vanId - 1) % VAN_COLORS.length];
            return <VanScheduleCard key={van.vanId} van={van} color={color} flights={flights} />;
          })}
        </>
      )}

      {activeCount === 0 && (
        <div className="rounded-xl border bg-white px-6 py-12 text-center text-gray-400">
          No van assignments for {fmtLongDate(date)}.
        </div>
      )}
    </div>
  );
}

// NOTAM tab removed — schedule view now shows per-van aircraft plans

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

// ---------------------------------------------------------------------------
// Crew Cars tab — live locations + oil change tracker
// Oil change dates stored in localStorage until migrated to Supabase.
// ---------------------------------------------------------------------------

type OilChangeRecord = {
  vehicleId: string;
  lastChangedDate: string;   // YYYY-MM-DD
  mileage?: string;
  notes?: string;
};

function OilChangeTracker({ vehicles }: { vehicles: SamsaraVan[] }) {
  const [records, setRecords] = useState<Record<string, OilChangeRecord>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ date: "", mileage: "", notes: "" });

  // Load from localStorage on mount, then seed any vehicles that have no record yet
  useMemo(() => {
    try {
      const saved = localStorage.getItem("oil_change_records");
      const existing: Record<string, OilChangeRecord> = saved ? JSON.parse(saved) : {};
      setRecords(existing);
    } catch {}
  }, []);

  // Pre-seed vehicles that have no oil change record with a random date in the past 6 months
  useMemo(() => {
    if (vehicles.length === 0) return;
    setTimeout(() => {
      setRecords((prev) => {
        const needsSeed = vehicles.some((v) => !prev[v.id]);
        if (!needsSeed) return prev;
        const now = new Date();
        const updated = { ...prev };
        for (const v of vehicles) {
          if (!updated[v.id]) {
            // Random date: 14–180 days ago
            const daysAgo = Math.floor(Math.random() * 167) + 14;
            const d = new Date(now.getTime() - daysAgo * 86_400_000);
            updated[v.id] = {
              vehicleId: v.id,
              lastChangedDate: d.toISOString().slice(0, 10),
              mileage: String(Math.floor(Math.random() * 20_000 + 28_000)),
            };
          }
        }
        try { localStorage.setItem("oil_change_records", JSON.stringify(updated)); } catch {}
        return updated;
      });
    }, 0);
  }, [vehicles.length]);

  function save(vehicleId: string) {
    const updated = {
      ...records,
      [vehicleId]: { vehicleId, lastChangedDate: form.date, mileage: form.mileage, notes: form.notes },
    };
    setRecords(updated);
    try { localStorage.setItem("oil_change_records", JSON.stringify(updated)); } catch {}
    setEditing(null);
  }

  function startEdit(v: SamsaraVan) {
    const existing = records[v.id];
    setForm({
      date: existing?.lastChangedDate ?? "",
      mileage: existing?.mileage ?? "",
      notes: existing?.notes ?? "",
    });
    setEditing(v.id);
  }

  const today = new Date();

  return (
    <div className="border rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-gray-50 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-800">🔧 Oil Change Tracker</span>
        <span className="text-xs text-gray-400 ml-1">· Stored locally — update when completed</span>
      </div>
      {vehicles.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400 text-center">No crew cars in Samsara.</div>
      ) : (
        <div className="divide-y">
          {vehicles.map((v) => {
            const rec = records[v.id];
            const daysSince = rec?.lastChangedDate
              ? Math.floor((today.getTime() - new Date(rec.lastChangedDate + "T12:00:00").getTime()) / 86400000)
              : null;
            const overdue = daysSince !== null && daysSince > 90;

            return (
              <div key={v.id} className={`px-4 py-3 ${overdue ? "bg-red-50" : ""}`}>
                {editing === v.id ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{v.name}</div>
                    <div className="flex flex-wrap gap-2">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-gray-500">Date</label>
                        <input
                          type="date"
                          value={form.date}
                          onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-gray-500">Mileage</label>
                        <input
                          type="text"
                          placeholder="e.g. 45,200"
                          value={form.mileage}
                          onChange={(e) => setForm((f) => ({ ...f, mileage: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 w-32"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-gray-500">Notes</label>
                        <input
                          type="text"
                          placeholder="Optional"
                          value={form.notes}
                          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 w-40"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => save(v.id)}
                        disabled={!form.date}
                        className="px-3 py-1.5 bg-slate-800 text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-slate-700"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditing(null)}
                        className="px-3 py-1.5 border rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-800">{v.name}</div>
                      <div className="text-xs text-gray-400 font-mono">{v.id}</div>
                      {rec ? (
                        <div className={`text-xs mt-0.5 ${overdue ? "text-red-600 font-semibold" : "text-gray-500"}`}>
                          Last oil change: {rec.lastChangedDate}
                          {rec.mileage && ` · ${rec.mileage} mi`}
                          {daysSince !== null && (
                            <span className={overdue ? " text-red-600" : " text-gray-400"}>
                              {" "}({daysSince} days ago{overdue ? " — overdue" : ""})
                            </span>
                          )}
                          {rec.notes && <span className="text-gray-400"> · {rec.notes}</span>}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-400 mt-0.5">No oil change recorded</div>
                      )}
                    </div>
                    <button
                      onClick={() => startEdit(v)}
                      className="px-3 py-1.5 border rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 shrink-0"
                    >
                      {rec ? "Update" : "Add Record"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CrewCarsTab() {
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
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const crewCars = vans.filter((v) => !isAogVehicle(v.name));

  if (loading && vans.length === 0) {
    return <div className="rounded-xl border bg-white shadow-sm px-5 py-4 text-sm text-gray-400 animate-pulse">Loading crew car locations…</div>;
  }

  if (error) {
    const unconfigured = error.includes("not configured") || error.includes("503");
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-5 py-4">
        <div className="text-sm font-semibold text-gray-700">Crew Car Live Tracking</div>
        <div className="text-xs text-gray-500 mt-0.5">
          {unconfigured ? "Add SAMSARA_API_KEY to ops-monitor secrets to enable live locations." : `Samsara error: ${error}`}
        </div>
      </div>
    );
  }

  // Crew cars with valid GPS for the map
  const mapCars = crewCars
    .filter((v) => v.lat !== null && v.lon !== null)
    .map((v) => ({ id: v.id, name: v.name, lat: v.lat!, lon: v.lon!, address: v.address, speed_mph: v.speed_mph }));

  return (
    <div className="space-y-4">
      {/* Live map */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="text-sm font-semibold text-gray-800">
            🚗 Pilot Crew Cars — Live Map
            <span className="ml-2 text-xs font-normal text-gray-400">via Samsara · {crewCars.length} vehicles</span>
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
        {mapCars.length > 0 ? (
          <CrewCarMapView cars={mapCars} />
        ) : (
          <div className="px-4 py-12 text-sm text-gray-400 text-center">
            {crewCars.length === 0 ? "No crew cars found in Samsara." : "No crew cars have GPS data yet."}
          </div>
        )}
      </div>

      {/* Vehicle list */}
      {crewCars.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Vehicle List
          </div>
          <div className="divide-y">
            {crewCars.map((v) => <VehicleRow key={v.id} v={v} />)}
          </div>
        </div>
      )}

      {/* Oil change tracker */}
      <OilChangeTracker vehicles={crewCars} />
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
        <ScheduleTab vans={vans} flights={flightsForDay} date={selectedDate} />
      )}
    </div>
  );
}
