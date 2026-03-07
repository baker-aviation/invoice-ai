"use client";

import { useState, useEffect, useCallback } from "react";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline, useMap } from "react-leaflet";
import type { AircraftPosition, FlightInfoMap } from "@/app/maintenance/MapView";

/* ── Fleet type helpers ── */

const CHALLENGER_TYPES = new Set(["CL30", "CL35"]);
const CITATION_TYPES = new Set(["C750"]);

function isChallenger(ac: AircraftPosition, fleetLookup: Map<string, string>): boolean {
  const fleet = fleetLookup.get(ac.tail);
  return fleet === "Challenger 300" || fleet === "Challenger 350";
}

function isCitation(ac: AircraftPosition, fleetLookup: Map<string, string>): boolean {
  const fleet = fleetLookup.get(ac.tail);
  return fleet === "Citation X";
}

function getAircraftColors(ac: AircraftPosition, fleetLookup: Map<string, string>): { icon: string; label: string } {
  if (isChallenger(ac, fleetLookup)) {
    return ac.on_ground
      ? { icon: "#f87171", label: "#ef4444" }   // light red / red-400 / red-500
      : { icon: "#991b1b", label: "#dc2626" };   // dark red-800 / red-600
  }
  if (isCitation(ac, fleetLookup)) {
    return ac.on_ground
      ? { icon: "#60a5fa", label: "#3b82f6" }   // light blue-400 / blue-500
      : { icon: "#1e3a8a", label: "#1d4ed8" };   // dark blue-900 / blue-700
  }
  // Default (Other/unknown fleet)
  return ac.on_ground
    ? { icon: "#a3a3a3", label: "#737373" }     // gray
    : { icon: "#404040", label: "#525252" };
}

// Airplane SVG path pointing UP (nose at top). Designed in a 32x32 viewBox.
const PLANE_PATH = "M16 1.5l-1.2 7.5-7.3 2.5 1 2 5.5-1 -1 8-3 2v2l4.5-1.5L16 24.5l1.5-1.5 4.5 1.5v-2l-3-2-1-8 5.5 1 1-2-7.3-2.5z";

function acDivIcon(ac: AircraftPosition, fleetLookup: Map<string, string>): L.DivIcon {
  const rotation = ac.track != null ? ac.track : 0;
  const colors = getAircraftColors(ac, fleetLookup);
  const size = ac.on_ground ? 18 : 22;
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

type Props = {
  aircraft: AircraftPosition[];
  flightInfo: Map<string, FlightInfoMap>;
};

/* ── Flight tracks for en-route aircraft ── */

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

    if (enRoute.length === 0) {
      setTracks(new Map());
      return;
    }

    const controller = new AbortController();
    (async () => {
      const newTracks = new Map<string, [number, number][]>();
      for (const fi of enRoute) {
        const flightId = fi.fa_flight_id;
        if (!flightId) continue;
        try {
          const res = await fetch(`/api/aircraft/track/${encodeURIComponent(flightId)}`, {
            signal: controller.signal,
            cache: "no-store",
          });
          if (res.ok) {
            const data = await res.json();
            const positions: [number, number][] = (data.positions ?? [])
              .filter((p: { latitude: number; longitude: number }) => p.latitude && p.longitude)
              .map((p: { latitude: number; longitude: number }) => [p.latitude, p.longitude] as [number, number]);
            if (positions.length > 1) {
              newTracks.set(fi.tail, positions);
            }
          }
        } catch { /* ignore */ }
      }
      if (!controller.signal.aborted) {
        setTracks(newTracks);
      }
    })();

    return () => controller.abort();
  }, [flightInfo]);

  function trackColor(tail: string): string {
    const fleet = fleetLookup.get(tail);
    if (fleet === "Challenger 300" || fleet === "Challenger 350") return "#dc2626"; // red
    if (fleet === "Citation X") return "#1d4ed8"; // blue
    return "#6b7280"; // gray
  }

  return (
    <>
      {Array.from(tracks.entries()).map(([tail, positions]) => (
        <Polyline
          key={`track-${tail}`}
          positions={positions}
          pathOptions={{
            color: trackColor(tail),
            weight: 2,
            opacity: 0.5,
            dashArray: "4 6",
          }}
        />
      ))}
    </>
  );
}

/* ── Tile layers ── */

const LIGHT_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

/** Applies CSS invert filter directly to Leaflet's tile pane element */
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

/* ── Legend ── */

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

/* ── Main map component ── */

/** Tells Leaflet to recalculate size when fullscreen toggles */
function MapResizer({ fullscreen }: { fullscreen: boolean }) {
  const map = useMap();
  useEffect(() => {
    setTimeout(() => map.invalidateSize(), 100);
  }, [fullscreen, map]);
  return null;
}

function ToggleBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
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

export default function OpsMap({ aircraft, flightInfo }: Props) {
  const [darkMode, setDarkMode] = useState(false);
  const [showRadar, setShowRadar] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const radarUrl = useRadarUrl(showRadar);

  // Build fleet type lookup from FlightAware data
  const fleetLookup = new Map<string, string>();
  for (const fi of flightInfo.values()) {
    if (fi.tail && fi.aircraft_type && !fleetLookup.has(fi.tail)) {
      const t = fi.aircraft_type;
      if (CHALLENGER_TYPES.has(t)) fleetLookup.set(fi.tail, t === "CL30" ? "Challenger 300" : "Challenger 350");
      else if (CITATION_TYPES.has(t)) fleetLookup.set(fi.tail, "Citation X");
      else fleetLookup.set(fi.tail, "Other");
    }
  }

  return (
    <div className={`relative ${isFullscreen ? "fixed inset-0 z-[9999] bg-white" : ""}`}>
      <div className="absolute top-2 right-2 z-[1000] flex gap-1.5">
        <ToggleBtn label={darkMode ? "Dark" : "Light"} active={darkMode} onClick={() => setDarkMode((v) => !v)} />
        <ToggleBtn label={showRadar ? "Radar ON" : "Radar"} active={showRadar} onClick={() => setShowRadar((v) => !v)} />
        <ToggleBtn label={isFullscreen ? "Exit ⛶" : "⛶"} active={isFullscreen} onClick={() => setIsFullscreen((v) => !v)} />
      </div>

      <MapLegend />

      <MapContainer
        center={[37.5, -96]}
        zoom={4}
        style={{ height: isFullscreen ? "100vh" : "500px", width: "100%" }}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={LIGHT_TILES}
        />
        <DarkModeFilter enabled={darkMode} />
        <MapResizer fullscreen={isFullscreen} />

        {/* Radar overlay */}
        {radarUrl && (
          <TileLayer
            key={`radar-${radarUrl}`}
            url={radarUrl}
            opacity={0.65}
            zIndex={300}
          />
        )}

        {/* Route tracks for en-route flights */}
        <FlightTracks flightInfo={flightInfo} fleetLookup={fleetLookup} />

        {/* Aircraft markers */}
        {aircraft.map((ac) => {
          const fi = flightInfo.get(ac.tail);
          const colors = getAircraftColors(ac, fleetLookup);
          return (
            <Marker
              key={`ac-${ac.tail}`}
              position={[ac.lat, ac.lon]}
              icon={acDivIcon(ac, fleetLookup)}
              zIndexOffset={ac.on_ground ? 1000 : 2000}
            >
              <Tooltip permanent direction="top" offset={[0, -14]} className="ops-tail-tooltip">
                <span style={{
                  fontWeight: 600,
                  fontSize: "9px",
                  color: colors.label,
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
              <Popup>
                <div className="text-sm space-y-1">
                  <div className="font-bold" style={{ color: colors.label }}>
                    {ac.tail}
                    {fleetLookup.has(ac.tail) && (
                      <span className="font-normal text-xs text-gray-400 ml-1.5">
                        {fleetLookup.get(ac.tail)}
                      </span>
                    )}
                  </div>
                  {ac.flight && <div className="text-xs text-gray-500">Callsign: {ac.flight}</div>}
                  {ac.description && <div className="text-xs text-gray-400">{ac.description}</div>}

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
                      <span className="font-medium" style={{ color: colors.label }}>
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
                  {ac.seen != null && (
                    <div className="text-xs text-gray-400">
                      Last seen: {ac.seen < 60 ? `${ac.seen}s ago` : `${Math.round(ac.seen / 60)}m ago`}
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

      </MapContainer>
    </div>
  );
}
