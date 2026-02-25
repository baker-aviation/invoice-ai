"use client";

/**
 * MapView — rendered only on the client (no SSR).
 * Shows van home bases as colored circles, aircraft markers, and coverage radii.
 */

import { useEffect } from "react";
import { MapContainer, TileLayer, CircleMarker, Circle, Popup, Tooltip } from "react-leaflet";
import type { VanAssignment } from "@/lib/maintenanceData";

type Props = {
  vans: VanAssignment[];
  colors: string[];
};

export default function MapView({ vans, colors }: Props) {
  // Fix Leaflet default marker icon path in Next.js
  useEffect(() => {
    // Leaflet loads icon PNGs dynamically; suppress that in SSR-disabled context
  }, []);

  const allAircraft = vans.flatMap((v) => v.aircraft);

  // Collect unique airport positions for clean rendering
  const airportMap = new Map<string, { lat: number; lon: number; tails: string[]; vanId: number; color: string }>();
  for (const van of vans) {
    const color = colors[(van.vanId - 1) % colors.length];
    for (const ac of van.aircraft) {
      const key = ac.airport;
      if (!airportMap.has(key)) {
        airportMap.set(key, { lat: ac.lat, lon: ac.lon, tails: [], vanId: van.vanId, color });
      }
      airportMap.get(key)!.tails.push(ac.tail);
    }
  }

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

      {/* Coverage radius circles (light fill) */}
      {vans.map((van) => {
        const color = colors[(van.vanId - 1) % colors.length];
        return (
          <Circle
            key={`radius-${van.vanId}`}
            center={[van.lat, van.lon]}
            radius={van.coverageRadius * 1000} // metres
            pathOptions={{
              color,
              fillColor: color,
              fillOpacity: 0.06,
              weight: 1.5,
              dashArray: "6 4",
            }}
          />
        );
      })}

      {/* Van home base markers (larger circles) */}
      {vans.map((van) => {
        const color = colors[(van.vanId - 1) % colors.length];
        return (
          <CircleMarker
            key={`van-${van.vanId}`}
            center={[van.lat, van.lon]}
            radius={14}
            pathOptions={{ color: "white", fillColor: color, fillOpacity: 1, weight: 2 }}
          >
            <Tooltip permanent direction="center" className="van-label-tooltip" offset={[0, 0]}>
              <span style={{ color: "white", fontWeight: 700, fontSize: "11px" }}>V{van.vanId}</span>
            </Tooltip>
            <Popup>
              <div className="text-sm space-y-1">
                <div className="font-bold">Van {van.vanId}</div>
                <div className="text-gray-500">{van.region}</div>
                <div>Base: <span className="font-medium">{van.homeAirport}</span></div>
                <div>Coverage: ~{Math.round(van.coverageRadius)} km</div>
                <div className="pt-1 font-medium">Aircraft:</div>
                {van.aircraft.map((ac) => (
                  <div key={ac.tail} className="font-mono text-xs">
                    {ac.tail} @ {ac.airport}
                  </div>
                ))}
              </div>
            </Popup>
          </CircleMarker>
        );
      })}

      {/* Aircraft at airport clusters */}
      {Array.from(airportMap.entries()).map(([airport, info]) => (
        <CircleMarker
          key={`apt-${airport}`}
          center={[info.lat, info.lon]}
          radius={info.tails.length > 1 ? 7 + info.tails.length : 6}
          pathOptions={{
            color: info.color,
            fillColor: "#fff",
            fillOpacity: 0.9,
            weight: 2.5,
          }}
        >
          <Popup>
            <div className="text-sm space-y-1">
              <div className="font-bold">{airport}</div>
              <div className="text-gray-500 text-xs">Van {info.vanId} coverage</div>
              <div className="pt-1">
                {info.tails.map((t) => (
                  <div key={t} className="font-mono text-xs">{t}</div>
                ))}
              </div>
            </div>
          </Popup>
          {info.tails.length > 1 && (
            <Tooltip direction="top" offset={[0, -6]}>
              <span className="text-xs font-semibold">{info.tails.length} aircraft</span>
            </Tooltip>
          )}
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
