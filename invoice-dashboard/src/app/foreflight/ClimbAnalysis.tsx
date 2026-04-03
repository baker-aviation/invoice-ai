"use client";

import { useState, useEffect } from "react";

interface FlightPhase {
  climbMin: number;
  cruiseMin: number;
  descentMin: number;
  totalMin: number;
  climbPct: number;
  initialAlt: number;
  maxAlt: number;
  stepClimbs: number;
  cruiseProfile: string;
  ffBurn: number;
  actualBurn: number;
  actualHrs: number;
  burnRate: number;
  ffVariance: number;
  route: string;
  date: string;
  tail: string;
  type: string;
  routeNm: number;
}

interface PilotClimb {
  name: string;
  flights: number;
  avgClimbMin: number;
  avgCruiseMin: number;
  avgDescentMin: number;
  avgClimbPct: number;
  avgInitialAlt: number;
  avgMaxAlt: number;
  totalStepClimbs: number;
  avgBurnRate: number;
  ffVariance: number;
  highClimbRate: number | null;
  lowClimbRate: number | null;
  recentFlights: FlightPhase[];
}

interface FleetStats {
  totalFlights: number;
  avgClimbMin: number;
  avgClimbPct: number;
  avgInitialAlt: number;
  avgMaxAlt: number;
}

function PhaseBar({ climb, cruise, descent }: { climb: number; cruise: number; descent: number }) {
  const total = climb + cruise + descent;
  if (total <= 0) return null;
  const cp = (climb / total) * 100;
  const crp = (cruise / total) * 100;
  const dp = (descent / total) * 100;
  return (
    <div className="flex h-3 rounded-full overflow-hidden bg-gray-100 w-full">
      <div className="bg-red-400" style={{ width: `${cp}%` }} title={`Climb: ${climb.toFixed(0)}m (${cp.toFixed(0)}%)`} />
      <div className="bg-blue-400" style={{ width: `${crp}%` }} title={`Cruise: ${cruise.toFixed(0)}m (${crp.toFixed(0)}%)`} />
      <div className="bg-amber-400" style={{ width: `${dp}%` }} title={`Descent: ${descent.toFixed(0)}m (${dp.toFixed(0)}%)`} />
    </div>
  );
}

export default function ClimbAnalysis() {
  const [pilots, setPilots] = useState<PilotClimb[]>([]);
  const [fleetStats, setFleetStats] = useState<FleetStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(3);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);

  function loadData() {
    setLoading(true);
    fetch(`/api/fuel-planning/climb-analysis?months=${months}`)
      .then((r) => r.json())
      .then((d) => {
        setPilots(d.pilots ?? []);
        setFleetStats(d.fleetStats ?? null);
        if (d.message) setMessage(d.message);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadData(); }, [months]);

  async function backfillWaypoints() {
    setBackfilling(true);
    setBackfillMsg("Starting waypoint backfill...");
    let totalBackfilled = 0;
    let done = false;

    try {
      while (!done) {
        const res = await fetch("/api/fuel-planning/sync-predictions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "backfill-waypoints" }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        totalBackfilled += data.backfilled ?? 0;
        const remaining = data.remaining ?? 0;
        setBackfillMsg(`Backfilling waypoints... ${totalBackfilled} done, ${remaining} remaining`);
        if (data.done) done = true;
      }
      setBackfillMsg(`Done: ${totalBackfilled} flights backfilled with waypoint data`);
      loadData();
    } catch (err) {
      setBackfillMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    setBackfilling(false);
  }

  if (loading) return <p className="px-6 py-4 text-sm text-gray-500">Loading climb data...</p>;

  if (!pilots.length)
    return (
      <div className="px-6 py-8 text-center text-gray-400">
        <p>{message ?? "No climb analysis data available."}</p>
        <p className="mt-2">
          <button
            onClick={backfillWaypoints}
            disabled={backfilling}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {backfilling ? "Backfilling..." : "Backfill Waypoint Data"}
          </button>
        </p>
        {backfillMsg && (
          <p className={`mt-2 text-xs ${backfillMsg.startsWith("Error") ? "text-red-600" : "text-green-600"}`}>
            {backfillMsg}
          </p>
        )}
        <p className="mt-1 text-xs">This re-fetches existing ForeFlight flights to extract altitude profiles.</p>
      </div>
    );

  return (
    <div className="px-6 py-4 space-y-6">
      {backfillMsg && (
        <div className={`rounded-md px-4 py-2 text-sm ${backfillMsg.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {backfillMsg}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">Climb &amp; Descent Analysis</h3>
          <p className="text-xs text-gray-400">
            {fleetStats?.totalFlights ?? 0} flights with phase data |
            Fleet avg: {fleetStats?.avgClimbMin ?? 0}m climb, FL{fleetStats?.avgInitialAlt ?? 0} initial, FL{fleetStats?.avgMaxAlt ?? 0} max
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={backfillWaypoints}
            disabled={backfilling}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {backfilling ? "Backfilling..." : "Backfill Waypoints"}
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

      {/* Phase legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-red-400 inline-block" /> Climb</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-400 inline-block" /> Cruise</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-amber-400 inline-block" /> Descent</span>
      </div>

      {/* Pilot cards */}
      <div className="space-y-2">
        {pilots.map((p) => {
          const climbHigh = p.avgClimbPct > (fleetStats?.avgClimbPct ?? 0) + 3;
          const altLow = p.avgInitialAlt < (fleetStats?.avgInitialAlt ?? 0) - 20;
          return (
            <div key={p.name} className="rounded-lg border border-gray-200 bg-white">
              <button
                onClick={() => setExpanded(expanded === p.name ? null : p.name)}
                className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-gray-50"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-gray-900">{p.name}</span>
                    <span className="text-xs text-gray-400">{p.flights} flights</span>
                    {climbHigh && (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">
                        High climb %
                      </span>
                    )}
                    {altLow && (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600">
                        Low initial alt
                      </span>
                    )}
                    {p.totalStepClimbs > p.flights && (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                        Frequent step climbs
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 w-full max-w-md">
                    <PhaseBar climb={p.avgClimbMin} cruise={p.avgCruiseMin} descent={p.avgDescentMin} />
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm shrink-0">
                  <div className="text-right">
                    <div className="text-xs text-gray-400">Climb</div>
                    <div className="font-semibold">{p.avgClimbMin}m <span className="text-xs font-normal text-gray-400">({p.avgClimbPct}%)</span></div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-400">Initial Alt</div>
                    <div className="font-semibold">FL{p.avgInitialAlt}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-400">Max Alt</div>
                    <div className="font-semibold">FL{p.avgMaxAlt}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-400">Burn Rate</div>
                    <div className="font-semibold">{p.avgBurnRate} <span className="text-xs font-normal text-gray-400">lbs/hr</span></div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-400">vs FF</div>
                    <div className={`font-semibold ${p.ffVariance > 10 ? "text-red-600" : p.ffVariance < -5 ? "text-green-600" : "text-gray-600"}`}>
                      {p.ffVariance > 0 ? "+" : ""}{p.ffVariance}%
                    </div>
                  </div>
                </div>
              </button>

              {expanded === p.name && (
                <div className="border-t border-gray-100 px-4 py-3 space-y-4">
                  {/* Climb vs cruise burn comparison */}
                  {p.highClimbRate && p.lowClimbRate && (
                    <div className="flex gap-4">
                      <div className="rounded-md bg-red-50 px-3 py-2">
                        <p className="text-xs text-red-500">High-climb flights (&gt;15%)</p>
                        <p className="text-sm font-semibold text-red-700">{p.highClimbRate} lbs/hr</p>
                      </div>
                      <div className="rounded-md bg-blue-50 px-3 py-2">
                        <p className="text-xs text-blue-500">Low-climb flights (&le;15%)</p>
                        <p className="text-sm font-semibold text-blue-700">{p.lowClimbRate} lbs/hr</p>
                      </div>
                      <div className="rounded-md bg-gray-50 px-3 py-2">
                        <p className="text-xs text-gray-500">Climb penalty</p>
                        <p className="text-sm font-semibold">
                          +{p.highClimbRate - p.lowClimbRate} lbs/hr
                          <span className="text-xs font-normal text-gray-400 ml-1">
                            ({Math.round(((p.highClimbRate - p.lowClimbRate) / p.lowClimbRate) * 100)}%)
                          </span>
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Flight detail table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-200 text-left text-gray-500">
                          <th className="pb-1 font-medium">Date</th>
                          <th className="pb-1 font-medium">Tail</th>
                          <th className="pb-1 font-medium">Route</th>
                          <th className="pb-1 font-medium">NM</th>
                          <th className="pb-1 font-medium">Profile</th>
                          <th className="pb-1 font-medium">Climb</th>
                          <th className="pb-1 font-medium">Cruise</th>
                          <th className="pb-1 font-medium">Desc</th>
                          <th className="pb-1 font-medium">Init Alt</th>
                          <th className="pb-1 font-medium">Max Alt</th>
                          <th className="pb-1 font-medium">Steps</th>
                          <th className="pb-1 font-medium">Burn Rate</th>
                          <th className="pb-1 font-medium">vs FF</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.recentFlights.map((f, i) => (
                          <tr key={i} className="border-b border-gray-50">
                            <td className="py-1.5">{new Date(f.date).toLocaleDateString()}</td>
                            <td className="py-1.5">{f.tail}</td>
                            <td className="py-1.5 font-medium">{f.route}</td>
                            <td className="py-1.5">{Math.round(f.routeNm)}</td>
                            <td className="py-1.5 text-gray-400 truncate max-w-[100px]" title={f.cruiseProfile}>
                              {f.cruiseProfile?.replace("Maximum Cruise Thrust", "Max").replace("250/300 KIAS/", "") || "—"}
                            </td>
                            <td className={`py-1.5 ${f.climbPct > 15 ? "text-red-600 font-medium" : ""}`}>
                              {f.climbMin}m <span className="text-gray-400">({Math.round(f.climbPct)}%)</span>
                            </td>
                            <td className="py-1.5">{f.cruiseMin}m</td>
                            <td className="py-1.5">{f.descentMin}m</td>
                            <td className="py-1.5">FL{f.initialAlt}</td>
                            <td className="py-1.5">{f.maxAlt > f.initialAlt ? <span className="text-blue-600">FL{f.maxAlt}</span> : `FL${f.maxAlt}`}</td>
                            <td className="py-1.5">{f.stepClimbs > 0 ? <span className="text-blue-600">{f.stepClimbs}</span> : "—"}</td>
                            <td className="py-1.5 font-medium">{f.burnRate}</td>
                            <td className={`py-1.5 font-medium ${f.ffVariance > 10 ? "text-red-600" : f.ffVariance < -5 ? "text-green-600" : "text-gray-600"}`}>
                              {f.ffVariance > 0 ? "+" : ""}{f.ffVariance}%
                            </td>
                          </tr>
                        ))}
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
