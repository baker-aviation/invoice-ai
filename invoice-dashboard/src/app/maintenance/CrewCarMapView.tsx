"use client";

/**
 * CrewCarMapView — Leaflet map showing live crew car GPS positions from Samsara.
 * Rendered client-side only (no SSR).
 */

import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, Tooltip } from "react-leaflet";

export type CrewCarMarker = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  speed_mph: number | null;
};

function carDivIcon(): L.DivIcon {
  return L.divIcon({
    html: `<div style="
      background:#374151;
      color:white;
      border-radius:50%;
      width:34px;height:34px;
      display:flex;align-items:center;justify-content:center;
      font-size:16px;
      border:2.5px solid white;
      box-shadow:0 2px 6px rgba(0,0,0,0.35);
      user-select:none;
    ">🚗</div>`,
    className: "",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20],
  });
}

export default function CrewCarMapView({ cars }: { cars: CrewCarMarker[] }) {
  const valid = cars.filter((c) => c.lat !== 0 && c.lon !== 0);

  const center: [number, number] =
    valid.length > 0
      ? [
          valid.reduce((s, c) => s + c.lat, 0) / valid.length,
          valid.reduce((s, c) => s + c.lon, 0) / valid.length,
        ]
      : [37.5, -96];

  return (
    <MapContainer
      center={center}
      zoom={valid.length > 0 ? 5 : 4}
      style={{ height: "380px", width: "100%" }}
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {valid.map((car) => (
        <Marker
          key={car.id}
          position={[car.lat, car.lon]}
          icon={carDivIcon()}
          zIndexOffset={500}
        >
          <Tooltip permanent direction="top" offset={[0, -20]}>
            <span style={{ fontWeight: 700, fontSize: "11px" }}>{car.name}</span>
          </Tooltip>
          <Popup>
            <div className="text-sm space-y-1">
              <div className="font-bold">🚗 {car.name}</div>
              <div className="text-gray-500 text-xs">{car.address || "No address"}</div>
              {car.speed_mph !== null && (
                <div className="text-xs text-gray-600">{Math.round(car.speed_mph)} mph</div>
              )}
              <div className="text-xs text-gray-400 font-mono">{car.id}</div>
            </div>
          </Popup>
        </Marker>
      ))}

      {valid.length === 0 && (
        <Marker position={[37.5, -96]} icon={carDivIcon()}>
          <Popup>No crew cars with GPS data.</Popup>
        </Marker>
      )}
    </MapContainer>
  );
}
