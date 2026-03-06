"use client";

import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, Tooltip } from "react-leaflet";
import type { AdsbAircraft, FlightInfoMap } from "@/app/maintenance/MapView";

function adsbDivIcon(track: number | null, onGround: boolean): L.DivIcon {
  const rotation = track != null ? track - 45 : -45;
  const color = onGround ? "#6b7280" : "#2563eb";
  return L.divIcon({
    html: `<div style="
      color:${color};
      font-size:20px;
      line-height:1;
      filter:drop-shadow(0 1px 4px rgba(0,0,0,0.5));
      user-select:none;
      transform:rotate(${rotation}deg);
    ">✈</div>`,
    className: "",
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14],
  });
}

function fmtAlt(alt: number | null): string {
  if (alt == null) return "—";
  if (alt <= 0) return "GND";
  return `FL${Math.round(alt / 100)}`;
}

function fmtEta(iso: string | null | undefined): string {
  if (!iso) return "—";
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
  adsbAircraft: AdsbAircraft[];
  flightInfo: Map<string, FlightInfoMap>;
};

export default function OpsMap({ adsbAircraft, flightInfo }: Props) {
  return (
    <MapContainer
      center={[37.5, -96]}
      zoom={4}
      style={{ height: "500px", width: "100%" }}
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* ADS-B aircraft (primary source) */}
      {adsbAircraft.map((ac) => {
        const fi = flightInfo.get(ac.tail);
        return (
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
  );
}
