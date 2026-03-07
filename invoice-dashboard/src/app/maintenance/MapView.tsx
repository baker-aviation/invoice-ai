"use client";

/**
 * MapView — Van Positioning map.
 *
 * FlightAware-inspired styling: clean data labels with text shadows,
 * no white tooltip boxes, professional aviation aesthetic.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import { MapContainer, TileLayer, Circle, Marker, Popup, Tooltip, Polyline, useMap } from "react-leaflet";
import type { VanAssignment } from "@/lib/maintenanceData";

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

/* ── Fleet type helpers ── */

const CHALLENGER_TYPES = new Set(["CL30", "CL35"]);
const CITATION_TYPES = new Set(["C750"]);

function getFleetName(fleetLookup: Map<string, string>, tail: string): string | undefined {
  return fleetLookup.get(tail);
}

function getAcColor(fleetLookup: Map<string, string>, tail: string, onGround: boolean): string {
  const fleet = getFleetName(fleetLookup, tail);
  if (fleet === "Challenger 300" || fleet === "Challenger 350") {
    return onGround ? "#f87171" : "#eab308"; // ground: light red, flight: golden yellow (FA style)
  }
  if (fleet === "Citation X") {
    return onGround ? "#60a5fa" : "#22d3ee"; // ground: light blue, flight: cyan
  }
  return onGround ? "#a3a3a3" : "#d4d4d4"; // gray
}

// Airplane SVG path pointing UP
const PLANE_PATH = "M16 1.5l-1.2 7.5-7.3 2.5 1 2 5.5-1 -1 8-3 2v2l4.5-1.5L16 24.5l1.5-1.5 4.5 1.5v-2l-3-2-1-8 5.5 1 1-2-7.3-2.5z";

function acDivIcon(track: number | null, color: string, onGround: boolean): L.DivIcon {
  const rotation = track != null ? track : 0;
  const size = onGround ? 20 : 26;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="${color}" style="transform:rotate(${rotation}deg);filter:drop-shadow(0 1px 3px rgba(0,0,0,0.7))"><path d="${PLANE_PATH}"/></svg>`;
  const half = size / 2;
  return L.divIcon({ html: svg, className: "", iconSize: [size, size], iconAnchor: [half, half], popupAnchor: [0, -half] });
}

function overnightDivIcon(color: string): L.DivIcon {
  const size = 18;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="${color}" opacity="0.5" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))"><path d="${PLANE_PATH}"/></svg>`;
  const half = size / 2;
  return L.divIcon({ html: svg, className: "", iconSize: [size, size], iconAnchor: [half, half], popupAnchor: [0, -half] });
}

/** FA-style data label — full block for en-route, just tail for ground */
function acDataLabel(ac: AircraftPosition, fi: FlightInfoMap | undefined, fleetLookup: Map<string, string>): string {
  const color = getAcColor(fleetLookup, ac.tail, ac.on_ground);
  const shadow = "text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)";

  // Ground aircraft: just tail number
  if (ac.on_ground) {
    return `<div style="color:${color};font-family:ui-monospace,monospace;font-size:10px;white-space:nowrap;${shadow}"><b>${ac.tail}</b></div>`;
  }

  // En-route: full data block
  const lines: string[] = [];
  const ident = fi?.ident ?? ac.flight ?? ac.tail;
  const type = fi?.aircraft_type ?? "";
  lines.push(`<b>${ident}</b>${type ? " " + type : ""}`);
  const alt = ac.alt_baro != null && ac.alt_baro > 0 ? Math.round(ac.alt_baro).toString() : "";
  const gs = ac.gs != null ? Math.round(ac.gs).toString() : "";
  if (alt || gs) lines.push([alt, gs].filter(Boolean).join(" "));
  if (fi?.origin_icao && fi?.destination_icao) {
    const orig = fi.origin_icao.replace(/^K/, "");
    const dest = fi.destination_icao.replace(/^K/, "");
    lines.push(`${orig} ${dest}`);
  }
  return `<div style="color:${color};font-family:ui-monospace,monospace;font-size:10px;line-height:1.3;white-space:nowrap;${shadow}">${lines.join("<br>")}</div>`;
}

// Van icon — clean van silhouette, always green
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

function fmtAlt(alt: number | null): string {
  if (alt == null) return "\u2014";
  if (alt <= 0) return "GND";
  if (alt < 18000) return `${Math.round(alt)}`;
  return `FL${Math.round(alt / 100)}`;
}

function fmtEta(iso: string | null | undefined): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "UTC",
  }) + " UTC";
  if (diffMin <= 0) return time;
  const hrs = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return hrs > 0 ? `${time} (${hrs}h ${mins}m)` : `${time} (${mins}m)`;
}

/* ── Legend ── */

function LegendPlane({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 32 32" width="14" height="14" fill={color}>
      <path d={PLANE_PATH} />
    </svg>
  );
}

function MapLegend({ dark }: { dark: boolean }) {
  const bg = dark ? "bg-black/70" : "bg-white/90";
  const text = dark ? "text-gray-300" : "text-gray-700";
  const heading = dark ? "text-gray-400" : "text-gray-600";
  return (
    <div className={`absolute bottom-3 right-3 z-[1000] ${bg} backdrop-blur-sm rounded-lg shadow-md px-3 py-2.5 text-[11px] space-y-1`}>
      <div className={`font-semibold ${heading} text-[10px] uppercase tracking-wider mb-1`}>Fleet</div>
      <div className="flex items-center gap-2">
        <LegendPlane color="#eab308" />
        <span className={text}>Challenger - In flight</span>
      </div>
      <div className="flex items-center gap-2">
        <LegendPlane color="#f87171" />
        <span className={text}>Challenger - Ground</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <LegendPlane color="#22d3ee" />
        <span className={text}>Citation X - In flight</span>
      </div>
      <div className="flex items-center gap-2">
        <LegendPlane color="#60a5fa" />
        <span className={text}>Citation X - Ground</span>
      </div>
    </div>
  );
}

/* ── Toggle bar ── */

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

/* ── Tile layers + map utilities ── */

const LIGHT_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

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

/* ── Fullscreen via browser API ── */

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

/** Tells Leaflet to recalculate size after fullscreen change */
function MapResizer() {
  const map = useMap();
  useEffect(() => {
    const handler = () => setTimeout(() => map.invalidateSize(), 200);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, [map]);
  return null;
}

/* ── Flight tracks ── */

function FlightTracks({ flightInfo, fleetLookup }: { flightInfo: Map<string, FlightInfoMap>; fleetLookup: Map<string, string> }) {
  const [tracks, setTracks] = useState<Map<string, [number, number][]>>(new Map());

  useEffect(() => {
    const enRoute: FlightInfoMap[] = [];
    const seen = new Set<string>();
    for (const fi of flightInfo.values()) {
      if (fi.latitude != null && fi.longitude != null && !seen.has(fi.tail)) {
        seen.add(fi.tail);
        enRoute.push(fi);
      }
    }
    if (enRoute.length === 0) { setTracks(new Map()); return; }

    const controller = new AbortController();
    (async () => {
      const newTracks = new Map<string, [number, number][]>();
      for (const fi of enRoute) {
        if (!fi.fa_flight_id) continue;
        try {
          const res = await fetch(`/api/aircraft/track/${encodeURIComponent(fi.fa_flight_id)}`, {
            signal: controller.signal, cache: "no-store",
          });
          if (res.ok) {
            const data = await res.json();
            const positions: [number, number][] = (data.positions ?? [])
              .filter((p: { latitude: number; longitude: number }) => p.latitude && p.longitude)
              .map((p: { latitude: number; longitude: number }) => [p.latitude, p.longitude] as [number, number]);
            if (positions.length > 1) newTracks.set(fi.tail, positions);
          }
        } catch { /* ignore */ }
      }
      if (!controller.signal.aborted) setTracks(newTracks);
    })();
    return () => controller.abort();
  }, [flightInfo]);

  function trackColor(tail: string): string {
    return getAcColor(fleetLookup, tail, false);
  }

  return (
    <>
      {Array.from(tracks.entries()).map(([tail, positions]) => (
        <Polyline
          key={`track-${tail}`}
          positions={positions}
          pathOptions={{ color: trackColor(tail), weight: 2, opacity: 0.6 }}
        />
      ))}
    </>
  );
}

/* ── Radar overlay ── */

function useRadarUrl(enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { setUrl(null); return; }
    let cancelled = false;
    async function fetchUrl() {
      try {
        const res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const past = data?.radar?.past;
        if (past?.length && !cancelled) {
          const path = past[past.length - 1].path;
          setUrl(`https://tilecache.rainviewer.com${path}/256/{z}/{x}/{y}/2/1_1.png`);
        }
      } catch { /* ignore */ }
    }
    fetchUrl();
    const interval = setInterval(fetchUrl, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [enabled]);
  return url;
}

/* ── Main component ── */

export default function MapView({ vans, colors, liveVanPositions, liveVanIsLive, aircraftPositions, flightInfo }: Props) {
  const [showLabels, setShowLabels] = useState(true);
  const [showRings, setShowRings] = useState(true);
  const [showVans, setShowVans] = useState(true);
  const [darkMode, setDarkMode] = useState(false);
  const [showRadar, setShowRadar] = useState(false);
  const radarUrl = useRadarUrl(showRadar);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isFs, toggle: toggleFs } = useFullscreen(containerRef);

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
    <div ref={containerRef} className="relative" style={isFs ? { width: "100vw", height: "100vh" } : undefined}>
      {/* Toggle controls */}
      <div className="absolute top-2 right-2 z-[1000] flex gap-1.5">
        <ToggleButton label="Labels" active={showLabels} onClick={() => setShowLabels((v) => !v)} />
        <ToggleButton label="Rings" active={showRings} onClick={() => setShowRings((v) => !v)} />
        <ToggleButton label="Vans" active={showVans} onClick={() => setShowVans((v) => !v)} />
        <ToggleButton label={darkMode ? "Dark" : "Light"} active={darkMode} onClick={() => setDarkMode((v) => !v)} />
        <ToggleButton label={showRadar ? "Radar ON" : "Radar"} active={showRadar} onClick={() => setShowRadar((v) => !v)} />
        <ToggleButton label={isFs ? "Exit ⛶" : "⛶"} active={isFs} onClick={toggleFs} />
      </div>

      <MapLegend dark={darkMode} />

      <MapContainer
        center={[37.5, -96]}
        zoom={4}
        style={{ height: isFs ? "100%" : "520px", width: "100%" }}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={LIGHT_TILES}
        />
        <DarkModeFilter enabled={darkMode} />
        <MapResizer />

        {radarUrl && (
          <TileLayer key={`radar-${radarUrl}`} url={radarUrl} opacity={0.65} zIndex={300} />
        )}

        {flightInfo && <FlightTracks flightInfo={flightInfo} fleetLookup={fleetLookup} />}

        {/* Range rings */}
        {showRings && vans.map((van) => {
          const pos = liveVanPositions.get(van.vanId) ?? { lat: van.lat, lon: van.lon };
          return (
            <Circle
              key={`radius-${van.vanId}`}
              center={[pos.lat, pos.lon]}
              radius={THREE_HOUR_RADIUS_M}
              pathOptions={{ color: VAN_COLOR, fillColor: VAN_COLOR, fillOpacity: 0.02, weight: 1, dashArray: "8 6", opacity: 0.35 }}
            />
          );
        })}

        {/* Van markers */}
        {showVans && vans.map((van) => {
          const cachedPos = liveVanPositions.get(van.vanId);
          const pos = cachedPos ?? { lat: van.lat, lon: van.lon };
          const isLive = liveVanIsLive ? liveVanIsLive.get(van.vanId) === true : cachedPos !== undefined;
          const isLastKnown = cachedPos !== undefined && !isLive;
          return (
            <Marker key={`van-${van.vanId}`} position={[pos.lat, pos.lon]} icon={vanDivIcon()} zIndexOffset={1000}>
              {showLabels && (
                <Tooltip permanent direction="top" offset={[0, -14]} className="fa-data-tooltip">
                  <div style={{ color: VAN_COLOR, fontFamily: "ui-monospace,monospace", fontSize: "10px", fontWeight: 700, whiteSpace: "nowrap", textShadow: "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)" }}>
                    Van {van.vanId}
                  </div>
                </Tooltip>
              )}
              <Popup>
                <div className="text-sm space-y-1">
                  <div className="font-bold" style={{ color: VAN_COLOR }}>Van {van.vanId}</div>
                  <div className="text-gray-500">{van.region}</div>
                  <div>Home: <span className="font-medium">{van.homeAirport}</span></div>
                  {isLive ? (
                    <div className="text-xs text-green-600 font-medium">● Live GPS</div>
                  ) : isLastKnown ? (
                    <div className="text-xs text-amber-600 font-medium">◐ Last known</div>
                  ) : (
                    <div className="text-xs text-gray-400">No GPS</div>
                  )}
                  {van.aircraft.length > 0 && (
                    <>
                      <div className="pt-1 font-medium text-xs">Aircraft ({van.aircraft.length}):</div>
                      {van.aircraft.map((ac) => (
                        <div key={ac.tail} className="font-mono text-xs">{ac.tail} @ {ac.airport}</div>
                      ))}
                    </>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* Overnight aircraft */}
        {Array.from(aircraftByAirport.entries()).map(([key, info]) => {
          const staticTails = info.tails.filter((t) => !enRouteTails.has(t));
          if (staticTails.length === 0) return null;
          return (
            <Marker key={`plane-${key}`} position={[info.lat, info.lon]} icon={overnightDivIcon(info.color)}>
              {showLabels && (
                <Tooltip direction="right" offset={[10, 0]} permanent className="fa-data-tooltip">
                  <div style={{ color: info.color, fontFamily: "ui-monospace,monospace", fontSize: "10px", whiteSpace: "nowrap", textShadow: "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)" }}>
                    <b>{staticTails.join(", ")}</b>
                  </div>
                </Tooltip>
              )}
              <Popup>
                <div className="text-sm space-y-1">
                  <div className="font-bold" style={{ color: info.color }}>{staticTails.join(", ")}</div>
                  <div className="text-gray-500 text-xs">Overnight: {key.split("-")[0]} · Van {info.vanId}</div>
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* En-route aircraft — FA-style labels */}
        {(aircraftPositions ?? []).map((ac) => {
          const fi = flightInfo?.get(ac.tail);
          const color = getAcColor(fleetLookup, ac.tail, ac.on_ground);
          return (
            <Marker
              key={`fa-${ac.tail}`}
              position={[ac.lat, ac.lon]}
              icon={acDivIcon(ac.track, color, ac.on_ground)}
              zIndexOffset={2000}
            >
              {showLabels && (
                <Tooltip permanent direction="right" offset={[14, 0]} className="fa-data-tooltip">
                  <div dangerouslySetInnerHTML={{ __html: acDataLabel(ac, fi, fleetLookup) }} />
                </Tooltip>
              )}
              <Popup>
                <div className="text-sm space-y-1">
                  <div className="font-bold" style={{ color }}>
                    {ac.tail}
                    {fleetLookup.has(ac.tail) && (
                      <span className="font-normal text-xs text-gray-400 ml-1.5">{fleetLookup.get(ac.tail)}</span>
                    )}
                  </div>
                  {fi && (fi.origin_icao || fi.destination_icao) && (
                    <div className="text-xs font-medium font-mono">
                      {fi.origin_icao ?? "?"} → {fi.destination_icao ?? "?"}
                      {fi.progress_percent != null && <span className="text-gray-400 ml-1">({fi.progress_percent}%)</span>}
                    </div>
                  )}
                  {fi?.arrival_time && (
                    <div className="text-xs font-semibold text-green-700">ETA: {fmtEta(fi.arrival_time)}</div>
                  )}
                  <div className="text-xs">
                    {ac.on_ground ? (
                      <span className="text-gray-500 font-medium">On Ground</span>
                    ) : (
                      <span className="font-medium" style={{ color }}>
                        {fmtAlt(ac.alt_baro)} · {ac.gs != null ? `${Math.round(ac.gs)} kts` : ""}
                      </span>
                    )}
                  </div>
                  {fi?.diverted && <div className="text-xs font-semibold text-red-600">DIVERTED</div>}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
