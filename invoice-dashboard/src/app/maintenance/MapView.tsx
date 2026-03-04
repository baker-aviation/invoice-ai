"use client";

/**
 * MapView — rendered only on the client (no SSR).
 *
 * Van markers (🚐) + radius rings — centered on the van's LIVE Samsara GPS
 * position when available, falling back to the fixed zone home airport.
 *
 * Aircraft markers (✈) — colored to match their assigned van — show the
 * OVERNIGHT position (where the plane will be at end of selected date).
 *
 * Live ADS-B markers (✈) — real-time aircraft positions from airplanes.live.
 */

import L from "leaflet";
import { MapContainer, TileLayer, Circle, Marker, Popup, Tooltip } from "react-leaflet";
import type { VanAssignment } from "@/lib/maintenanceData";

// 3-hour driving radius: ~300 km at highway speed
const THREE_HOUR_RADIUS_M = 300_000;

type LivePos = { lat: number; lon: number };

export type AdsbAircraft = {
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

type Props = {
  vans: VanAssignment[];
  colors: string[];
  /** Zone ID → best available GPS position (live or last known). Empty map if unavailable. */
  liveVanPositions: Map<number, LivePos>;
  /** Zone ID → whether the position is a live reading (true) or last-known cache (false). */
  liveVanIsLive?: Map<number, boolean>;
  /** Live ADS-B aircraft positions from airplanes.live */
  adsbAircraft?: AdsbAircraft[];
};

function vanDivIcon(color: string, vanId: number): L.DivIcon {
  return L.divIcon({
    html: `<div style="
      background:${color};
      color:white;
      border-radius:50%;
      width:34px;height:34px;
      display:flex;align-items:center;justify-content:center;
      font-size:16px;
      border:2.5px solid white;
      box-shadow:0 2px 6px rgba(0,0,0,0.35);
      user-select:none;
    ">🚐</div>`,
    className: "",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20],
  });
}

function planeDivIcon(color: string): L.DivIcon {
  return L.divIcon({
    html: `<div style="
      color:${color};
      font-size:20px;
      line-height:1;
      filter:drop-shadow(0 1px 3px rgba(0,0,0,0.45));
      user-select:none;
      transform:rotate(-45deg);
    ">✈</div>`,
    className: "",
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14],
  });
}

function adsbDivIcon(track: number | null, onGround: boolean): L.DivIcon {
  const rotation = track != null ? track - 45 : -45; // ✈ emoji points NE, subtract 45
  const color = onGround ? "#6b7280" : "#2563eb";
  return L.divIcon({
    html: `<div style="
      color:${color};
      font-size:18px;
      line-height:1;
      filter:drop-shadow(0 1px 4px rgba(0,0,0,0.5));
      user-select:none;
      transform:rotate(${rotation}deg);
    ">✈</div>`,
    className: "",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -14],
  });
}

function fmtAlt(alt: number | null): string {
  if (alt == null) return "—";
  if (alt <= 0) return "GND";
  return `FL${Math.round(alt / 100)}`;
}

export default function MapView({ vans, colors, liveVanPositions, liveVanIsLive, adsbAircraft }: Props) {
  // Collect unique airport overnight positions → de-duplicate so one icon per airport per van
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

  // Build set of tails that have live ADS-B data (to dim/hide static overnight markers)
  const adsbTails = new Set((adsbAircraft ?? []).map((a) => a.tail));

  return (
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

      {/* 3-hour radius rings — centered on live GPS (or home base fallback) */}
      {vans.map((van) => {
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
              fillOpacity: 0.04,
              weight: 1.5,
              dashArray: "6 4",
            }}
          />
        );
      })}

      {/* Van markers (🚐) — live GPS when available */}
      {vans.map((van) => {
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
            <Tooltip permanent direction="top" offset={[0, -20]} className="van-label-tooltip">
              <span style={{ fontWeight: 700, fontSize: "11px" }}>Van {van.vanId}</span>
            </Tooltip>
            <Popup>
              <div className="text-sm space-y-1">
                <div className="font-bold" style={{ color }}>🚐 Van {van.vanId}</div>
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
                <div className="text-xs text-gray-500">3-hr radius ≈ 300 km shown</div>
                {van.aircraft.length > 0 && (
                  <>
                    <div className="pt-1 font-medium">Overnight ({van.aircraft.length}):</div>
                    {van.aircraft.map((ac) => (
                      <div key={ac.tail} className="font-mono text-xs">
                        ✈ {ac.tail} @ {ac.airport}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </Popup>
          </Marker>
        );
      })}

      {/* Aircraft markers (✈) — overnight positions, colored to van */}
      {/* Skip tails that have live ADS-B data (live position takes priority) */}
      {Array.from(aircraftByAirport.entries()).map(([key, info]) => {
        // Filter out tails with live ADS-B positions
        const staticTails = info.tails.filter((t) => !adsbTails.has(t));
        if (staticTails.length === 0) return null;
        return (
          <Marker
            key={`plane-${key}`}
            position={[info.lat, info.lon]}
            icon={planeDivIcon(info.color)}
          >
            <Popup>
              <div className="text-sm space-y-1">
                <div className="font-bold" style={{ color: info.color }}>
                  ✈ {staticTails.join(", ")}
                </div>
                <div className="text-gray-500 text-xs">
                  Overnight: {key.split("-")[0]} · Van {info.vanId} coverage
                </div>
                <div className="pt-1">
                  {staticTails.map((t) => (
                    <div key={t} className="font-mono text-xs">{t}</div>
                  ))}
                </div>
              </div>
            </Popup>
            {staticTails.length > 1 && (
              <Tooltip direction="top" offset={[0, -8]}>
                <span className="text-xs font-semibold">{staticTails.length} aircraft</span>
              </Tooltip>
            )}
          </Marker>
        );
      })}

      {/* Live ADS-B aircraft markers — real-time positions */}
      {(adsbAircraft ?? []).map((ac) => (
        <Marker
          key={`adsb-${ac.tail}`}
          position={[ac.lat, ac.lon]}
          icon={adsbDivIcon(ac.track, ac.on_ground)}
          zIndexOffset={2000}
        >
          <Tooltip permanent direction="top" offset={[0, -14]} className="van-label-tooltip">
            <span style={{ fontWeight: 700, fontSize: "10px", color: ac.on_ground ? "#6b7280" : "#2563eb" }}>
              {ac.tail}
            </span>
          </Tooltip>
          <Popup>
            <div className="text-sm space-y-1">
              <div className="font-bold text-blue-700">✈ {ac.tail}</div>
              {ac.flight && <div className="text-xs text-gray-500">Callsign: {ac.flight}</div>}
              {ac.description && <div className="text-xs text-gray-400">{ac.description}</div>}
              <div className="text-xs">
                {ac.on_ground ? (
                  <span className="text-gray-500 font-medium">On Ground</span>
                ) : (
                  <span className="text-blue-600 font-medium">
                    {ac.baro_rate != null && ac.baro_rate > 300 ? "Climbing" : ac.baro_rate != null && ac.baro_rate < -300 ? "Descending" : "Airborne"} · {fmtAlt(ac.alt_baro)}
                    {ac.baro_rate != null && Math.abs(ac.baro_rate) > 300 && (
                      <span className="text-gray-500"> ({ac.baro_rate > 0 ? "+" : ""}{ac.baro_rate} fpm)</span>
                    )}
                  </span>
                )}
              </div>
              {ac.gs != null && (
                <div className="text-xs text-gray-600">
                  GS: {Math.round(ac.gs)} kts · HDG: {ac.track != null ? `${Math.round(ac.track)}°` : "—"}
                </div>
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
      ))}
    </MapContainer>
  );
}
