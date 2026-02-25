"use client";

import dynamic from "next/dynamic";
import { useState, useMemo } from "react";
import {
  computeOvernightPositions,
  assignVans,
  TODAY,
  TOMORROW,
  VanAssignment,
  AircraftOvernightPosition,
} from "@/lib/maintenanceData";

// Leaflet requires SSR to be disabled
const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => (
  <div className="flex items-center justify-center h-[500px] bg-gray-100 rounded-xl text-gray-500 text-sm">
    Loading map…
  </div>
) });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VAN_COLORS = [
  "#2563eb","#16a34a","#dc2626","#9333ea","#ea580c","#0891b2",
  "#d97706","#be185d","#65a30d","#0369a1","#7c3aed","#c2410c",
  "#047857","#b91c1c","#1d4ed8","#15803d",
];

function statusBadge(status: string) {
  const base = "inline-block px-2 py-0.5 rounded-full text-xs font-medium";
  if (status === "Released") return <span className={`${base} bg-green-100 text-green-800`}>Released</span>;
  if (status === "Booked")   return <span className={`${base} bg-blue-100 text-blue-800`}>Booked</span>;
  return <span className={`${base} bg-gray-100 text-gray-600`}>{status}</span>;
}

function formatDate(d: string) {
  const [y, m, day] = d.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m) - 1]} ${parseInt(day)}, ${y}`;
}

// ---------------------------------------------------------------------------
// Airport summary card
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
                <div
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ background: color }}
                />
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
// Fleet coverage stats bar
// ---------------------------------------------------------------------------
function StatsBar({ positions, vans }: { positions: AircraftOvernightPosition[]; vans: VanAssignment[] }) {
  const covered = vans.flatMap((v) => v.aircraft).length;
  const airports = new Set(positions.map((p) => p.airport)).size;
  const vansCovering = vans.filter((v) => v.aircraft.length > 0).length;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: "Aircraft Positioned", value: covered },
        { label: "Airports Covered", value: airports },
        { label: "Vans Deployed", value: `${vansCovering} / 16` },
        { label: "Avg Aircraft / Van", value: (covered / Math.max(vansCovering, 1)).toFixed(1) },
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
// Main client component
// ---------------------------------------------------------------------------
export default function VanPositioningClient() {
  const [dateTab, setDateTab] = useState<"today" | "tomorrow">("today");
  const [viewMode, setViewMode] = useState<"map" | "list">("map");
  const [selectedVan, setSelectedVan] = useState<number | null>(null);

  const date = dateTab === "today" ? TODAY : TOMORROW;

  const positions = useMemo(() => computeOvernightPositions(date), [date]);
  const vans = useMemo(() => assignVans(positions, 16), [positions]);

  const displayedVans = selectedVan === null ? vans : vans.filter((v) => v.vanId === selectedVan);

  return (
    <div className="space-y-5">
      {/* ── Top controls ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Date tabs */}
        <div className="flex bg-gray-100 rounded-xl p-1 gap-1">
          {(["today", "tomorrow"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setDateTab(t); setSelectedVan(null); }}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                dateTab === t
                  ? "bg-white shadow text-slate-800"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {t === "today" ? `Today · ${formatDate(TODAY)}` : `Tomorrow · ${formatDate(TOMORROW)}`}
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div className="flex bg-gray-100 rounded-xl p-1 gap-1">
          {(["map", "list"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                viewMode === v
                  ? "bg-white shadow text-slate-800"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {v === "map" ? "🗺 Map" : "☰ List"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Stats ── */}
      <StatsBar positions={positions} vans={vans} />

      {/* ── Van filter pills ── */}
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

      {/* ── Map or List ── */}
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

      {/* ── Full aircraft table ── */}
      <div>
        <div className="text-sm font-semibold text-gray-700 mb-2">
          All Aircraft Overnight Positions
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
              </tr>
            </thead>
            <tbody className="divide-y">
              {positions.map((p) => {
                const van = vans.find((v) => v.aircraft.some((a) => a.tail === p.tail && a.tripId === p.tripId));
                const color = van ? VAN_COLORS[(van.vanId - 1) % VAN_COLORS.length] : "#9ca3af";
                return (
                  <tr
                    key={p.tail + p.tripId}
                    className={`hover:bg-gray-50 ${
                      selectedVan !== null && van?.vanId !== selectedVan ? "opacity-30" : ""
                    }`}
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
