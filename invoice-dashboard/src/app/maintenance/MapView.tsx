"use client";

/**
 * MapView — Van Positioning map.
 *
 * Aircraft use the same SVG icon style + fleet colors as OpsMap.
 * Van markers use a simple van silhouette (no colored circle).
 * Range rings are subtle dashed lines.
 * Toggle controls for labels, range rings, and vans to reduce clutter.
 */

import { useState } from "react";
import L from "leaflet";
import { MapContainer, TileLayer, Circle, Marker, Popup, Tooltip, Polyline } from "react-leaflet";
import type { VanAssignment } from "@/lib/maintenanceData";

// 3-hour driving radius: ~300 km at highway speed
const THREE_HOUR_RADIUS_M = 300_000;

type LivePos = { lat: number; lon: number };

export type AircraftPosition = {
  tail: string;
  lat: number;
  lon: number;
  alt_baro: number | null;
  gs: number | null;
  track: number | null;
  baro_rate: number | null;
  on_ground: boolean;
  squawk: string | null;
  flight: string | null;
  seen: number | null;
  aircraft_type: string | null;
  description: string | null;
};

export type FlightInfoMap = {
  tail: string;
  ident: string;
  fa_flight_id?: string;
  origin_icao: string | null;
  origin_name: string | null;
  destination_icao: string | null;
  destination_name: string | null;
  status: string | null;
  progress_percent: number | null;
  departure_time: string | null;
  arrival_time: string | null;
  actual_departure?: string | null;
  actual_arrival?: string | null;
  route_distance_nm: number | null;
  diverted: boolean;
  aircraft_type?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  groundspeed?: number | null;
  heading?: number | null;
};

type Props = {
  vans: VanAssignment[];
  colors: string[];
  liveVanPositions: Map<number, LivePos>;
  liveVanIsLive?: Map<number, boolean>;
  aircraftPositions?: AircraftPosition[];
  flightInfo?: Map<string, FlightInfoMap>;
};

/* ── Fleet type helpers (same as OpsMap) ── */

const CHALLENGER_TYPES = new Set(["CL30", "CL35"]);
const CITATION_TYPES = new Set(["C750"]);

function getAircraftColors(ac: AircraftPosition, fleetLookup: Map<string, string>): { icon: string; label: string } {
  const fleet = fleetLookup.get(ac.tail);
  if (fleet === "Challenger 300" || fleet === "Challenger 350") {
    return ac.on_ground
      ? { icon: "#f87171", label: "#ef4444" }
      : { icon: "#991b1b", label: "#dc2626" };
  }
  if (fleet === "Citation X") {
    return ac.on_ground
      ? { icon: "#60a5fa", label: "#3b82f6" }
      : { icon: "#1e3a8a", label: "#1d4ed8" };
  }
  return ac.on_ground
    ? { icon: "#a3a3a3", label: "#737373" }
    : { icon: "#404040", label: "#525252" };
}

// Airplane SVG path pointing UP (same as OpsMap)
const PLANE_PATH = "M16 1.5l-1.2 7.5-7.3 2.5 1 2 5.5-1 -1 8-3 2v2l4.5-1.5L16 24.5l1.5-1.5 4.5 1.5v-2l-3-2-1-8 5.5 1 1-2-7.3-2.5z";

function acDivIcon(ac: AircraftPosition, fleetLookup: Map<string, string>): L.DivIcon {
  const rotation = ac.track != null ? ac.track : 0;
  const colors = getAircraftColors(ac, fleetLookup);
  const size = ac.on_ground ? 22 : 28; // larger than OpsMap per boss request
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="${colors.icon}" style="transform:rotate(${rotation}deg);filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45))"><path d="${PLANE_PATH}"/></svg>`;
  const half = size / 2;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [size, size],
    iconAnchor: [half, half],
    popupAnchor: [0, -half],
  });
}

// Overnight plane icon — colored to van assignment
function overnightDivIcon(color: string): L.DivIcon {
  const size = 20;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="${color}" opacity="0.6" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))"><path d="${PLANE_PATH}"/></svg>`;
  const half = size / 2;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [size, size],
    iconAnchor: [half, half],
    popupAnchor: [0, -half],
  });
}

// Van icon — simple van silhouette SVG (no colored circle)
function vanDivIcon(color: string, vanId: number): L.DivIcon {
  return L.divIcon({
    html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="${color}" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))">
      <path d="M1 12.5V11l2-6h11l3 4h3a2 2 0 012 2v1.5h-1a2.5 2.5 0 00-5 0H8a2.5 2.5 0 00-5 0H1zm4.5 2a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm12 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM5 7l-1.5 4h5V7H5zm4.5 0v4h4.5L12 7H9.5z"/>
    </svg>`,
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

function fmtAlt(alt: number | null): string {
  if (alt == null) return "\u2014";
  if (alt <= 0) return "GND";
  if (alt < 1000) return `${Math.round(alt)}ft`;
  if (alt < 18000) return `${Math.round(alt / 1000)}k`;
  return `FL${Math.round(alt / 100)}`;
}

function fmtEta(iso: string | null | undefined): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  }) + "Z";
  if (diffMin <= 0) return time;
  const hrs = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  const remaining = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  return `${time} (${remaining})`;
}

/* ── Legend (same fleet key as OpsMap) ── */

function LegendPlane({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 32 32" width="14" height="14" fill={color}>
      <path d={PLANE_PATH} />
    </svg>
  );
}

function MapLegend() {
  return (
    <div className="absolute bottom-3 right-3 z-[1000] bg-white/90 backdrop-blur-sm rounded-lg shadow-md px-3 py-2.5 text-[11px] space-y-1">
      <div className="font-semibold text-gray-700 text-[10px] uppercase tracking-wider mb-1">Fleet</div>
      <div className="flex items-center gap-2">
        <LegendPlane color="#991b1b" />
        <span className="text-gray-700">Challenger - In flight</span>
      </div>
      <div className="flex items-center gap-2">
        <LegendPlane color="#f87171" />
        <span className="text-gray-700">Challenger - Ground</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <LegendPlane color="#1e3a8a" />
        <span className="text-gray-700">Citation X - In flight</span>
      </div>
      <div className="flex items-center gap-2">
        <LegendPlane color="#60a5fa" />
        <span className="text-gray-700">Citation X - Ground</span>
      </div>
    </div>
  );
}

/* ── Toggle bar ── */

function ToggleButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
        active
          ? "bg-blue-600 text-white"
          : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
      }`}
    >
      {label}
    </button>
  );
}

/* ── Radar overlay ── */

function useRadarUrl(enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useState(() => {
    if (!enabled) return;
    (async () => {
      try {
        const res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
        if (!res.ok) return;
        const data = await res.json();
        const past = data?.radar?.past;
        if (past?.length) {
          const path = past[past.length - 1].path;
          setUrl(`https://tilecache.rainviewer.com${path}/256/{z}/{x}/{y}/2/1_1.png`);
        }
      } catch { /* ignore */ }
    })();
  });

  return enabled ? url : null;
}

/* ── Main component ── */

export default function MapView({ vans, colors, liveVanPositions, liveVanIsLive, aircraftPositions, flightInfo }: Props) {
  const [showLabels, setShowLabels] = useState(true);
  const [showRings, setShowRings] = useState(true);
  const [showVans, setShowVans] = useState(true);
  const [showRadar, setShowRadar] = useState(false);
  const radarUrl = useRadarUrl(showRadar);

  // Build fleet type lookup from FlightAware data
  const fleetLookup = new Map<string, string>();
  if (flightInfo) {
    for (const fi of flightInfo.values()) {
      if (fi.tail && fi.aircraft_type && !fleetLookup.has(fi.tail)) {
        const t = fi.aircraft_type;
        if (CHALLENGER_TYPES.has(t)) fleetLookup.set(fi.tail, t === "CL30" ? "Challenger 300" : "Challenger 350");
        else if (CITATION_TYPES.has(t)) fleetLookup.set(fi.tail, "Citation X");
        else fleetLookup.set(fi.tail, "Other");
      }
    }
  }

  // Collect overnight positions
  const aircraftByAirport = new Map<
    string,
    { lat: number; lon: number; tails: string[]; vanId: number; color: string }
  >();
  for (const van of vans) {
    const color = colors[(van.vanId - 1) % colors.length];
    for (const ac of van.aircraft) {
      const key = `${ac.airport}-${van.vanId}`;
      if (!aircraftByAirport.has(key)) {
        aircraftByAirport.set(key, { lat: ac.lat, lon: ac.lon, tails: [], vanId: van.vanId, color });
      }
      aircraftByAirport.get(key)!.tails.push(ac.tail);
    }
  }

  const enRouteTails = new Set((aircraftPositions ?? []).map((a) => a.tail));

  return (
    <div className="relative">
      {/* Toggle controls */}
      <div className="absolute top-2 right-2 z-[1000] flex gap-1.5">
        <ToggleButton label="Labels" active={showLabels} onClick={() => setShowLabels((v) => !v)} />
        <ToggleButton label="Rings" active={showRings} onClick={() => setShowRings((v) => !v)} />
        <ToggleButton label="Vans" active={showVans} onClick={() => setShowVans((v) => !v)} />
        <ToggleButton label={showRadar ? "Radar ON" : "Radar"} active={showRadar} onClick={() => setShowRadar((v) => !v)} />
      </div>

      <MapLegend />

      <MapContainer
        center={[37.5, -96]}
        zoom={4}
        style={{ height: "520px", width: "100%" }}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Radar overlay */}
        {radarUrl && (
          <TileLayer key={radarUrl} url={radarUrl} opacity={0.45} zIndex={300} />
        )}

        {/* Range rings — subtle dashed lines */}
        {showRings && vans.map((van) => {
          const color = colors[(van.vanId - 1) % colors.length];
          const pos = liveVanPositions.get(van.vanId) ?? { lat: van.lat, lon: van.lon };
          return (
            <Circle
              key={`radius-${van.vanId}`}
              center={[pos.lat, pos.lon]}
              radius={THREE_HOUR_RADIUS_M}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.02,
                weight: 1,
                dashArray: "8 6",
                opacity: 0.4,
              }}
            />
          );
        })}

        {/* Van markers — simple van silhouette */}
        {showVans && vans.map((van) => {
          const color = colors[(van.vanId - 1) % colors.length];
          const cachedPos = liveVanPositions.get(van.vanId);
          const pos = cachedPos ?? { lat: van.lat, lon: van.lon };
          const isLive = liveVanIsLive ? liveVanIsLive.get(van.vanId) === true : cachedPos !== undefined;
          const isLastKnown = cachedPos !== undefined && !isLive;
          return (
            <Marker
              key={`van-${van.vanId}`}
              position={[pos.lat, pos.lon]}
              icon={vanDivIcon(color, van.vanId)}
              zIndexOffset={1000}
            >
              {showLabels && (
                <Tooltip permanent direction="top" offset={[0, -16]} className="van-label-tooltip">
                  <span style={{ fontWeight: 700, fontSize: "10px", color }}>Van {van.vanId}</span>
                </Tooltip>
              )}
              <Popup>
                <div className="text-sm space-y-1">
                  <div className="font-bold" style={{ color }}>Van {van.vanId}</div>
                  <div className="text-gray-500">{van.region}</div>
                  <div>Home base: <span className="font-medium">{van.homeAirport}</span></div>
                  {isLive ? (
                    <div className="text-xs text-green-600 font-medium">
                      ● Live GPS: {pos.lat.toFixed(4)}, {pos.lon.toFixed(4)}
                    </div>
                  ) : isLastKnown ? (
                    <div className="text-xs text-amber-600 font-medium">
                      ◐ Last known GPS: {pos.lat.toFixed(4)}, {pos.lon.toFixed(4)}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400">No GPS — showing home base</div>
                  )}
                  <div className="text-xs text-gray-500">3-hr radius ≈ 300 km</div>
                  {van.aircraft.length > 0 && (
                    <>
                      <div className="pt-1 font-medium">Overnight ({van.aircraft.length}):</div>
                      {van.aircraft.map((ac) => (
                        <div key={ac.tail} className="font-mono text-xs">
                          {ac.tail} @ {ac.airport}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* Overnight aircraft markers — colored to van, dimmed */}
        {Array.from(aircraftByAirport.entries()).map(([key, info]) => {
          const staticTails = info.tails.filter((t) => !enRouteTails.has(t));
          if (staticTails.length === 0) return null;
          return (
            <Marker
              key={`plane-${key}`}
              position={[info.lat, info.lon]}
              icon={overnightDivIcon(info.color)}
            >
              {showLabels && staticTails.length > 1 && (
                <Tooltip direction="top" offset={[0, -8]} permanent className="van-label-tooltip">
                  <span className="text-[9px] font-semibold" style={{ color: info.color }}>{staticTails.length} ac</span>
                </Tooltip>
              )}
              <Popup>
                <div className="text-sm space-y-1">
                  <div className="font-bold" style={{ color: info.color }}>
                    {staticTails.join(", ")}
                  </div>
                  <div className="text-gray-500 text-xs">
                    Overnight: {key.split("-")[0]} · Van {info.vanId}
                  </div>
                  {staticTails.map((t) => (
                    <div key={t} className="font-mono text-xs">{t}</div>
                  ))}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* En-route aircraft — OpsMap-style SVG icons with fleet colors */}
        {(aircraftPositions ?? []).map((ac) => {
          const fi = flightInfo?.get(ac.tail);
          const acColors = getAircraftColors(ac, fleetLookup);
          return (
            <Marker
              key={`fa-${ac.tail}`}
              position={[ac.lat, ac.lon]}
              icon={acDivIcon(ac, fleetLookup)}
              zIndexOffset={2000}
            >
              {showLabels && (
                <Tooltip permanent direction="top" offset={[0, -16]} className="ops-tail-tooltip">
                  <span style={{
                    fontWeight: 600,
                    fontSize: "9px",
                    color: acColors.label,
                    letterSpacing: "0.02em",
                  }}>
                    {ac.tail}
                    {!ac.on_ground && ac.alt_baro != null && ac.alt_baro > 0 && (
                      <span style={{ fontWeight: 400, opacity: 0.7, marginLeft: "3px" }}>
                        {fmtAlt(ac.alt_baro)}
                      </span>
                    )}
                  </span>
                </Tooltip>
              )}
              <Popup>
                <div className="text-sm space-y-1">
                  <div className="font-bold" style={{ color: acColors.label }}>
                    {ac.tail}
                    {fleetLookup.has(ac.tail) && (
                      <span className="font-normal text-xs text-gray-400 ml-1.5">
                        {fleetLookup.get(ac.tail)}
                      </span>
                    )}
                  </div>
                  {ac.flight && <div className="text-xs text-gray-500">Callsign: {ac.flight}</div>}

                  {fi && (fi.origin_icao || fi.destination_icao) && (
                    <div className="text-xs font-medium border-t border-gray-100 pt-1 mt-1">
                      <span className="font-mono">
                        {fi.origin_icao ?? "?"} → {fi.destination_icao ?? "?"}
                      </span>
                      {fi.progress_percent != null && (
                        <span className="text-gray-400 ml-1">({fi.progress_percent}%)</span>
                      )}
                    </div>
                  )}
                  {fi?.destination_name && (
                    <div className="text-xs text-gray-500">{fi.destination_name}</div>
                  )}

                  {fi?.arrival_time && (
                    <div className="text-xs font-semibold text-green-700">
                      ETA: {fmtEta(fi.arrival_time)}
                    </div>
                  )}

                  <div className="text-xs">
                    {ac.on_ground ? (
                      <span className="text-gray-500 font-medium">On Ground</span>
                    ) : (
                      <span className="font-medium" style={{ color: acColors.label }}>
                        {ac.baro_rate != null && ac.baro_rate > 300 ? "Climbing" : ac.baro_rate != null && ac.baro_rate < -300 ? "Descending" : "Airborne"} · {fmtAlt(ac.alt_baro)}
                        {ac.baro_rate != null && Math.abs(ac.baro_rate) > 300 && (
                          <span className="text-gray-500"> ({ac.baro_rate > 0 ? "+" : ""}{ac.baro_rate} fpm)</span>
                        )}
                      </span>
                    )}
                  </div>
                  {ac.gs != null && (
                    <div className="text-xs text-gray-600">
                      GS: {Math.round(ac.gs)} kts · HDG: {ac.track != null ? `${Math.round(ac.track)}°` : "\u2014"}
                    </div>
                  )}
                  {fi?.route_distance_nm && !ac.on_ground && (
                    <div className="text-xs text-gray-500">Route: {fi.route_distance_nm} nm</div>
                  )}
                  {fi?.diverted && (
                    <div className="text-xs font-semibold text-red-600">DIVERTED</div>
                  )}
                  <div className="text-xs text-gray-400">
                    {ac.lat.toFixed(4)}, {ac.lon.toFixed(4)}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
