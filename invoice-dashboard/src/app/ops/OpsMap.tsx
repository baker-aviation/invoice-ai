"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import L from "leaflet";
import { GestureHandling } from "leaflet-gesture-handling";
import "leaflet-gesture-handling/dist/leaflet-gesture-handling.css";
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline, CircleMarker, useMap } from "react-leaflet";

L.Map.addInitHook("addHandler", "gestureHandling", GestureHandling);
import type { AircraftPosition, FlightInfoMap } from "@/app/maintenance/MapView";
import { getAirportInfo } from "@/lib/airportCoords";
import type { FaaDelay, FaaAfp } from "@/app/api/ops/faa-delays/route";
import type { FlowControlLine } from "@/app/api/ops/flow-controls/route";

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

/** Map label — tail number + optional DIVERTED/HOLDING alert + optional FL badge */
function acDataLabel(ac: AircraftPosition, _fi: FlightInfoMap | undefined, fleetLookup: Map<string, string>, alertLabel?: string, dark?: boolean, flLabel?: string): string {
  const color = getAcColor(fleetLookup, ac.tail, ac.on_ground);
  const alertColor = alertLabel === "DIVERTING" ? "#d97706" : "#ef4444"; // amber for diverting, red for diverted/holding
  const alertHtml = alertLabel ? ` <span style="color:${alertColor};font-size:10px;font-weight:bold">${alertLabel}</span>` : "";
  const flHtml = flLabel ? ` <span style="color:#d97706;font-size:10px;font-weight:600;opacity:0.85">${flLabel}</span>` : "";
  const bg = dark
    ? "text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)"
    : "background:rgba(255,255,255,0.85);padding:1px 4px;border-radius:3px;border:1px solid rgba(0,0,0,0.12)";
  return `<div style="color:${color};font-family:ui-monospace,monospace;font-size:11px;font-weight:700;white-space:nowrap;${bg};line-height:1.3">${ac.tail}${alertHtml}${flHtml}</div>`;
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
    const enRoute = enRouteRef.current;
    if (enRoute.length === 0) { setTracks(new Map()); setFallbacks(new Map()); onHoldingDetected(new Set()); onLatestPositions(new Map()); return; }

    // Always evict tracks for tails that are no longer en-route (prevents ghost tracks)
    const enRouteTails = new Set(enRoute.map(fi => fi.tail));
    setTracks(prev => {
      if ([...prev.keys()].every(t => enRouteTails.has(t))) return prev;
      const next = new Map(prev);
      for (const t of next.keys()) if (!enRouteTails.has(t)) next.delete(t);
      return next;
    });
    setFallbacks(prev => {
      if ([...prev.keys()].every(t => enRouteTails.has(t))) return prev;
      const next = new Map(prev);
      for (const t of next.keys()) if (!enRouteTails.has(t)) next.delete(t);
      return next;
    });

    // Throttle: only refetch tracks from FA every 2.5 min
    if (Date.now() - lastFetchRef.current < 150_000 && tracks.size > 0) return;

    const controller = new AbortController();
    lastFetchRef.current = Date.now();
    (async () => {
      const newTracks = new Map<string, [number, number][]>();
      const newFallbacks = new Map<string, [number, number][]>();
      const holdingTails = new Set<string>();
      const latestPositions = new Map<string, [number, number]>();

      // Single batch request — FA rate-limits at 1 req/sec, so the server
      // fetches tracks sequentially with pauses instead of parallel calls
      const flightIds = enRoute.map(fi => fi.fa_flight_id!);
      try {
        const res = await fetch("/api/aircraft/tracks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flightIds }),
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        const trackMap: Record<string, TrackPoint[]> = data.tracks ?? {};

        for (const fi of enRoute) {
          const rawPositions = trackMap[fi.fa_flight_id!] ?? [];
          const positions: [number, number][] = rawPositions
            .filter((p: TrackPoint) => p.latitude && p.longitude)
            .map((p: TrackPoint) => [p.latitude, p.longitude] as [number, number]);
          if (positions.length > 1) {
            newTracks.set(fi.tail, positions);
            latestPositions.set(fi.tail, positions[positions.length - 1]);
          } else {
            const fb = buildFallbackRoute(fi, acByTail.get(fi.tail));
            if (fb) newFallbacks.set(fi.tail, fb);
          }
          if (detectHolding(rawPositions)) holdingTails.add(fi.tail);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.warn("[OpsMap] Batch track fetch failed:", err);
          // Build fallback lines for all
          for (const fi of enRoute) {
            const fb = buildFallbackRoute(fi, acByTail.get(fi.tail));
            if (fb) newFallbacks.set(fi.tail, fb);
          }
        }
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
    const jitter = () => 240_000 + Math.random() * 30_000;
    let tid: ReturnType<typeof setTimeout>;
    const tick = () => { load(); tid = setTimeout(tick, jitter()); };
    tid = setTimeout(tick, jitter());
    return () => { cancelled = true; clearTimeout(tid); };
  }, [enabled]);
  return vans;
}

/* ── FAA Delay layer ── */

type DelayAirport = {
  code: string;
  lat: number;
  lon: number;
  name: string;
  delays: FaaDelay[];
};

const DELAY_COLORS: Record<FaaDelay["type"], string> = {
  ground_stop: "#dc2626",      // red
  closure: "#7c3aed",          // purple
  ground_delay: "#f59e0b",     // amber
  arrival_departure: "#f97316", // orange
};

const DELAY_LABELS: Record<FaaDelay["type"], string> = {
  ground_stop: "Ground Stop",
  closure: "Closed",
  ground_delay: "GDP",
  arrival_departure: "Delay",
};

/** Severity rank — higher = worse */
function delaySeverity(type: FaaDelay["type"]): number {
  switch (type) {
    case "closure": return 4;
    case "ground_stop": return 3;
    case "ground_delay": return 2;
    case "arrival_departure": return 1;
    default: return 0;
  }
}

function worstDelay(delays: FaaDelay[]): FaaDelay["type"] {
  let worst: FaaDelay["type"] = "arrival_departure";
  for (const d of delays) {
    if (delaySeverity(d.type) > delaySeverity(worst)) worst = d.type;
  }
  return worst;
}

function useFaaDelays(enabled: boolean): { airports: DelayAirport[]; updated: string; afps: FaaAfp[] } {
  const [airports, setAirports] = useState<DelayAirport[]>([]);
  const [updated, setUpdated] = useState("");
  const [afps, setAfps] = useState<FaaAfp[]>([]);

  useEffect(() => {
    if (!enabled) { setAirports([]); setUpdated(""); setAfps([]); return; }
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/ops/faa-delays", { cache: "no-store" });
        const data = await res.json();
        if (cancelled || !data.ok) return;
        setUpdated(data.updated ?? "");
        setAfps(data.afps ?? []);

        // Group delays by airport, look up coordinates
        const byAirport = new Map<string, FaaDelay[]>();
        for (const d of data.delays as FaaDelay[]) {
          const list = byAirport.get(d.airport) ?? [];
          list.push(d);
          byAirport.set(d.airport, list);
        }

        const result: DelayAirport[] = [];
        for (const [code, delays] of byAirport) {
          // Try IATA code first, then ICAO with K prefix
          const info = getAirportInfo(code) ?? getAirportInfo(`K${code}`);
          if (info) {
            result.push({ code, lat: info.lat, lon: info.lon, name: info.name, delays });
          }
        }
        setAirports(result);
      } catch { /* ignore */ }
    }

    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [enabled]);

  return { airports, updated, afps };
}

/* ── Flow Controls (reroutes / CTOPs / AFPs from SWIM) ── */

const FLOW_COLORS = [
  "#f97316", // orange
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#eab308", // yellow
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f43f5e", // rose
  "#84cc16", // lime
];

function useFlowControls(enabled: boolean): FlowControlLine[] {
  const [lines, setLines] = useState<FlowControlLine[]>([]);

  useEffect(() => {
    if (!enabled) { setLines([]); return; }
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/ops/flow-controls", { cache: "no-store" });
        const data = await res.json();
        if (cancelled || !data.ok) return;
        setLines(data.lines ?? []);
      } catch { /* ignore */ }
    }

    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [enabled]);

  return lines;
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

function EnableGestureHandling() {
  const map = useMap();
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (map as any).gestureHandling?.enable();
  }, [map]);
  return null;
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

function LegendDot({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14">
      <circle cx="7" cy="7" r="5" fill={color} fillOpacity="0.3" stroke={color} strokeWidth="2" />
    </svg>
  );
}

function LegendLine({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 14 6" width="14" height="6">
      <line x1="0" y1="3" x2="14" y2="3" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function MapLegend({ dark, showDelays, showFlows, flowCount }: { dark: boolean; showDelays: boolean; showFlows: boolean; flowCount: number }) {
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
      {showDelays && (
        <>
          <div className={`font-semibold ${heading} text-[10px] uppercase tracking-wider mt-2 mb-1`}>FAA Delays</div>
          <div className="flex items-center gap-2">
            <LegendDot color="#dc2626" />
            <span className={text}>Ground Stop</span>
          </div>
          <div className="flex items-center gap-2">
            <LegendDot color="#7c3aed" />
            <span className={text}>Closed</span>
          </div>
          <div className="flex items-center gap-2">
            <LegendDot color="#f59e0b" />
            <span className={text}>Ground Delay</span>
          </div>
          <div className="flex items-center gap-2">
            <LegendDot color="#f97316" />
            <span className={text}>Arr/Dep Delay</span>
          </div>
          <div className="flex items-center gap-2">
            <LegendLine color="#e11d48" />
            <span className={text}>AFP / FCA</span>
          </div>
        </>
      )}
      {showFlows && flowCount > 0 && (
        <>
          <div className={`font-semibold ${heading} text-[10px] uppercase tracking-wider mt-2 mb-1`}>Flow Controls</div>
          <div className="flex items-center gap-2">
            <LegendLine color="#f97316" />
            <span className={text}>CTOP / AFP</span>
          </div>
        </>
      )}
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
  const [showDelays, setShowDelays] = useState(true);
  const [showFlows, setShowFlows] = useState(false);
  const [holdingTails, setHoldingTails] = useState<Set<string>>(new Set());
  const [trackPositions, setTrackPositions] = useState<Map<string, [number, number]>>(new Map());
  const radarUrl = useRadarUrl(showRadar);
  const vanPositions = useVanPositions(showVans);
  const { airports: delayAirports, updated: delaysUpdated, afps } = useFaaDelays(showDelays);
  const flowLines = useFlowControls(showFlows);
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

  /* ── FL470 level-off alert: show FL when level below FL470 for 20+ min ── */
  const levelBelowTimersRef = useRef<Map<string, number>>(new Map());
  const levelBelowFL470 = useMemo(() => {
    const LEVEL_FPM = 300;          // |baro_rate| below this = level flight
    const FL470_FT = 47000;
    const DELAY_MS = 20 * 60_000;   // 20 minutes
    const now = Date.now();
    const result = new Map<string, string>();
    const activeTails = new Set<string>();

    for (const ac of aircraft) {
      if (ac.on_ground || ac.alt_baro == null || ac.baro_rate == null) continue;
      const isLevel = Math.abs(ac.baro_rate) < LEVEL_FPM;
      if (isLevel && ac.alt_baro < FL470_FT) {
        activeTails.add(ac.tail);
        if (!levelBelowTimersRef.current.has(ac.tail)) {
          levelBelowTimersRef.current.set(ac.tail, now);
        }
        if (now - levelBelowTimersRef.current.get(ac.tail)! >= DELAY_MS) {
          result.set(ac.tail, fmtAlt(ac.alt_baro));
        }
      }
    }
    // Clear tails no longer level below FL470
    for (const tail of levelBelowTimersRef.current.keys()) {
      if (!activeTails.has(tail)) levelBelowTimersRef.current.delete(tail);
    }
    return result;
  }, [aircraft]);

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
        <ToggleBtn label={showDelays ? "FAA Delays ON" : "FAA Delays"} active={showDelays} onClick={() => setShowDelays((v) => !v)} />
        <ToggleBtn label={showFlows ? "Flow Ctrl ON" : "Flow Ctrl"} active={showFlows} onClick={() => setShowFlows((v) => !v)} />
        <ToggleBtn label={isFs ? "Exit ⛶" : "⛶"} active={isFs} onClick={toggleFs} />
      </div>

      <MapLegend dark={darkMode} showDelays={showDelays} showFlows={showFlows} flowCount={flowLines.length} />

      <MapContainer
        center={[37.5, -96]}
        zoom={4}
        style={{ height: "500px", width: "100%" }}
        scrollWheelZoom={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={LIGHT_TILES}
        />
        <DarkModeFilter enabled={darkMode} />
        <EnableGestureHandling />
        <MapResizer />

        {radarUrl && (
          <TileLayer key={`radar-${radarUrl}`} url={radarUrl} opacity={0.65} zIndex={300} />
        )}

        <FlightTracks aircraft={aircraft} flightInfo={flightInfo} fleetLookup={fleetLookup} onHoldingDetected={handleHoldingDetected} onLatestPositions={setTrackPositions} />

        {aircraft.map((ac) => {
          const fi = flightInfo.get(ac.tail);
          const color = getAcColor(fleetLookup, ac.tail, ac.on_ground);
          // Show DIVERTED while in-air OR for 30 min after landing at diversion airport.
          // After 30 min the badge clears, preventing bleed into later legs.
          const isDiverted = fi?.diverted === true && (
            fi.status === "Diverted" ||
            (fi.actual_arrival != null && Date.now() - new Date(fi.actual_arrival).getTime() < 30 * 60_000)
          );
          const isHolding = holdingTails.has(ac.tail);
          const hasAlert = isDiverted || isHolding;
          const alertLabel = isDiverted ? "DIVERTED" : isHolding ? "HOLDING" : undefined;
          // Prefer track endpoint (real-time FA) over DB position (3-min cron lag)
          const trackPos = trackPositions.get(ac.tail);
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
                <div dangerouslySetInnerHTML={{ __html: acDataLabel(ac, fi, fleetLookup, alertLabel, darkMode, levelBelowFL470.get(ac.tail)) }} />
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
        {/* FAA Delay markers */}
        {showDelays && delayAirports.map((ap) => {
          const worst = worstDelay(ap.delays);
          const color = DELAY_COLORS[worst];
          const label = DELAY_LABELS[worst];
          const isSevere = worst === "ground_stop" || worst === "closure";
          return (
            <CircleMarker
              key={`delay-${ap.code}`}
              center={[ap.lat, ap.lon]}
              radius={isSevere ? 12 : 9}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: isSevere ? 0.35 : 0.25,
                weight: isSevere ? 2.5 : 2,
              }}
            >
              <Tooltip permanent direction="top" offset={[0, -10]} className="fa-data-tooltip">
                <div style={{
                  color,
                  fontFamily: "ui-monospace,monospace",
                  fontSize: "10px",
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  textShadow: darkMode
                    ? "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)"
                    : "0 1px 2px rgba(255,255,255,0.9)",
                }}>
                  {ap.code} <span style={{ fontSize: "9px", opacity: 0.85 }}>{label}</span>
                </div>
              </Tooltip>
              <Popup>
                <div className="text-sm space-y-1.5 min-w-[180px]">
                  <div className="font-bold" style={{ color }}>{ap.code} — {ap.name}</div>
                  {ap.delays.map((d, i) => (
                    <div key={i} className="text-xs">
                      <span className="font-semibold" style={{ color: DELAY_COLORS[d.type] }}>
                        {DELAY_LABELS[d.type]}
                      </span>
                      <div className="text-gray-600">{d.detail}</div>
                      {d.reason && d.reason !== "other" && (
                        <div className="text-gray-400 text-[10px]">{d.reason}</div>
                      )}
                    </div>
                  ))}
                  {delaysUpdated && (
                    <div className="text-[10px] text-gray-400 pt-1 border-t border-gray-200">
                      FAA updated: {delaysUpdated}
                    </div>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          );
        })}

        {/* AFP / FCA lines */}
        {showDelays && afps.map((afp) => {
          const afpColor = "#e11d48"; // rose-600 — distinct from reroutes
          if (afp.line && afp.line.length >= 2) {
            return (
              <Polyline
                key={`afp-${afp.name}`}
                positions={afp.line}
                pathOptions={{ color: afpColor, weight: 5, opacity: 0.8 }}
              >
                <Tooltip permanent direction="center" className="fa-data-tooltip">
                  <div style={{
                    color: afpColor,
                    fontFamily: "ui-monospace,monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    textShadow: darkMode
                      ? "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)"
                      : "0 1px 2px rgba(255,255,255,0.9)",
                  }}>
                    {afp.name}
                  </div>
                </Tooltip>
                <Popup>
                  <div className="text-sm space-y-1 min-w-[180px]">
                    <div className="font-bold" style={{ color: afpColor }}>AFP: {afp.name}</div>
                    <div className="text-xs"><span className="font-semibold">Avg delay:</span> {afp.avg}</div>
                    <div className="text-xs"><span className="font-semibold">Reason:</span> {afp.reason}</div>
                    <div className="text-xs"><span className="font-semibold">Time:</span> {afp.afpStart}Z – {afp.afpEnd}Z</div>
                    <div className="text-xs"><span className="font-semibold">Altitudes:</span> FL{afp.floor} – FL{afp.ceiling}</div>
                  </div>
                </Popup>
              </Polyline>
            );
          }
          if (afp.circle) {
            // Convert radius from NM to meters (1 NM = 1852m)
            const radiusM = afp.circle.radiusNm * 1852;
            return (
              <CircleMarker
                key={`afp-${afp.name}`}
                center={[afp.circle.lat, afp.circle.lon]}
                radius={14}
                pathOptions={{ color: afpColor, fillColor: afpColor, fillOpacity: 0.3, weight: 2.5 }}
              >
                <Tooltip permanent direction="top" offset={[0, -12]} className="fa-data-tooltip">
                  <div style={{
                    color: afpColor,
                    fontFamily: "ui-monospace,monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    textShadow: darkMode
                      ? "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)"
                      : "0 1px 2px rgba(255,255,255,0.9)",
                  }}>
                    {afp.name} <span style={{ fontSize: "9px", opacity: 0.85 }}>AFP</span>
                  </div>
                </Tooltip>
                <Popup>
                  <div className="text-sm space-y-1 min-w-[180px]">
                    <div className="font-bold" style={{ color: afpColor }}>AFP: {afp.name}</div>
                    <div className="text-xs"><span className="font-semibold">Avg delay:</span> {afp.avg}</div>
                    <div className="text-xs"><span className="font-semibold">Reason:</span> {afp.reason}</div>
                    <div className="text-xs"><span className="font-semibold">Time:</span> {afp.afpStart}Z – {afp.afpEnd}Z</div>
                    <div className="text-xs"><span className="font-semibold">Radius:</span> {afp.circle.radiusNm} NM</div>
                    <div className="text-xs"><span className="font-semibold">Altitudes:</span> FL{afp.floor} – FL{afp.ceiling}</div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          }
          return null;
        })}

        {/* Flow Control reroute lines */}
        {showFlows && flowLines.map((line, idx) => {
          const color = FLOW_COLORS[idx % FLOW_COLORS.length];
          // Clean up reroute name for display
          const displayName = line.name
            .replace(/^rr\.\w+\.\w+\.\d+$/, line.subject)
            .replace(/_/g, " ");
          const timeRange = [
            line.effective_at ? new Date(line.effective_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "UTC" }) + "Z" : null,
            line.expires_at ? new Date(line.expires_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "UTC" }) + "Z" : null,
          ].filter(Boolean).join(" – ");
          return (
            <Polyline
              key={`flow-${line.id}`}
              positions={line.waypoints}
              pathOptions={{ color, weight: 4, opacity: 0.75 }}
            >
              <Tooltip
                permanent
                direction="center"
                className="fa-data-tooltip"
              >
                <div style={{
                  color,
                  fontFamily: "ui-monospace,monospace",
                  fontSize: "9px",
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  textShadow: darkMode
                    ? "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)"
                    : "0 1px 2px rgba(255,255,255,0.9)",
                }}>
                  {line.tmiId ?? line.event_type}
                </div>
              </Tooltip>
              <Popup>
                <div className="text-sm space-y-1.5 min-w-[220px]">
                  <div className="font-bold" style={{ color }}>{displayName}</div>
                  {line.tmiId && <div className="text-xs font-mono text-gray-500">{line.tmiId}</div>}
                  {line.fcaName && (
                    <div className="text-xs">
                      <span className="font-semibold text-gray-700">FCA:</span> {line.fcaName}
                    </div>
                  )}
                  {timeRange && (
                    <div className="text-xs">
                      <span className="font-semibold text-gray-700">Time:</span> {timeRange}
                    </div>
                  )}
                  {line.origins.length > 0 && (
                    <div className="text-xs">
                      <span className="font-semibold text-gray-700">From:</span>{" "}
                      {line.origins.join(", ")}
                    </div>
                  )}
                  {line.destinations.length > 0 && (
                    <div className="text-xs">
                      <span className="font-semibold text-gray-700">To:</span>{" "}
                      {line.destinations.join(", ")}
                    </div>
                  )}
                  <div className="text-[10px] text-gray-400 pt-1 border-t border-gray-200">
                    Route: {line.waypointNames.join(" → ")}
                  </div>
                </div>
              </Popup>
            </Polyline>
          );
        })}
      </MapContainer>
      <div className="text-[10px] text-gray-400 text-center mt-1">
        Use Ctrl + scroll to zoom the map &middot; Click and drag to pan
      </div>
    </div>
  );
}
