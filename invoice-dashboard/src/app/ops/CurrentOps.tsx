"use client";

import dynamic from "next/dynamic";
import { useState, useEffect, useCallback, useMemo } from "react";
import type { Flight } from "@/lib/opsApi";
import type { AdsbAircraft, FlightInfoMap } from "@/app/maintenance/MapView";

const OpsMap = dynamic(() => import("./OpsMap"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[500px] bg-gray-100 rounded-xl text-gray-500 text-sm">
      Loading map…
    </div>
  ),
});

/* ── helpers ──────────────────────────────────────── */

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return (
    d.toLocaleString("en-US", {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
    }) + "Z"
  );
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

const FLIGHT_TYPE_COLORS: Record<string, string> = {
  Charter: "bg-blue-100 text-blue-700",
  Revenue: "bg-green-100 text-green-700",
  Positioning: "bg-amber-100 text-amber-700",
  Maintenance: "bg-purple-100 text-purple-700",
  Training: "bg-cyan-100 text-cyan-700",
};

const DEFAULT_TYPES = new Set(["Charter", "Revenue", "Positioning"]);

/* ── component ──────────────────────────────────────── */

export default function CurrentOps({ flights }: { flights: Flight[] }) {
  const [adsbAircraft, setAdsbAircraft] = useState<AdsbAircraft[]>([]);
  const [flightInfo, setFlightInfo] = useState<Map<string, FlightInfoMap>>(new Map());
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(DEFAULT_TYPES);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Fetch ADS-B positions
  const fetchPositions = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/positions", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setAdsbAircraft(data.aircraft ?? []);
        setLastUpdate(new Date());
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch FlightAware data
  const fetchFlightInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/flights", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        const map = new Map<string, FlightInfoMap>();
        for (const fi of data.flights ?? []) {
          map.set(fi.tail, fi);
        }
        setFlightInfo(map);
      }
    } catch { /* ignore */ }
  }, []);

  // Poll every 60 seconds
  useEffect(() => {
    fetchPositions();
    fetchFlightInfo();
    const interval = setInterval(() => {
      fetchPositions();
      fetchFlightInfo();
    }, 60_000);
    return () => clearInterval(interval);
  }, [fetchPositions, fetchFlightInfo]);

  // Get all unique flight types
  const allTypes = useMemo(() => {
    const types = new Set<string>();
    for (const f of flights) {
      if (f.flight_type) types.add(f.flight_type);
    }
    return [...types].sort();
  }, [flights]);

  // Filter today's flights by visible types
  const todaysFlights = useMemo(() => {
    return flights
      .filter((f) => {
        const type = f.flight_type || "Other";
        if (!visibleTypes.has(type)) return false;
        // Show flights from today and tomorrow (next 48h window)
        return true;
      })
      .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
  }, [flights, visibleTypes]);

  function toggleType(type: string) {
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  // Count airborne vs on-ground
  const airborne = adsbAircraft.filter((a) => !a.on_ground).length;
  const onGround = adsbAircraft.filter((a) => a.on_ground).length;

  return (
    <div className="space-y-4">
      {/* ── Status bar ── */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span className="font-medium text-gray-700">{airborne} airborne</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-gray-400" />
            <span className="text-gray-500">{onGround} on ground</span>
          </span>
          <span className="text-gray-400">·</span>
          <span className="text-gray-400">{todaysFlights.length} flights scheduled</span>
        </div>
        {lastUpdate && (
          <span className="ml-auto text-xs text-gray-400">
            Updated {lastUpdate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        )}
      </div>

      {/* ── Map ── */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <OpsMap adsbAircraft={adsbAircraft} flightInfo={flightInfo} />
      </div>

      {/* ── Flight type filters ── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Show:</span>
        {allTypes.map((type) => {
          const active = visibleTypes.has(type);
          const colorClass = FLIGHT_TYPE_COLORS[type] || "bg-gray-100 text-gray-700";
          return (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                active ? colorClass : "bg-gray-100 text-gray-400 opacity-50"
              }`}
            >
              {type}
            </button>
          );
        })}
      </div>

      {/* ── Schedule table ── */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Tail</th>
              <th className="px-4 py-3">Route</th>
              <th className="px-4 py-3">Departure</th>
              <th className="px-4 py-3">Arrival</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Notes</th>
            </tr>
          </thead>
          <tbody>
            {todaysFlights.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  No flights scheduled for selected types
                </td>
              </tr>
            ) : (
              todaysFlights.map((f) => {
                const adsb = adsbAircraft.find((a) => a.tail === f.tail_number);
                const fi = f.tail_number ? flightInfo.get(f.tail_number) : undefined;
                const alertCount = f.alerts?.length ?? 0;
                const type = f.flight_type || "Other";
                const typeColor = FLIGHT_TYPE_COLORS[type] || "bg-gray-100 text-gray-700";

                // Determine status
                let status = "Scheduled";
                let statusColor = "text-gray-500";
                if (adsb && !adsb.on_ground) {
                  status = "Airborne";
                  statusColor = "text-blue-600 font-medium";
                } else if (adsb && adsb.on_ground) {
                  status = "On Ground";
                  statusColor = "text-gray-500";
                }
                if (fi?.status) {
                  status = fi.status;
                  if (fi.status.includes("En Route")) statusColor = "text-blue-600 font-medium";
                  if (fi.status.includes("Arrived")) statusColor = "text-green-600 font-medium";
                }
                if (fi?.diverted) {
                  status = "DIVERTED";
                  statusColor = "text-red-600 font-bold";
                }

                const depDate = new Date(f.scheduled_departure);
                const isPast = depDate < new Date() && status === "Scheduled";

                return (
                  <tr
                    key={f.id}
                    className={`border-t hover:bg-gray-50 ${isPast ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-2.5 font-mono font-semibold text-gray-900">
                      {f.tail_number || "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-mono font-medium">
                        {f.departure_icao || "?"} → {f.arrival_icao || "?"}
                      </span>
                      {fi?.progress_percent != null && fi.progress_percent > 0 && fi.progress_percent < 100 && (
                        <div className="mt-1 w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full"
                            style={{ width: `${fi.progress_percent}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{fmtTime(f.scheduled_departure)}</td>
                    <td className="px-4 py-2.5 text-gray-600">
                      {fi?.arrival_time ? fmtTime(fi.arrival_time) : fmtTime(f.scheduled_arrival)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${typeColor}`}>
                        {type}
                      </span>
                    </td>
                    <td className={`px-4 py-2.5 text-xs ${statusColor}`}>
                      {status}
                    </td>
                    <td className="px-4 py-2.5">
                      {alertCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700">
                          {alertCount} alert{alertCount > 1 ? "s" : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
