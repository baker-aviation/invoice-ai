"use client";

/**
 * NightBeforeTab — Map-based overnight van repositioning planner.
 *
 * Shows a map with:
 *  - Current van GPS positions (green truck icons)
 *  - Tomorrow's flight arrival clusters (heat circles)
 *  - Dashed lines from each van to its demand zone (amber = needs move, green = in position)
 *  - A summary panel below with move recommendations
 */

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useMapPreferences } from "@/hooks/useMapPreferences";
import L from "leaflet";
import { MapContainer, TileLayer, CircleMarker, Marker, Polyline, Popup, Tooltip, useMap } from "react-leaflet";
import type { Flight } from "@/lib/opsApi";
import { getAirportInfo, type AirportInfo } from "@/lib/airportCoords";
import {
  FIXED_VAN_ZONES,
  haversineKm,
  computeOvernightPositionsFromFlights,
  assignVans,
  type VanZone,
  type VanAssignment,
} from "@/lib/maintenanceData";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LivePos = { lat: number; lon: number };

type DemandCluster = {
  icao: string;
  airports: string[];
  info: AirportInfo;
  flights: Flight[];
  count: number;
};

type VanMove = {
  vanId: number;
  zone: VanZone;
  currentPos: LivePos;
  currentLabel: string;
  demandPos: LivePos | null;      // where to go (null = no demand)
  demandAirport: string | null;
  demandLabel: string;
  aircraftCount: number;
  firstArrivalET: string | null;
  distanceMi: number;
  inPosition: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIGHT_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';
const CLUSTER_RADIUS_KM = 80.5; // 50mi
const IN_POSITION_KM = 80.5;
const KM_TO_MI = 0.621371;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function getHeatColor(count: number): string {
  if (count <= 1) return "#3b82f6";
  if (count === 2) return "#22c55e";
  if (count === 3) return "#eab308";
  if (count === 4) return "#f97316";
  return "#ef4444";
}

function getHeatRadius(count: number): number {
  return Math.min(8 + count * 5, 35);
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const VAN_COLOR = "#22c55e";
const VAN_MOVE_COLOR = "#f59e0b"; // amber

function vanDivIcon(needsMove: boolean): L.DivIcon {
  const color = needsMove ? VAN_MOVE_COLOR : VAN_COLOR;
  return L.divIcon({
    html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="${color}" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.5))">
      <path d="M1 12.5V11l2-6h11l3 4h3a2 2 0 012 2v1.5h-1a2.5 2.5 0 00-5 0H8a2.5 2.5 0 00-5 0H1zm4.5 2a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm12 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM5 7l-1.5 4h5V7H5zm4.5 0v4h4.5L12 7H9.5z"/>
    </svg>`,
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

// ---------------------------------------------------------------------------
// Map utilities (same as HeatMapView)
// ---------------------------------------------------------------------------

function DarkModeFilter({ enabled }: { enabled: boolean }) {
  const map = useMap();
  useEffect(() => {
    const pane = map.getPane("tilePane");
    if (pane) {
      pane.style.filter = enabled
        ? "invert(1) hue-rotate(180deg) brightness(0.85) contrast(1.2)"
        : "";
    }
  }, [enabled, map]);
  return null;
}

function MapResizer() {
  const map = useMap();
  useEffect(() => {
    const handler = () => { setTimeout(() => map.invalidateSize(), 200); };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, [map]);
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VAN_DAY_START_HOUR_ET = 5;

function isOnVanDate(utcIso: string | null | undefined, etDate: string): boolean {
  if (!utcIso) return false;
  const shifted = new Date(new Date(utcIso).getTime() - VAN_DAY_START_HOUR_ET * 3600000);
  return shifted.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === etDate;
}

function fmtTimeET(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/New_York",
  });
}

function fmtDateET(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "America/New_York",
  }) + " " + fmtTimeET(iso);
}

function fmtDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function nearestAirportLabel(lat: number, lon: number): string {
  let bestCode = "Unknown";
  let bestDist = Infinity;
  for (const zone of FIXED_VAN_ZONES) {
    const d = haversineKm(lat, lon, zone.lat, zone.lon);
    if (d < bestDist) { bestDist = d; bestCode = zone.homeAirport; }
  }
  return bestDist < 30 ? bestCode : `near ${bestCode}`;
}

function driveLabel(km: number): string {
  const mins = Math.round((km / 80) * 60); // ~50mph
  if (mins < 60) return `~${mins}m drive`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `~${h}h ${m}m drive` : `~${h}h drive`;
}

// ---------------------------------------------------------------------------
// Fullscreen hook
// ---------------------------------------------------------------------------

function useFullscreen(ref: React.RefObject<HTMLDivElement | null>) {
  const [isFs, setIsFs] = useState(false);
  const toggle = useCallback(() => {
    if (!ref.current) return;
    if (!document.fullscreenElement) {
      ref.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, [ref]);
  useEffect(() => {
    const handler = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);
  return { isFs, toggle };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type Props = {
  flights: Flight[];
  liveVanPositions: Map<number, LivePos>;
  liveVanIsLive?: Map<number, boolean>;
};

export default function NightBeforeTab({ flights, liveVanPositions, liveVanIsLive }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { isFs, toggle: toggleFs } = useFullscreen(containerRef);

  const { prefs, toggle: togglePref } = useMapPreferences("nightbefore", {
    dark: false,
    lines: true,
  });

  // Date selection: tomorrow + 2 more days
  const dateOptions = useMemo(() => {
    return Array.from({ length: 3 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() + 1 + i);
      return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
    });
  }, []);
  const [selectedDate, setSelectedDate] = useState(dateOptions[0]);

  // ---------------------------------------------------------------------------
  // Compute demand clusters (arrival heat map for selected date)
  // ---------------------------------------------------------------------------
  const demandClusters = useMemo<DemandCluster[]>(() => {
    const arrivals = flights.filter((f) =>
      f.arrival_icao && f.scheduled_arrival && isOnVanDate(f.scheduled_arrival, selectedDate)
    );

    // Group by airport
    const byAirport = new Map<string, { info: AirportInfo; flights: Flight[] }>();
    for (const f of arrivals) {
      const iata = f.arrival_icao!.replace(/^K/, "");
      const info = getAirportInfo(iata);
      if (!info) continue;
      let entry = byAirport.get(iata);
      if (!entry) { entry = { info, flights: [] }; byAirport.set(iata, entry); }
      entry.flights.push(f);
    }

    // Proximity clustering (same 50mi logic as heat map)
    const entries = [...byAirport.entries()].sort((a, b) => b[1].flights.length - a[1].flights.length);
    const result: DemandCluster[] = [];
    const claimed = new Set<string>();

    for (const [icao, entry] of entries) {
      if (claimed.has(icao)) continue;
      claimed.add(icao);
      const airports = [icao];
      const allFlights = [...entry.flights];

      for (const [otherIcao, otherEntry] of entries) {
        if (claimed.has(otherIcao)) continue;
        if (haversineKm(entry.info.lat, entry.info.lon, otherEntry.info.lat, otherEntry.info.lon) <= CLUSTER_RADIUS_KM) {
          claimed.add(otherIcao);
          airports.push(otherIcao);
          allFlights.push(...otherEntry.flights);
        }
      }

      allFlights.sort((a, b) => (a.scheduled_arrival ?? "").localeCompare(b.scheduled_arrival ?? ""));
      result.push({ icao, airports, info: entry.info, flights: allFlights, count: allFlights.length });
    }

    return result.sort((a, b) => b.count - a.count);
  }, [flights, selectedDate]);

  // ---------------------------------------------------------------------------
  // Compute van moves
  // ---------------------------------------------------------------------------
  const moves = useMemo<VanMove[]>(() => {
    const arrivals = flights.filter((f) =>
      f.arrival_icao && f.scheduled_arrival && isOnVanDate(f.scheduled_arrival, selectedDate)
    );

    const overnightPositions = computeOvernightPositionsFromFlights(flights, selectedDate);
    const vanAssignments = assignVans(overnightPositions);
    const assignmentMap = new Map<number, VanAssignment>();
    for (const va of vanAssignments) assignmentMap.set(va.vanId, va);

    // Earliest arrival per tail
    const tailFirstArrival = new Map<string, Flight>();
    for (const f of arrivals) {
      if (!f.tail_number) continue;
      const prev = tailFirstArrival.get(f.tail_number);
      if (!prev || (f.scheduled_arrival ?? "") < (prev.scheduled_arrival ?? "")) {
        tailFirstArrival.set(f.tail_number, f);
      }
    }

    return FIXED_VAN_ZONES.map((zone): VanMove => {
      const assignment = assignmentMap.get(zone.vanId);
      const aircraftCount = assignment?.aircraft.length ?? 0;
      const currentPos = liveVanPositions.get(zone.vanId) ?? { lat: zone.lat, lon: zone.lon };
      const isLive = liveVanIsLive?.get(zone.vanId) ?? false;
      const currentLabel = isLive ? nearestAirportLabel(currentPos.lat, currentPos.lon) : `${zone.homeAirport} (home)`;

      let demandPos: LivePos | null = null;
      let demandAirport: string | null = null;
      let demandLabel = "No flights";
      let firstArrivalET: string | null = null;

      if (assignment && assignment.aircraft.length > 0) {
        let earliestFlight: Flight | null = null;
        for (const ac of assignment.aircraft) {
          const fa = tailFirstArrival.get(ac.tail);
          if (fa && (!earliestFlight || (fa.scheduled_arrival ?? "") < (earliestFlight.scheduled_arrival ?? ""))) {
            earliestFlight = fa;
          }
        }

        if (earliestFlight) {
          const arrIcao = earliestFlight.arrival_icao!.replace(/^K/, "");
          const info = getAirportInfo(arrIcao);
          demandAirport = arrIcao;
          demandLabel = info ? `${info.name} (${arrIcao})` : arrIcao;
          firstArrivalET = fmtTimeET(earliestFlight.scheduled_arrival!);
          demandPos = info ? { lat: info.lat, lon: info.lon } : null;
        } else {
          // Parked aircraft — van stays near them
          const ap = assignment.aircraft[0].airport;
          const info = getAirportInfo(ap);
          demandAirport = ap;
          demandLabel = info ? `${info.name} — parked` : `${ap} — parked`;
          demandPos = info ? { lat: info.lat, lon: info.lon } : null;
        }
      }

      const distKm = demandPos
        ? haversineKm(currentPos.lat, currentPos.lon, demandPos.lat, demandPos.lon)
        : 0;

      return {
        vanId: zone.vanId,
        zone,
        currentPos,
        currentLabel,
        demandPos,
        demandAirport,
        demandLabel,
        aircraftCount,
        firstArrivalET,
        distanceMi: Math.round(distKm * KM_TO_MI),
        inPosition: aircraftCount === 0 || distKm <= IN_POSITION_KM,
      };
    });
  }, [flights, selectedDate, liveVanPositions, liveVanIsLive]);

  const totalArrivals = demandClusters.reduce((s, c) => s + c.count, 0);
  const needsMoveCount = moves.filter((m) => m.aircraftCount > 0 && !m.inPosition).length;

  return (
    <div ref={containerRef} className="relative space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 font-medium mr-1">Plan for:</span>
          {dateOptions.map((d) => (
            <button
              key={d}
              onClick={() => setSelectedDate(d)}
              className={`px-2.5 py-1 rounded text-xs font-medium shadow-sm transition-colors ${
                selectedDate === d
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
              }`}
            >
              {fmtDateLabel(d)}
            </button>
          ))}
        </div>

        <div className="text-xs text-gray-500">
          <span className="font-semibold text-gray-700">{totalArrivals}</span> arrival{totalArrivals !== 1 ? "s" : ""} across{" "}
          <span className="font-semibold text-gray-700">{demandClusters.length}</span> zone{demandClusters.length !== 1 ? "s" : ""}
          {needsMoveCount > 0 && (
            <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
              {needsMoveCount} van{needsMoveCount !== 1 ? "s" : ""} need repositioning
            </span>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex gap-1.5">
          <button
            onClick={() => togglePref("lines")}
            className={`px-2.5 py-1 rounded text-xs font-medium shadow-sm transition-colors ${
              prefs.lines
                ? "bg-amber-600 text-white"
                : "bg-white/90 text-gray-600 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            Move Lines
          </button>
          <button
            onClick={() => togglePref("dark")}
            className={`px-2.5 py-1 rounded text-xs font-medium shadow-sm transition-colors ${
              prefs.dark
                ? "bg-blue-600 text-white"
                : "bg-white/90 text-gray-600 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            Dark
          </button>
          <button
            onClick={toggleFs}
            className="px-2.5 py-1 rounded text-xs font-medium shadow-sm bg-white/90 text-gray-600 border border-gray-300 hover:bg-gray-50"
          >
            {isFs ? "Exit FS" : "Fullscreen"}
          </button>
        </div>
      </div>

      {/* Map */}
      <div className="rounded-xl overflow-hidden shadow-md border border-gray-200" style={{ height: isFs ? "100vh" : 600 }}>
        <MapContainer center={[37.5, -96]} zoom={4} style={{ height: "100%", width: "100%" }} zoomControl>
          <TileLayer url={LIGHT_TILES} attribution={TILE_ATTRIB} />
          <DarkModeFilter enabled={prefs.dark} />
          <MapResizer />

          {/* Move lines: van current → demand position */}
          {prefs.lines && moves.map((m) => {
            if (m.aircraftCount === 0 || !m.demandPos) return null;
            return (
              <Polyline
                key={`line-${m.vanId}`}
                positions={[
                  [m.currentPos.lat, m.currentPos.lon],
                  [m.demandPos.lat, m.demandPos.lon],
                ]}
                pathOptions={{
                  color: m.inPosition ? VAN_COLOR : VAN_MOVE_COLOR,
                  weight: m.inPosition ? 1.5 : 2.5,
                  opacity: m.inPosition ? 0.3 : 0.7,
                  dashArray: m.inPosition ? "4 6" : "8 6",
                }}
              />
            );
          })}

          {/* Demand clusters (arrival circles) */}
          {demandClusters.map((cluster) => (
            <CircleMarker
              key={`demand-${cluster.icao}`}
              center={[cluster.info.lat, cluster.info.lon]}
              radius={getHeatRadius(cluster.count)}
              pathOptions={{
                color: getHeatColor(cluster.count),
                fillColor: getHeatColor(cluster.count),
                fillOpacity: 0.45,
                weight: 2,
                opacity: 0.8,
              }}
            >
              <Tooltip
                direction="top"
                offset={[0, -getHeatRadius(cluster.count)]}
                className="!bg-transparent !border-0 !shadow-none !p-0"
                permanent
              >
                <div style={{
                  color: prefs.dark ? "#fff" : "#1e293b",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  textShadow: prefs.dark
                    ? "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)"
                    : "0 1px 2px rgba(255,255,255,0.9), 0 0 4px rgba(255,255,255,0.8)",
                }}>
                  {cluster.airports.length > 1
                    ? `${cluster.airports.slice(0, 3).join("/")}${cluster.airports.length > 3 ? "\u2026" : ""} (${cluster.count})`
                    : `${cluster.icao} (${cluster.count})`}
                </div>
              </Tooltip>
              <Popup maxWidth={320}>
                <div className="text-xs space-y-2">
                  <div className="font-bold text-sm">
                    {cluster.airports.length > 1
                      ? `${cluster.airports.join(", ")} area`
                      : `${cluster.info.name} (${cluster.icao})`}
                  </div>
                  <div className="text-gray-500">
                    {cluster.count} arrival{cluster.count !== 1 ? "s" : ""} on {fmtDateLabel(selectedDate)}
                  </div>
                  <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
                    {cluster.flights.map((f) => (
                      <div key={f.id} className="py-1.5 flex items-center gap-2">
                        <span className="font-mono font-bold text-gray-800">{f.tail_number}</span>
                        <span className="text-gray-400">{f.departure_icao?.replace(/^K/, "") ?? "?"} &rarr; {f.arrival_icao?.replace(/^K/, "")}</span>
                        <span className="ml-auto text-gray-500 tabular-nums">{fmtDateET(f.scheduled_arrival!)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          ))}

          {/* Van markers (current positions) */}
          {moves.map((m) => {
            const isLive = liveVanIsLive?.get(m.vanId) ?? false;
            const needsMove = m.aircraftCount > 0 && !m.inPosition;
            return (
              <Marker
                key={`van-${m.vanId}`}
                position={[m.currentPos.lat, m.currentPos.lon]}
                icon={vanDivIcon(needsMove)}
              >
                <Tooltip
                  direction="top"
                  offset={[0, -16]}
                  className="!bg-transparent !border-0 !shadow-none !p-0"
                  permanent
                >
                  <div style={{
                    color: needsMove ? VAN_MOVE_COLOR : VAN_COLOR,
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    whiteSpace: "nowrap",
                    textShadow: "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)",
                  }}>
                    <b>V{m.vanId}</b>
                    {!isLive && <span style={{ color: "#9ca3af" }}> ?</span>}
                  </div>
                </Tooltip>
                <Popup maxWidth={280}>
                  <div className="text-xs space-y-1.5">
                    <div className="font-bold text-sm">Van {m.vanId} — {m.zone.name}</div>
                    <div className="text-gray-500">Currently: {m.currentLabel}</div>
                    {m.aircraftCount > 0 ? (
                      <>
                        <div className={`font-medium ${m.inPosition ? "text-green-600" : "text-amber-700"}`}>
                          {m.inPosition
                            ? `In position for ${m.demandAirport}`
                            : `Move to ${m.demandAirport} — ${m.distanceMi} mi (${driveLabel(m.distanceMi / KM_TO_MI)})`}
                        </div>
                        <div className="text-gray-500">
                          {m.aircraftCount} aircraft · First arrival {m.firstArrivalET ?? "—"} ET
                        </div>
                      </>
                    ) : (
                      <div className="text-gray-400">No demand — stay put</div>
                    )}
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>

        {/* Legend */}
        <div className={`absolute bottom-3 right-3 z-[1000] ${prefs.dark ? "bg-black/70" : "bg-white/90"} backdrop-blur-sm rounded-lg shadow-md px-3 py-2.5 text-[11px] space-y-1.5`}>
          <div className={`font-semibold ${prefs.dark ? "text-gray-400" : "text-gray-600"} text-[10px] uppercase tracking-wider mb-1`}>Legend</div>
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" width="14" height="14" fill={VAN_COLOR}>
              <path d="M1 12.5V11l2-6h11l3 4h3a2 2 0 012 2v1.5h-1a2.5 2.5 0 00-5 0H8a2.5 2.5 0 00-5 0H1zm4.5 2a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm12 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>
            </svg>
            <span className={prefs.dark ? "text-gray-300" : "text-gray-700"}>In position</span>
          </div>
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" width="14" height="14" fill={VAN_MOVE_COLOR}>
              <path d="M1 12.5V11l2-6h11l3 4h3a2 2 0 012 2v1.5h-1a2.5 2.5 0 00-5 0H8a2.5 2.5 0 00-5 0H1zm4.5 2a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm12 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>
            </svg>
            <span className={prefs.dark ? "text-gray-300" : "text-gray-700"}>Needs to move</span>
          </div>
          {[1, 2, 3, 5].map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span className="inline-block rounded-full" style={{
                width: Math.min(8 + c * 3, 20), height: Math.min(8 + c * 3, 20),
                backgroundColor: getHeatColor(c), opacity: 0.7,
              }} />
              <span className={prefs.dark ? "text-gray-300" : "text-gray-700"}>
                {c === 5 ? "5+" : c} arrival{c !== 1 ? "s" : ""}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Move summary cards (below map) */}
      {needsMoveCount > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-bold text-gray-700">Repositioning Needed</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-2">
            {moves
              .filter((m) => m.aircraftCount > 0 && !m.inPosition)
              .sort((a, b) => b.distanceMi - a.distanceMi)
              .map((m) => (
                <div key={m.vanId} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-amber-800">V{m.vanId} — {m.zone.name}</span>
                    <span className="px-2 py-0.5 rounded-full bg-amber-200 text-amber-800 font-medium">
                      {m.distanceMi} mi
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-gray-600">
                    <span className="font-mono">{m.currentLabel}</span>
                    <span className="text-amber-500">&rarr;</span>
                    <span className="font-mono font-medium text-amber-700">{m.demandAirport}</span>
                  </div>
                  <div className="text-gray-500">
                    {m.aircraftCount} aircraft · 1st arrival {m.firstArrivalET ?? "—"} ET · {driveLabel(m.distanceMi / KM_TO_MI)}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
