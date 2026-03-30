"use client";

/**
 * HeatMapView — Future flight arrivals heat map for van dispatchers.
 *
 * Shows where aircraft are headed so vans can be positioned proactively.
 * Uses graduated circle markers per airport (not a blurry heat blob) so
 * dispatchers can see exact airports with flight counts and click for details.
 */

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useMapPreferences } from "@/hooks/useMapPreferences";
import L from "leaflet";
import { MapContainer, TileLayer, CircleMarker, Marker, Circle, Popup, Tooltip, useMap } from "react-leaflet";
import type { Flight } from "@/lib/opsApi";
import { getAirportInfo, type AirportInfo } from "@/lib/airportCoords";
import { FIXED_VAN_ZONES, haversineKm, type VanZone } from "@/lib/maintenanceData";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LivePos = { lat: number; lon: number };

type AirportCluster = {
  icao: string;
  info: AirportInfo;
  flights: Flight[];
  count: number;
  nearestVanId: number | null;
  nearestVanDist: number | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIGHT_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';
const COVERAGE_RADIUS_M = 200_000; // 200km van coverage radius

const WINDOW_OPTIONS = [6, 12, 24, 48] as const;

// ---------------------------------------------------------------------------
// Color scale — blue → green → yellow → orange → red
// ---------------------------------------------------------------------------

function getHeatColor(count: number): string {
  if (count <= 1) return "#3b82f6"; // blue
  if (count === 2) return "#22c55e"; // green
  if (count === 3) return "#eab308"; // yellow
  if (count === 4) return "#f97316"; // orange
  return "#ef4444"; // red (5+)
}

function getHeatRadius(count: number): number {
  return Math.min(8 + count * 5, 35);
}

// ---------------------------------------------------------------------------
// Van icon (matches MapView.tsx)
// ---------------------------------------------------------------------------

const VAN_COLOR = "#22c55e";

function vanDivIcon(): L.DivIcon {
  return L.divIcon({
    html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="${VAN_COLOR}" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.5))">
      <path d="M1 12.5V11l2-6h11l3 4h3a2 2 0 012 2v1.5h-1a2.5 2.5 0 00-5 0H8a2.5 2.5 0 00-5 0H1zm4.5 2a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm12 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM5 7l-1.5 4h5V7H5zm4.5 0v4h4.5L12 7H9.5z"/>
    </svg>`,
    className: "",
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14],
  });
}

// ---------------------------------------------------------------------------
// Dark mode filter (matches MapView.tsx)
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

/** Tells Leaflet to recalculate size after fullscreen change */
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

function fmtEta(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/New_York",
  });
  if (diffMin <= 0) return `${time} ET`;
  const hrs = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return hrs > 0 ? `${time} ET (${hrs}h ${mins}m)` : `${time} ET (${mins}m)`;
}

function findNearestVan(
  lat: number,
  lon: number,
  liveVanPositions: Map<number, LivePos>,
): { vanId: number; dist: number } | null {
  let best: { vanId: number; dist: number } | null = null;
  for (const zone of FIXED_VAN_ZONES) {
    const pos = liveVanPositions.get(zone.vanId) ?? { lat: zone.lat, lon: zone.lon };
    const dist = haversineKm(lat, lon, pos.lat, pos.lon);
    if (!best || dist < best.dist) {
      best = { vanId: zone.vanId, dist };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Toggle button
// ---------------------------------------------------------------------------

function ToggleButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded text-xs font-medium shadow-sm transition-colors ${
        active
          ? "bg-blue-600 text-white"
          : "bg-white/90 text-gray-600 border border-gray-300 hover:bg-gray-50"
      }`}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function HeatLegend({ dark }: { dark: boolean }) {
  const bg = dark ? "bg-black/70" : "bg-white/90";
  const text = dark ? "text-gray-300" : "text-gray-700";
  const heading = dark ? "text-gray-400" : "text-gray-600";
  const counts = [1, 2, 3, 4, 5];
  return (
    <div className={`absolute bottom-3 right-3 z-[1000] ${bg} backdrop-blur-sm rounded-lg shadow-md px-3 py-2.5 text-[11px] space-y-1.5`}>
      <div className={`font-semibold ${heading} text-[10px] uppercase tracking-wider mb-1`}>Arrivals</div>
      {counts.map((c) => (
        <div key={c} className="flex items-center gap-2">
          <span
            className="inline-block rounded-full"
            style={{
              width: Math.min(8 + c * 3, 20),
              height: Math.min(8 + c * 3, 20),
              backgroundColor: getHeatColor(c),
              opacity: 0.7,
            }}
          />
          <span className={text}>{c === 5 ? "5+" : c} flight{c !== 1 ? "s" : ""}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-gray-300/30">
        <svg viewBox="0 0 24 24" width="14" height="14" fill={VAN_COLOR}>
          <path d="M1 12.5V11l2-6h11l3 4h3a2 2 0 012 2v1.5h-1a2.5 2.5 0 00-5 0H8a2.5 2.5 0 00-5 0H1zm4.5 2a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm12 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM5 7l-1.5 4h5V7H5zm4.5 0v4h4.5L12 7H9.5z"/>
        </svg>
        <span className={text}>Van position</span>
      </div>
    </div>
  );
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

export default function HeatMapView({ flights, liveVanPositions, liveVanIsLive }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { isFs, toggle: toggleFs } = useFullscreen(containerRef);
  const [windowHours, setWindowHours] = useState<number>(24);

  const [eodOnly, setEodOnly] = useState(false);

  const { prefs, toggle: togglePref } = useMapPreferences("heatmap", {
    dark: false,
    vans: true,
    rings: false,
  });

  // Filter flights to arrivals within the time window
  const clusters = useMemo<AirportCluster[]>(() => {
    const now = new Date();
    const cutoff = new Date(now.getTime() + windowHours * 3600_000);

    // Group by arrival airport — exclude repositioning/ferry flights (too volatile)
    const REPO_TYPES = new Set(["Positioning", "Ferry", "Needs pos", "Maintenance"]);
    let eligible: Flight[] = [];
    for (const f of flights) {
      if (!f.arrival_icao || !f.scheduled_arrival) continue;
      if (f.flight_type && REPO_TYPES.has(f.flight_type)) continue;
      const arr = new Date(f.scheduled_arrival);
      if (arr < now || arr > cutoff) continue;
      eligible.push(f);
    }

    // EOD filter: only keep the last arrival per tail in the window
    if (eodOnly) {
      const lastByTail = new Map<string, Flight>();
      for (const f of eligible) {
        const tail = f.tail_number ?? "";
        if (!tail) continue;
        const prev = lastByTail.get(tail);
        if (!prev || (f.scheduled_arrival ?? "") > (prev.scheduled_arrival ?? "")) {
          lastByTail.set(tail, f);
        }
      }
      eligible = [...lastByTail.values()];
    }

    const byAirport = new Map<string, Flight[]>();
    for (const f of eligible) {
      // Normalize ICAO → IATA (strip leading K for US airports)
      const iata = f.arrival_icao!.replace(/^K/, "");
      if (!byAirport.has(iata)) byAirport.set(iata, []);
      byAirport.get(iata)!.push(f);
    }

    // Build clusters with coordinates
    const result: AirportCluster[] = [];
    for (const [icao, fls] of byAirport) {
      const info = getAirportInfo(icao);
      if (!info) continue;

      const nearest = findNearestVan(info.lat, info.lon, liveVanPositions);
      result.push({
        icao,
        info,
        flights: fls.sort((a, b) => (a.scheduled_arrival ?? "").localeCompare(b.scheduled_arrival ?? "")),
        count: fls.length,
        nearestVanId: nearest?.vanId ?? null,
        nearestVanDist: nearest ? Math.round(nearest.dist) : null,
      });
    }

    return result.sort((a, b) => b.count - a.count);
  }, [flights, windowHours, eodOnly, liveVanPositions]);

  const totalArrivals = clusters.reduce((s, c) => s + c.count, 0);

  return (
    <div ref={containerRef} className="relative">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        {/* Time window buttons */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 font-medium mr-1">Window:</span>
          {WINDOW_OPTIONS.map((h) => (
            <button
              key={h}
              onClick={() => setWindowHours(h)}
              className={`px-2.5 py-1 rounded text-xs font-medium shadow-sm transition-colors ${
                windowHours === h
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
              }`}
            >
              {h}h
            </button>
          ))}
        </div>

        {/* EOD filter */}
        <button
          onClick={() => setEodOnly((v) => !v)}
          className={`px-2.5 py-1 rounded text-xs font-medium shadow-sm transition-colors ${
            eodOnly
              ? "bg-purple-600 text-white"
              : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
          }`}
        >
          EOD Only
        </button>

        {/* Stats */}
        <div className="text-xs text-gray-500">
          <span className="font-semibold text-gray-700">{totalArrivals}</span>{" "}
          {eodOnly ? "aircraft overnighting" : `arrival${totalArrivals !== 1 ? "s" : ""}`} across{" "}
          <span className="font-semibold text-gray-700">{clusters.length}</span> airport{clusters.length !== 1 ? "s" : ""}
        </div>

        <div className="flex-1" />

        {/* Layer toggles */}
        <div className="flex gap-1.5">
          <ToggleButton label="Vans" active={prefs.vans} onClick={() => togglePref("vans")} />
          <ToggleButton label="200km Rings" active={prefs.rings} onClick={() => togglePref("rings")} />
          <ToggleButton label="Dark" active={prefs.dark} onClick={() => togglePref("dark")} />
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
        <MapContainer
          center={[37.5, -96]}
          zoom={4}
          style={{ height: "100%", width: "100%" }}
          zoomControl={true}
        >
          <TileLayer url={LIGHT_TILES} attribution={TILE_ATTRIB} />
          <DarkModeFilter enabled={prefs.dark} />
          <MapResizer />

          {/* Van coverage rings */}
          {prefs.rings && FIXED_VAN_ZONES.map((zone) => {
            const pos = liveVanPositions.get(zone.vanId) ?? { lat: zone.lat, lon: zone.lon };
            return (
              <Circle
                key={`ring-${zone.vanId}`}
                center={[pos.lat, pos.lon]}
                radius={COVERAGE_RADIUS_M}
                pathOptions={{
                  color: VAN_COLOR,
                  fillColor: VAN_COLOR,
                  fillOpacity: 0.04,
                  weight: 1,
                  opacity: 0.3,
                  dashArray: "6 4",
                }}
              />
            );
          })}

          {/* Van position markers */}
          {prefs.vans && FIXED_VAN_ZONES.map((zone) => {
            const pos = liveVanPositions.get(zone.vanId) ?? { lat: zone.lat, lon: zone.lon };
            const isLive = liveVanIsLive?.get(zone.vanId) ?? false;
            return (
              <Marker
                key={`van-${zone.vanId}`}
                position={[pos.lat, pos.lon]}
                icon={vanDivIcon()}
              >
                <Tooltip
                  direction="top"
                  offset={[0, -14]}
                  className="!bg-transparent !border-0 !shadow-none !p-0"
                  permanent
                >
                  <div style={{
                    color: VAN_COLOR,
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    whiteSpace: "nowrap",
                    textShadow: "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)",
                  }}>
                    <b>V{zone.vanId}</b>
                    {!isLive && <span style={{ color: "#f59e0b" }}> ?</span>}
                  </div>
                </Tooltip>
              </Marker>
            );
          })}

          {/* Airport arrival circles */}
          {clusters.map((cluster) => (
            <CircleMarker
              key={cluster.icao}
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
              {/* Permanent label */}
              <Tooltip
                direction="top"
                offset={[0, -getHeatRadius(cluster.count)]}
                className="!bg-transparent !border-0 !shadow-none !p-0"
                permanent
              >
                <div style={{
                  color: prefs.dark ? "#fff" : "#1e293b",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 11,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  textShadow: prefs.dark
                    ? "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)"
                    : "0 1px 2px rgba(255,255,255,0.9), 0 0 4px rgba(255,255,255,0.8)",
                }}>
                  {cluster.icao} ({cluster.count})
                </div>
              </Tooltip>

              {/* Click popup with flight details */}
              <Popup maxWidth={320} className="heatmap-popup">
                <div className="text-xs space-y-2">
                  <div className="font-bold text-sm">
                    {cluster.info.name} ({cluster.icao})
                  </div>
                  <div className="text-gray-500">
                    {cluster.info.city}, {cluster.info.state}
                    {cluster.nearestVanDist !== null && (
                      <> &middot; V{cluster.nearestVanId} is {cluster.nearestVanDist} km away</>
                    )}
                  </div>
                  <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
                    {cluster.flights.map((f) => (
                      <div key={f.id} className="py-1.5 flex items-center gap-2">
                        <span className="font-mono font-bold text-gray-800">{f.tail_number}</span>
                        <span className="text-gray-400">{f.departure_icao?.replace(/^K/, "") ?? "?"}</span>
                        <span className="text-gray-400">&rarr;</span>
                        <span className="text-gray-400">{f.arrival_icao?.replace(/^K/, "")}</span>
                        <span className="ml-auto text-gray-500 tabular-nums">{fmtEta(f.scheduled_arrival)}</span>
                        {f.flight_type && (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            f.flight_type === "Revenue" || f.flight_type === "Owner"
                              ? "bg-blue-100 text-blue-700"
                              : f.flight_type === "Positioning" || f.flight_type === "Ferry"
                              ? "bg-amber-100 text-amber-700"
                              : f.flight_type === "Maintenance"
                              ? "bg-red-100 text-red-700"
                              : "bg-gray-100 text-gray-600"
                          }`}>
                            {f.flight_type}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>

        <HeatLegend dark={prefs.dark} />
      </div>
    </div>
  );
}
