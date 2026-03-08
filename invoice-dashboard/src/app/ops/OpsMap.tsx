"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline, useMap } from "react-leaflet";
import type { AircraftPosition, FlightInfoMap } from "@/app/maintenance/MapView";
import { getAirportInfo } from "@/lib/airportCoords";

/* ── Fleet type helpers ── */

const CHALLENGER_TYPES = new Set(["CL30", "CL35"]);
const CITATION_TYPES = new Set(["C750"]);

function getAcColor(fleetLookup: Map<string, string>, tail: string, onGround: boolean): string {
  const fleet = fleetLookup.get(tail);
  if (fleet === "Challenger 300" || fleet === "Challenger 350") {
    return onGround ? "#fca5a5" : "#ef4444";
  }
  if (fleet === "Citation X") {
    return onGround ? "#93c5fd" : "#2563eb";
  }
  return onGround ? "#a3a3a3" : "#d4d4d4";
}

const PLANE_PATH = "M16 1.5l-1.2 7.5-7.3 2.5 1 2 5.5-1 -1 8-3 2v2l4.5-1.5L16 24.5l1.5-1.5 4.5 1.5v-2l-3-2-1-8 5.5 1 1-2-7.3-2.5z";

function acDivIcon(track: number | null, color: string, onGround: boolean): L.DivIcon {
  const rotation = track != null ? track : 0;
  const size = onGround ? 18 : 22;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="${color}" style="transform:rotate(${rotation}deg);filter:drop-shadow(0 1px 3px rgba(0,0,0,0.7))"><path d="${PLANE_PATH}"/></svg>`;
  const half = size / 2;
  return L.divIcon({ html: svg, className: "", iconSize: [size, size], iconAnchor: [half, half], popupAnchor: [0, -half] });
}

/** Map label — tail number only */
function acDataLabel(ac: AircraftPosition, _fi: FlightInfoMap | undefined, fleetLookup: Map<string, string>): string {
  const color = getAcColor(fleetLookup, ac.tail, ac.on_ground);
  const shadow = "text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)";
  return `<div style="color:${color};font-family:ui-monospace,monospace;font-size:10px;white-space:nowrap;${shadow}"><b>${ac.tail}</b></div>`;
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

function fmtAlt(alt: number | null): string {
  if (alt == null) return "\u2014";
  if (alt <= 0) return "GND";
  if (alt < 18000) return `${Math.round(alt)}`;
  return `FL${Math.round(alt / 100)}`;
}

type Props = {
  aircraft: AircraftPosition[];
  flightInfo: Map<string, FlightInfoMap>;
};

/* ── Route lines (origin → plane → destination with smooth bend) ── */

function stripKPrefix(icao: string): string {
  return icao.startsWith("K") ? icao.slice(1) : icao;
}

/** Quadratic Bezier curve: p0 → control → p2, returns intermediate points */
function bezierCurve(
  p0: [number, number],
  control: [number, number],
  p2: [number, number],
  segments: number = 10,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * control[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * control[1] + t * t * p2[1],
    ]);
  }
  return pts;
}

/** Build path: origin → [smooth curve through plane] → destination */
function buildRoutePath(
  origin: [number, number],
  plane: [number, number],
  dest: [number, number],
): [number, number][] {
  // How far back/forward from plane to start the curve (fraction of each segment)
  const CURVE_RADIUS = 0.15;

  // Point on origin→plane segment, slightly before plane
  const before: [number, number] = [
    plane[0] + CURVE_RADIUS * (origin[0] - plane[0]),
    plane[1] + CURVE_RADIUS * (origin[1] - plane[1]),
  ];
  // Point on plane→dest segment, slightly after plane
  const after: [number, number] = [
    plane[0] + CURVE_RADIUS * (dest[0] - plane[0]),
    plane[1] + CURVE_RADIUS * (dest[1] - plane[1]),
  ];

  return [
    origin,
    before,
    ...bezierCurve(before, plane, after, 10),
    after,
    dest,
  ];
}

function FlightRoutes({ aircraft, flightInfo, fleetLookup }: { aircraft: AircraftPosition[]; flightInfo: Map<string, FlightInfoMap>; fleetLookup: Map<string, string> }) {
  // Build tail → ADS-B position lookup (always has lat/lon for displayed planes)
  const acPos = new Map<string, AircraftPosition>();
  for (const ac of aircraft) acPos.set(ac.tail, ac);

  const routes: { tail: string; positions: [number, number][] }[] = [];
  const seen = new Set<string>();

  for (const fi of flightInfo.values()) {
    if (seen.has(fi.tail)) continue;
    seen.add(fi.tail);
    if (!fi.origin_icao || !fi.destination_icao) continue;

    const origin = getAirportInfo(fi.origin_icao) ?? getAirportInfo(stripKPrefix(fi.origin_icao));
    const dest = getAirportInfo(fi.destination_icao) ?? getAirportInfo(stripKPrefix(fi.destination_icao));
    if (!origin || !dest) continue;

    // Use ADS-B position first, fall back to FA API position
    const ac = acPos.get(fi.tail);
    const planeLat = ac?.lat ?? fi.latitude;
    const planeLon = ac?.lon ?? fi.longitude;

    if (planeLat != null && planeLon != null) {
      routes.push({
        tail: fi.tail,
        positions: buildRoutePath(
          [origin.lat, origin.lon],
          [planeLat, planeLon],
          [dest.lat, dest.lon],
        ),
      });
    } else {
      // No plane position — draw straight origin → dest
      routes.push({
        tail: fi.tail,
        positions: [[origin.lat, origin.lon], [dest.lat, dest.lon]],
      });
    }
  }

  return (
    <>
      {routes.map(({ tail, positions }) => (
        <Polyline
          key={`route-${tail}`}
          positions={positions}
          pathOptions={{ color: getAcColor(fleetLookup, tail, false), weight: 2, opacity: 0.6 }}
        />
      ))}
    </>
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

function MapResizer() {
  const map = useMap();
  useEffect(() => {
    const handler = () => {
      const container = map.getContainer();
      if (document.fullscreenElement) {
        container.style.height = "100vh";
        container.style.width = "100vw";
      } else {
        container.style.height = "500px";
        container.style.width = "100%";
      }
      map.invalidateSize();
      setTimeout(() => map.invalidateSize(), 300);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, [map]);
  return null;
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
        <LegendPlane color="#ef4444" />
        <span className={text}>Challenger - In flight</span>
      </div>
      <div className="flex items-center gap-2">
        <LegendPlane color="#fca5a5" />
        <span className={text}>Challenger - Ground</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <LegendPlane color="#2563eb" />
        <span className={text}>Citation X - In flight</span>
      </div>
      <div className="flex items-center gap-2">
        <LegendPlane color="#93c5fd" />
        <span className={text}>Citation X - Ground</span>
      </div>
    </div>
  );
}

/* ── Toggle button ── */

function ToggleBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
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

/* ── Main map component ── */

export default function OpsMap({ aircraft, flightInfo }: Props) {
  const [darkMode, setDarkMode] = useState(true);
  const [showRadar, setShowRadar] = useState(false);
  const radarUrl = useRadarUrl(showRadar);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isFs, toggle: toggleFs } = useFullscreen(containerRef);

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
    <div ref={containerRef} className="relative">
      <div className="absolute top-2 right-2 z-[1000] flex gap-1.5">
        <ToggleBtn label={darkMode ? "Dark" : "Light"} active={darkMode} onClick={() => setDarkMode((v) => !v)} />
        <ToggleBtn label={showRadar ? "Radar ON" : "Radar"} active={showRadar} onClick={() => setShowRadar((v) => !v)} />
        <ToggleBtn label={isFs ? "Exit ⛶" : "⛶"} active={isFs} onClick={toggleFs} />
      </div>

      <MapLegend dark={darkMode} />

      <MapContainer
        center={[37.5, -96]}
        zoom={4}
        style={{ height: "500px", width: "100%" }}
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

        <FlightRoutes aircraft={aircraft} flightInfo={flightInfo} fleetLookup={fleetLookup} />

        {aircraft.map((ac) => {
          const fi = flightInfo.get(ac.tail);
          const color = getAcColor(fleetLookup, ac.tail, ac.on_ground);
          return (
            <Marker
              key={`ac-${ac.tail}`}
              position={[ac.lat, ac.lon]}
              icon={acDivIcon(ac.track, color, ac.on_ground)}
              zIndexOffset={ac.on_ground ? 1000 : 2000}
            >
              <Tooltip permanent direction="right" offset={[12, 0]} className="fa-data-tooltip">
                <div dangerouslySetInnerHTML={{ __html: acDataLabel(ac, fi, fleetLookup) }} />
              </Tooltip>
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
