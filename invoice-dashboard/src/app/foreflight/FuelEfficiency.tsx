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
  matchedPredictions: number;
  ffVariancePct: number | null;
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
    actualBurn: number;
    burnRate: number;
    fleetAvg: number;
    variance: number;
    startFuel: number;
    endFuel: number;
    takeoffWt: number;
    predictedBurn: number | null;
    predictedVariance: number | null;
    ffStartFuel: number | null;
    ffFlightFuel: number | null;
    ffLandingFuel: number | null;
  }>;
}

export default function FuelEfficiency() {
  const [pilots, setPilots] = useState<PilotEfficiency[]>([]);
  const [fleetAvg, setFleetAvg] = useState<Record<string, number>>({});
  const [totalFlights, setTotalFlights] = useState(0);
  const [predictionsCount, setPredictionsCount] = useState(0);
  const [matchedCount, setMatchedCount] = useState(0);
  const [dateRange, setDateRange] = useState({ start: "", end: "" });
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(3);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  function loadData() {
    setLoading(true);
    fetch(`/api/fuel-planning/efficiency?months=${months}`)
      .then((r) => r.json())
      .then((d) => {
        setPilots(d.pilots ?? []);
        setFleetAvg(d.fleetAvg ?? {});
        setTotalFlights(d.totalFlights ?? 0);
        setPredictionsCount(d.predictionsCount ?? 0);
        setMatchedCount(d.matchedCount ?? 0);
        setDateRange(d.dateRange ?? { start: "", end: "" });
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadData(); }, [months]);

  async function syncPredictions() {
    setSyncing(true);
    setSyncMsg("Fetching flight list from ForeFlight...");

    try {
      // Step 1: Get list of flights needing sync (single API call)
      const listRes = await fetch("/api/fuel-planning/sync-predictions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months, action: "list" }),
      });
      const listData = await listRes.json();
      if (!listRes.ok) throw new Error(listData.error);

      const flights = listData.flights as Array<{ id: string }>;
      if (flights.length === 0) {
        setSyncMsg(`All ${listData.total} flights already synced`);
        setSyncing(false);
        return;
      }

      setSyncMsg(`Found ${flights.length} new flights to sync (${listData.alreadySynced} already done)`);

      // Step 2: Process in batches of 10, sending specific IDs each time
      let totalStored = 0;
      const batchSize = 10;

      for (let i = 0; i < flights.length; i += batchSize) {
        const batch = flights.slice(i, i + batchSize);
        setSyncMsg(`Syncing flights ${i + 1}–${Math.min(i + batchSize, flights.length)} of ${flights.length}... (${totalStored} stored)`);

        const res = await fetch("/api/fuel-planning/sync-predictions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flightIds: batch.map((f) => f.id) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        totalStored += data.stored ?? 0;
      }

      setSyncMsg(`Done: ${totalStored} predictions synced`);
      loadData();
    } catch (err) {
      setSyncMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    setSyncing(false);
  }

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
            {dateRange.start} to {dateRange.end} | {predictionsCount} ForeFlight predictions | {matchedCount} matched to actuals
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={syncPredictions}
            disabled={syncing}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Pull ForeFlight Plans"}
          </button>
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
      </div>

      {syncMsg && (
        <div className={`rounded-md px-4 py-2 text-sm ${syncMsg.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {syncMsg}
        </div>
      )}

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
          const isTankering = p.avgStartFuel > 8000;

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
                  {isTankering && p.variancePct > 3 && (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                      Possible tankering
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {/* ForeFlight comparison badge */}
                  {p.ffVariancePct !== null && p.matchedPredictions > 0 && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        p.ffVariancePct > 10
                          ? "bg-red-100 text-red-700"
                          : p.ffVariancePct < -5
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {p.ffVariancePct > 0 ? "+" : ""}{p.ffVariancePct}% vs FF plan
                      <span className="ml-1 text-gray-400">({p.matchedPredictions})</span>
                    </span>
                  )}
                  {/* Fleet comparison badge */}
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
                      {p.variancePct > 0 ? "+" : ""}{p.variancePct}% vs fleet
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

                  {/* Recent flights — FF Predicted vs JetInsight Actual */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-400 text-[10px] uppercase tracking-wide">
                          <th colSpan={4} className="pb-0.5"></th>
                          <th colSpan={3} className="pb-0.5 text-center text-blue-500 border-b border-blue-200">ForeFlight Predicted</th>
                          <th colSpan={3} className="pb-0.5 text-center text-gray-600 border-b border-gray-200">JetInsight Actual</th>
                          <th colSpan={2} className="pb-0.5"></th>
                        </tr>
                        <tr className="border-b border-gray-200 text-left text-gray-500">
                          <th className="pb-1 pt-1 font-medium">Date</th>
                          <th className="pb-1 pt-1 font-medium">Tail</th>
                          <th className="pb-1 pt-1 font-medium">Route</th>
                          <th className="pb-1 pt-1 font-medium">Hours</th>
                          <th className="pb-1 pt-1 font-medium text-blue-500">Start</th>
                          <th className="pb-1 pt-1 font-medium text-blue-500">Flight</th>
                          <th className="pb-1 pt-1 font-medium text-blue-500">Landing</th>
                          <th className="pb-1 pt-1 font-medium">Start</th>
                          <th className="pb-1 pt-1 font-medium">Burn</th>
                          <th className="pb-1 pt-1 font-medium">Landing</th>
                          <th className="pb-1 pt-1 font-medium">vs FF</th>
                          <th className="pb-1 pt-1 font-medium">vs Fleet</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.recentFlights.map((f, i) => {
                          const hasFF = f.ffStartFuel != null;
                          const burnDelta = hasFF && f.ffFlightFuel
                            ? Math.round(f.actualBurn - f.ffFlightFuel)
                            : null;
                          return (
                            <tr key={i} className="border-b border-gray-50">
                              <td className="py-1.5">{new Date(f.date).toLocaleDateString()}</td>
                              <td className="py-1.5">{f.tail}</td>
                              <td className="py-1.5 font-medium">{f.route}</td>
                              <td className="py-1.5">{f.hrs.toFixed(1)}</td>
                              {/* FF Predicted */}
                              <td className="py-1.5 text-blue-600">{hasFF ? f.ffStartFuel!.toLocaleString() : "—"}</td>
                              <td className="py-1.5 text-blue-600">{f.ffFlightFuel != null ? f.ffFlightFuel.toLocaleString() : "—"}</td>
                              <td className="py-1.5 text-blue-600">{f.ffLandingFuel != null ? f.ffLandingFuel.toLocaleString() : "—"}</td>
                              {/* JetInsight Actual */}
                              <td className="py-1.5 font-medium">{f.startFuel ? f.startFuel.toLocaleString() : "—"}</td>
                              <td className="py-1.5 font-medium">{f.actualBurn.toLocaleString()}</td>
                              <td className="py-1.5 font-medium">{f.endFuel ? f.endFuel.toLocaleString() : "—"}</td>
                              {/* Variance columns */}
                              <td className={`py-1.5 font-medium ${
                                f.predictedVariance !== null
                                  ? f.predictedVariance > 10 ? "text-red-600" : f.predictedVariance < -5 ? "text-green-600" : "text-gray-600"
                                  : "text-gray-300"
                              }`}>
                                {f.predictedVariance !== null ? `${f.predictedVariance > 0 ? "+" : ""}${f.predictedVariance}%` : "—"}
                                {burnDelta !== null && burnDelta !== 0 && (
                                  <span className="ml-0.5 text-gray-400 font-normal">
                                    ({burnDelta > 0 ? "+" : ""}{burnDelta.toLocaleString()})
                                  </span>
                                )}
                              </td>
                              <td className={`py-1.5 font-medium ${f.variance > 5 ? "text-red-600" : f.variance < -5 ? "text-green-600" : "text-gray-600"}`}>
                                {f.variance > 0 ? "+" : ""}{f.variance}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
