"use client";

import { useState, useEffect } from "react";

interface PilotEfficiency {
  name: string;
  flights: number;
  totalHrs: number;
  avgBurnRate: number;
  weightedFleetAvg: number;
  variancePct: number;
  avgStartFuel: number;
  byType: Array<{
    type: string;
    flights: number;
    hours: number;
    avgBurnRate: number;
    fleetAvg: number;
  }>;
  recentFlights: Array<{
    date: string;
    tail: string;
    type: string;
    route: string;
    hrs: number;
    burnRate: number;
    fleetAvg: number;
    variance: number;
    startFuel: number;
    takeoffWt: number;
  }>;
}

export default function FuelEfficiency() {
  const [pilots, setPilots] = useState<PilotEfficiency[]>([]);
  const [fleetAvg, setFleetAvg] = useState<Record<string, number>>({});
  const [totalFlights, setTotalFlights] = useState(0);
  const [dateRange, setDateRange] = useState({ start: "", end: "" });
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(3);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/fuel-planning/efficiency?months=${months}`)
      .then((r) => r.json())
      .then((d) => {
        setPilots(d.pilots ?? []);
        setFleetAvg(d.fleetAvg ?? {});
        setTotalFlights(d.totalFlights ?? 0);
        setDateRange(d.dateRange ?? { start: "", end: "" });
      })
      .finally(() => setLoading(false));
  }, [months]);

  if (loading) return <p className="px-6 py-4 text-sm text-gray-500">Loading...</p>;

  if (pilots.length === 0)
    return (
      <div className="px-6 py-8 text-center text-gray-400">
        <p>No fuel efficiency data available.</p>
        <p className="mt-1 text-xs">Upload post-flight CSVs from JetInsight to populate this data.</p>
      </div>
    );

  return (
    <div className="px-6 py-4 space-y-6">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">
            Fuel Burn Analysis — {totalFlights} flights
          </h3>
          <p className="text-xs text-gray-400">
            {dateRange.start} to {dateRange.end} | Pilots with 3+ flights shown
          </p>
        </div>
        <select
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value={1}>Last 1 month</option>
          <option value={3}>Last 3 months</option>
          <option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option>
        </select>
      </div>

      {/* Fleet averages */}
      <div className="flex gap-4">
        {Object.entries(fleetAvg).map(([type, avg]) => (
          <div key={type} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs text-gray-500">{type} Fleet Average</p>
            <p className="text-xl font-semibold text-gray-900">
              {avg} <span className="text-sm font-normal text-gray-400">lbs/hr</span>
            </p>
          </div>
        ))}
      </div>

      {/* Pilot table */}
      <div className="space-y-2">
        {pilots.map((p) => {
          const isHeavy = p.variancePct > 5;
          const isLight = p.variancePct < -5;
          const isTankering = p.avgStartFuel > 8000; // rough heuristic

          return (
            <div key={p.name} className="rounded-lg border border-gray-200 bg-white">
              <button
                onClick={() => setExpanded(expanded === p.name ? null : p.name)}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <span className="text-xs text-gray-400">
                    {p.flights} flights | {p.totalHrs} hrs
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {isTankering && p.variancePct > 3 && (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                      Possible tankering
                    </span>
                  )}
                  <div className="text-right">
                    <span className="text-sm font-semibold text-gray-900">
                      {p.avgBurnRate} lbs/hr
                    </span>
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                        isHeavy
                          ? "bg-red-100 text-red-700"
                          : isLight
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {p.variancePct > 0 ? "+" : ""}
                      {p.variancePct}% vs fleet
                    </span>
                  </div>
                </div>
              </button>

              {expanded === p.name && (
                <div className="border-t border-gray-100 px-4 py-3 space-y-4">
                  {/* Per aircraft type */}
                  <div className="flex gap-4">
                    {p.byType.map((t) => {
                      const diff = t.fleetAvg > 0
                        ? Math.round(((t.avgBurnRate - t.fleetAvg) / t.fleetAvg) * 100)
                        : 0;
                      return (
                        <div key={t.type} className="rounded-md bg-gray-50 px-3 py-2">
                          <p className="text-xs text-gray-500">{t.type}</p>
                          <p className="text-sm font-semibold">
                            {t.avgBurnRate} lbs/hr
                            <span className={`ml-1 text-xs ${diff > 5 ? "text-red-600" : diff < -5 ? "text-green-600" : "text-gray-400"}`}>
                              ({diff > 0 ? "+" : ""}{diff}% vs {t.fleetAvg})
                            </span>
                          </p>
                          <p className="text-xs text-gray-400">{t.flights} flights, {t.hours} hrs</p>
                        </div>
                      );
                    })}
                  </div>

                  {/* Recent flights */}
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-gray-500">
                        <th className="pb-1 font-medium">Date</th>
                        <th className="pb-1 font-medium">Tail</th>
                        <th className="pb-1 font-medium">Route</th>
                        <th className="pb-1 font-medium">Hours</th>
                        <th className="pb-1 font-medium">Burn Rate</th>
                        <th className="pb-1 font-medium">Fleet Avg</th>
                        <th className="pb-1 font-medium">Variance</th>
                        <th className="pb-1 font-medium">Start Fuel</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.recentFlights.map((f, i) => (
                        <tr key={i} className="border-b border-gray-50">
                          <td className="py-1.5">{new Date(f.date).toLocaleDateString()}</td>
                          <td className="py-1.5">{f.tail}</td>
                          <td className="py-1.5 font-medium">{f.route}</td>
                          <td className="py-1.5">{f.hrs.toFixed(1)}</td>
                          <td className="py-1.5 font-medium">{f.burnRate}</td>
                          <td className="py-1.5 text-gray-400">{f.fleetAvg}</td>
                          <td className={`py-1.5 font-medium ${f.variance > 5 ? "text-red-600" : f.variance < -5 ? "text-green-600" : "text-gray-600"}`}>
                            {f.variance > 0 ? "+" : ""}{f.variance}%
                          </td>
                          <td className="py-1.5 text-gray-500">{f.startFuel.toLocaleString()} lbs</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
