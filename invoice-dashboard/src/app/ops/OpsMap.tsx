"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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

function acDivIcon(track: number | null, color: string, onGround: boolean, alert?: boolean): L.DivIcon {
  const rotation = track != null ? track : 0;
  const size = onGround ? 18 : 22;
  const ringSize = size + 12;
  const ringHalf = ringSize / 2;
  const planeOffset = (ringSize - size) / 2;
  const ring = alert
    ? `<div style="position:absolute;top:0;left:0;width:${ringSize}px;height:${ringSize}px;border:2px solid #ef4444;border-radius:50%;animation:ops-pulse 1.5s ease-in-out infinite"></div>`
    : "";
  const svg = `<div style="position:relative;width:${ringSize}px;height:${ringSize}px">${ring}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="${color}" style="position:absolute;top:${planeOffset}px;left:${planeOffset}px;transform:rotate(${rotation}deg);filter:drop-shadow(0 1px 3px rgba(0,0,0,0.7))"><path d="${PLANE_PATH}"/></svg></div>`;
  return L.divIcon({ html: svg, className: "", iconSize: [ringSize, ringSize], iconAnchor: [ringHalf, ringHalf], popupAnchor: [0, -ringHalf] });
}

/** Map label — tail number + optional DIVERTED/HOLDING alert */
function acDataLabel(ac: AircraftPosition, _fi: FlightInfoMap | undefined, fleetLookup: Map<string, string>, alertLabel?: string, dark?: boolean): string {
  const color = getAcColor(fleetLookup, ac.tail, ac.on_ground);
  const alertHtml = alertLabel ? ` <span style="color:#ef4444;font-size:10px;font-weight:bold">${alertLabel}</span>` : "";
  const bg = dark
    ? "text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)"
    : "background:rgba(255,255,255,0.85);padding:1px 4px;border-radius:3px;border:1px solid rgba(0,0,0,0.12)";
  return `<div style="color:${color};font-family:ui-monospace,monospace;font-size:11px;font-weight:700;white-space:nowrap;${bg};line-height:1.3">${ac.tail}${alertHtml}</div>`;
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
  onHoldingDetected?: (tails: Set<string>) => void;
};

/* ── Holding pattern detection (client-side from track headings) ── */

/** Returns true if the last ~8 track headings show cumulative turning >= 300° */
function detectHolding(positions: { heading?: number | null }[]): boolean {
  const recent = positions.slice(-8);
  if (recent.length < 4) return false;
  let cumulative = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1].heading;
    const curr = recent[i].heading;
    if (prev == null || curr == null) continue;
    let delta = curr - prev;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    cumulative += Math.abs(delta);
  }
  return cumulative >= 300;
}

/* ── FlightTracks — actual FA track polylines for airborne aircraft ── */

type TrackPoint = { latitude: number; longitude: number; heading?: number | null };

/** Strip leading "K" from US ICAO codes (e.g. KTEB→TEB) for airport lookup */
function stripK(icao: string | null | undefined): string | null {
  if (!icao) return null;
  if (icao.length === 4 && icao.startsWith("K")) return icao.slice(1);
  return icao;
}

/** Build a fallback dashed route: origin → plane → destination */
function buildFallbackRoute(
  fi: FlightInfoMap,
  ac: AircraftPosition | undefined,
): [number, number][] | null {
  const points: [number, number][] = [];
  // Origin
  const orig = getAirportInfo(fi.origin_icao ?? "") ?? getAirportInfo(stripK(fi.origin_icao) ?? "");
  if (orig) points.push([orig.lat, orig.lon]);
  // Current position (from ADSB)
  if (ac && ac.lat && ac.lon) points.push([ac.lat, ac.lon]);
  // Destination
  const dest = getAirportInfo(fi.destination_icao ?? "") ?? getAirportInfo(stripK(fi.destination_icao) ?? "");
  if (dest) points.push([dest.lat, dest.lon]);
  return points.length >= 2 ? points : null;
}

function FlightTracks({
  aircraft,
  flightInfo,
  fleetLookup,
  onHoldingDetected,
  onLatestPositions,
}: {
  aircraft: AircraftPosition[];
  flightInfo: Map<string, FlightInfoMap>;
  fleetLookup: Map<string, string>;
  onHoldingDetected: (tails: Set<string>) => void;
  onLatestPositions: (positions: Map<string, [number, number]>) => void;
}) {
  const [tracks, setTracks] = useState<Map<string, [number, number][]>>(new Map());
  const [fallbacks, setFallbacks] = useState<Map<string, [number, number][]>>(new Map());
  const lastFetchRef = useRef(0);

  // Build set of airborne tails + quick lookup
  const airborneSet = useMemo(() => {
    const s = new Set<string>();
    for (const ac of aircraft) {
      if (!ac.on_ground) s.add(ac.tail);
    }
    return s;
  }, [aircraft]);

  const acByTail = useMemo(() => {
    const m = new Map<string, AircraftPosition>();
    for (const ac of aircraft) m.set(ac.tail, ac);
    return m;
  }, [aircraft]);

  // Stable list of en-route flights — only update when the set of airborne flight IDs changes
  const enRouteRef = useRef<FlightInfoMap[]>([]);
  const [enRouteKey, setEnRouteKey] = useState("");
  useEffect(() => {
    const enRoute: FlightInfoMap[] = [];
    for (const tail of airborneSet) {
      const fi = flightInfo.get(tail);
      if (fi && fi.fa_flight_id) enRoute.push(fi);
    }
    const key = enRoute.map(f => f.fa_flight_id).sort().join(",");
    if (key !== enRouteKey) {
      enRouteRef.current = enRoute;
      setEnRouteKey(key);
    }
  }, [flightInfo, airborneSet, enRouteKey]);

  useEffect(() => {
    // Throttle: only refetch tracks every 2.5 min
    if (Date.now() - lastFetchRef.current < 150_000 && tracks.size > 0) return;

    const enRoute = enRouteRef.current;
    if (enRoute.length === 0) { setTracks(new Map()); setFallbacks(new Map()); onHoldingDetected(new Set()); onLatestPositions(new Map()); return; }

    const controller = new AbortController();
    lastFetchRef.current = Date.now();
    (async () => {
      const newTracks = new Map<string, [number, number][]>();
      const newFallbacks = new Map<string, [number, number][]>();
      const holdingTails = new Set<string>();
      const latestPositions = new Map<string, [number, number]>();

      // Fetch all tracks in parallel to avoid sequential abort issues
      const results = await Promise.allSettled(
        enRoute.map(async (fi) => {
          const res = await fetch(`/api/aircraft/track/${encodeURIComponent(fi.fa_flight_id!)}`, {
            signal: controller.signal, cache: "no-store",
          });
          if (!res.ok) return { fi, rawPositions: [] as TrackPoint[] };
          const data = await res.json();
          return { fi, rawPositions: (data.positions ?? []) as TrackPoint[] };
        })
      );

      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const { fi, rawPositions } = result.value;
        const positions: [number, number][] = rawPositions
          .filter((p) => p.latitude && p.longitude)
          .map((p) => [p.latitude, p.longitude] as [number, number]);
        if (positions.length > 1) {
          newTracks.set(fi.tail, positions);
          latestPositions.set(fi.tail, positions[positions.length - 1]);
        } else {
          const fb = buildFallbackRoute(fi, acByTail.get(fi.tail));
          if (fb) newFallbacks.set(fi.tail, fb);
        }
        if (detectHolding(rawPositions)) holdingTails.add(fi.tail);
      }

      if (!controller.signal.aborted) {
        setTracks(newTracks);
        setFallbacks(newFallbacks);
        onHoldingDetected(holdingTails);
        onLatestPositions(latestPositions);
      }
    })();
    return () => controller.abort();
  }, [enRouteKey]);

  return (
    <>
      {/* Real FA track polylines */}
      {Array.from(tracks.entries()).map(([tail, positions]) => (
        <Polyline
          key={`track-${tail}`}
          positions={positions}
          pathOptions={{ color: getAcColor(fleetLookup, tail, false), weight: 2, opacity: 0.6 }}
        />
      ))}
      {/* Fallback dashed route lines for flights without track data */}
      {Array.from(fallbacks.entries()).map(([tail, positions]) => (
        <Polyline
          key={`fallback-${tail}`}
          positions={positions}
          pathOptions={{ color: getAcColor(fleetLookup, tail, false), weight: 1.5, opacity: 0.4, dashArray: "8 6" }}
        />
      ))}
    </>
  );
}

/* ── AOG Van support ── */

const VAN_COLOR = "#22c55e";

type VanPos = { id: string; name: string; lat: number; lon: number };

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

function isAogVehicle(name: string): boolean {
  const u = (name || "").toUpperCase();
  if (u.includes("CLEANING")) return false;
  return u.includes("VAN") || u.includes("AOG") || u.includes(" OG") || u.includes("TRAN");
}

function useVanPositions(enabled: boolean): VanPos[] {
  const [vans, setVans] = useState<VanPos[]>([]);
  useEffect(() => {
    if (!enabled) { setVans([]); return; }
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/vans", { cache: "no-store" });
        const data = await res.json();
        if (cancelled || !data.ok) return;
        const aog = (data.vans ?? [])
          .filter((v: { name: string; lat: number | null; lon: number | null }) =>
            isAogVehicle(v.name) && v.lat != null && v.lon != null
          )
          .map((v: { id: string; name: string; lat: number; lon: number }) => ({
            id: v.id, name: v.name, lat: v.lat, lon: v.lon,
          }));
        setVans(aog);
      } catch { /* ignore */ }
    }
    load();
    const interval = setInterval(load, 240_000); // refresh every 4 min
    return () => { cancelled = true; clearInterval(interval); };
  }, [enabled]);
  return vans;
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

export default function OpsMap({ aircraft, flightInfo, onHoldingDetected: onHoldingDetectedProp }: Props) {
  const [darkMode, setDarkMode] = useState(true);
  const [showRadar, setShowRadar] = useState(false);
  const [showVans, setShowVans] = useState(false);
  const [holdingTails, setHoldingTails] = useState<Set<string>>(new Set());
  const [trackLatest, setTrackLatest] = useState<Map<string, [number, number]>>(new Map());
  const radarUrl = useRadarUrl(showRadar);
  const vanPositions = useVanPositions(showVans);
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

  const handleHoldingDetected = useCallback((tails: Set<string>) => {
    setHoldingTails(tails);
    onHoldingDetectedProp?.(tails);
  }, [onHoldingDetectedProp]);

  return (
    <div ref={containerRef} className="relative">
      {/* CSS animation for pulsing alert ring */}
      <style>{`
        @keyframes ops-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.15); }
        }
      `}</style>

      <div className="absolute top-2 right-2 z-[1000] flex gap-1.5">
        <ToggleBtn label={darkMode ? "Dark" : "Light"} active={darkMode} onClick={() => setDarkMode((v) => !v)} />
        <ToggleBtn label={showRadar ? "Radar ON" : "Radar"} active={showRadar} onClick={() => setShowRadar((v) => !v)} />
        <ToggleBtn label={showVans ? "Vans ON" : "AOG Vans"} active={showVans} onClick={() => setShowVans((v) => !v)} />
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

        <FlightTracks aircraft={aircraft} flightInfo={flightInfo} fleetLookup={fleetLookup} onHoldingDetected={handleHoldingDetected} onLatestPositions={setTrackLatest} />

        {aircraft.map((ac) => {
          const fi = flightInfo.get(ac.tail);
          const color = getAcColor(fleetLookup, ac.tail, ac.on_ground);
          const isDiverted = fi?.diverted === true;
          const divertedStale = isDiverted &&
            fi.actual_arrival != null &&
            Date.now() - new Date(fi.actual_arrival).getTime() > 5 * 3600_000;
          const isHolding = holdingTails.has(ac.tail);
          const showMapAlert = (isDiverted && !divertedStale) || isHolding;
          const hasAlert = showMapAlert;
          const alertLabel = (isDiverted && !divertedStale) ? "DIVERTED" : isHolding ? "HOLDING" : undefined;
          // Use latest track position if available (more recent than ADSB poll)
          const trackPos = trackLatest.get(ac.tail);
          const markerLat = trackPos ? trackPos[0] : ac.lat;
          const markerLon = trackPos ? trackPos[1] : ac.lon;
          return (
            <Marker
              key={`ac-${ac.tail}`}
              position={[markerLat, markerLon]}
              icon={acDivIcon(ac.track, color, ac.on_ground, hasAlert)}
              zIndexOffset={ac.on_ground ? 1000 : 2000}
            >
              <Tooltip permanent direction="right" offset={[12, 0]} className="fa-data-tooltip">
                <div dangerouslySetInnerHTML={{ __html: acDataLabel(ac, fi, fleetLookup, alertLabel, darkMode) }} />
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
                  {isDiverted && <div className="text-xs font-semibold text-red-600">DIVERTED</div>}
                  {isHolding && <div className="text-xs font-semibold text-red-600">HOLDING PATTERN</div>}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* AOG Van markers */}
        {showVans && vanPositions.map((v) => (
          <Marker key={`van-${v.id}`} position={[v.lat, v.lon]} icon={vanDivIcon()} zIndexOffset={500}>
            <Tooltip permanent direction="top" offset={[0, -14]} className="fa-data-tooltip">
              <div style={{ color: VAN_COLOR, fontFamily: "ui-monospace,monospace", fontSize: "10px", fontWeight: 700, whiteSpace: "nowrap", textShadow: "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)" }}>
                {v.name}
              </div>
            </Tooltip>
            <Popup>
              <div className="text-sm space-y-1">
                <div className="font-bold" style={{ color: VAN_COLOR }}>{v.name}</div>
                <div className="text-xs text-gray-500">{v.lat.toFixed(4)}, {v.lon.toFixed(4)}</div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
