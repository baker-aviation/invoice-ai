"use client";

import dynamic from "next/dynamic";
import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import type { Flight, OpsAlert } from "@/lib/opsApi";
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

type TimeRange = "Today" | "Tomorrow" | "Week" | "Month";

function getTimeRange(range: TimeRange): { start: Date; end: Date } {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrowStart = new Date(todayStart.getTime() + 86400000);
  const dayAfterTomorrow = new Date(todayStart.getTime() + 2 * 86400000);

  switch (range) {
    case "Today":
      return { start: todayStart, end: tomorrowStart };
    case "Tomorrow":
      return { start: tomorrowStart, end: dayAfterTomorrow };
    case "Week":
      return { start: todayStart, end: new Date(todayStart.getTime() + 7 * 86400000) };
    case "Month":
      return { start: todayStart, end: new Date(todayStart.getTime() + 30 * 86400000) };
  }
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-200",
  low: "bg-blue-100 text-blue-800 border-blue-200",
};

/* ── component ──────────────────────────────────────── */

export default function CurrentOps({ flights }: { flights: Flight[] }) {
  const [adsbAircraft, setAdsbAircraft] = useState<AdsbAircraft[]>([]);
  const [flightInfo, setFlightInfo] = useState<Map<string, FlightInfoMap>>(new Map());
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(DEFAULT_TYPES);
  const [timeRange, setTimeRange] = useState<TimeRange>("Today");
  const [expandedFlights, setExpandedFlights] = useState<Set<string>>(new Set());
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

  // Filter flights by time range and visible types
  const filteredFlights = useMemo(() => {
    const { start, end } = getTimeRange(timeRange);
    return flights
      .filter((f) => {
        const type = f.flight_type || "Other";
        if (!visibleTypes.has(type)) return false;
        const dep = new Date(f.scheduled_departure);
        return dep >= start && dep < end;
      })
      .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
  }, [flights, visibleTypes, timeRange]);

  function toggleExpanded(flightId: string) {
    setExpandedFlights((prev) => {
      const next = new Set(prev);
      if (next.has(flightId)) next.delete(flightId);
      else next.add(flightId);
      return next;
    });
  }

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

  // Collect active EDCT alerts across all flights
  const edctAlerts = useMemo(() => {
    const alerts: (OpsAlert & { route: string })[] = [];
    for (const f of flights) {
      for (const a of f.alerts) {
        if (a.alert_type === "EDCT") {
          const route = [f.departure_icao, f.arrival_icao].filter(Boolean).join(" → ") || "Unknown";
          alerts.push({ ...a, route });
        }
      }
    }
    return alerts;
  }, [flights]);

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
          <span className="text-gray-400">{filteredFlights.length} flights scheduled</span>
        </div>
        {lastUpdate && (
          <span className="ml-auto text-xs text-gray-400">
            Updated {lastUpdate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        )}
      </div>

      {/* ── EDCT Status ── */}
      {edctAlerts.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm">
          <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
          <span className="font-medium text-green-800">No active EDCTs</span>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2 mb-2 text-sm">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
            <span className="font-semibold text-amber-800">
              {edctAlerts.length} Active EDCT{edctAlerts.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="space-y-1.5">
            {edctAlerts.map((a) => (
              <div key={a.id} className="flex items-center gap-3 text-sm text-amber-900">
                <span className="font-medium">{a.route}</span>
                {a.tail_number && <span className="text-amber-600">{a.tail_number}</span>}
                <span className="text-sm">
                  {a.original_departure_time && <span className="text-amber-500 line-through">{fmtTime(a.original_departure_time)}</span>}
                  {a.original_departure_time && <span className="text-amber-400 mx-0.5">→</span>}
                  <span className="text-amber-800 font-bold">{a.edct_time ? fmtTime(a.edct_time) : "—"}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Map ── */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <OpsMap adsbAircraft={adsbAircraft} flightInfo={flightInfo} />
      </div>

      {/* ── Filters row ── */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Time range */}
        <div className="flex items-center gap-1">
          {(["Today", "Tomorrow", "Week", "Month"] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                timeRange === r
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <span className="text-gray-300">|</span>

        {/* Flight type filters */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Type:</span>
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
            {filteredFlights.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  No flights scheduled for selected filters
                </td>
              </tr>
            ) : (
              filteredFlights.map((f) => {
                const adsb = adsbAircraft.find((a) => a.tail === f.tail_number);
                const fi = f.tail_number ? flightInfo.get(f.tail_number) : undefined;
                const alerts = f.alerts ?? [];
                const alertCount = alerts.length;
                const type = f.flight_type || "Other";
                const typeColor = FLIGHT_TYPE_COLORS[type] || "bg-gray-100 text-gray-700";
                const isExpanded = expandedFlights.has(f.id);

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
                  <Fragment key={f.id}>
                    <tr
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
                          <button
                            onClick={() => toggleExpanded(f.id)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200 transition-colors cursor-pointer"
                          >
                            <span className={`inline-block transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                              &#9656;
                            </span>
                            {alertCount} alert{alertCount > 1 ? "s" : ""}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && alerts.map((alert) => (
                      <tr key={alert.id} className="border-t border-dashed border-gray-100 bg-red-50/40">
                        <td colSpan={7} className="px-4 py-3">
                          <div className={`rounded-lg border p-3 text-xs ${SEVERITY_COLORS[alert.severity] || "bg-gray-50 text-gray-700 border-gray-200"}`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="space-y-1 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold uppercase tracking-wide">{alert.alert_type.replace(/_/g, " ")}</span>
                                  <span className="opacity-60">·</span>
                                  <span className="capitalize">{alert.severity}</span>
                                  {alert.airport_icao && (
                                    <>
                                      <span className="opacity-60">·</span>
                                      <span className="font-mono">{alert.airport_icao}</span>
                                    </>
                                  )}
                                </div>
                                {alert.subject && (
                                  <div className="font-medium text-sm">{alert.subject}</div>
                                )}
                                {alert.body && (
                                  <div className="whitespace-pre-wrap opacity-80 max-h-32 overflow-y-auto">{alert.body}</div>
                                )}
                                {alert.edct_time && (
                                  <div className="font-medium">
                                    {alert.original_departure_time && <span className="line-through opacity-60 mr-1">{fmtTime(alert.original_departure_time)}</span>}
                                    {alert.original_departure_time && <span className="opacity-50 mr-1">→</span>}
                                    EDCT: {fmtTime(alert.edct_time)}
                                  </div>
                                )}
                              </div>
                              <span className="text-[10px] opacity-50 whitespace-nowrap shrink-0">
                                {fmtTime(alert.created_at)}
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
