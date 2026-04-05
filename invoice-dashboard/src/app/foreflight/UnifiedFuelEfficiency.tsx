"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";

const AltitudeProfileChart = dynamic(() => import("./AltitudeProfileChart"), { ssr: false });
const TrendChartInner = dynamic(() => import("recharts").then((m) => {
  const { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } = m;
  return { default: ({ data }: { data: Array<{ month: string; avgLbsNm: number; avgGalHr: number; flights: number }> }) => (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#9ca3af" }} />
        <YAxis tick={{ fontSize: 11, fill: "#9ca3af" }} domain={["auto", "auto"]} />
        <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e5e7eb" }} />
        <Line type="monotone" dataKey="avgLbsNm" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} name="lbs/NM" />
      </LineChart>
    </ResponsiveContainer>
  )};
}), { ssr: false });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ByType { type: string; flights: number; hours: number; avgBurnRate: number; avgLbsNm: number; fleetAvgLbsNm: number }
interface RecentFlight {
  date: string; tail: string; type: string; route: string; nm: number; hrs: number;
  actualBurn: number; burnRate: number; lbsNm: number; startFuel: number; endFuel: number;
  ffBurn: number | null; ffStartFuel: number | null; ffFlightFuel: number | null; ffLandingFuel: number | null;
  ffTimeMin: number | null; predictedVariance: number | null; fleetVariance: number;
  climbMin: number | null; cruiseMin: number | null; descentMin: number | null;
  climbPct: number | null; initialAlt: number | null; maxAlt: number | null;
  stepClimbs: number | null; cruiseProfile: string | null; blockHrs: number;
  excludedFromAvg?: boolean;
}
interface Pilot {
  name: string; flights: number; totalHrs: number;
  avgBurnRate: number; avgLbsNm: number; lbsNmVariancePct: number; burnRateVariancePct: number;
  avgStartFuel: number; ffVariancePct: number | null; matchedPredictions: number;
  avgClimbMin: number | null; avgClimbPct: number | null;
  avgInitialAlt: number | null; avgMaxAlt: number | null; totalStepClimbs: number;
  avgCruiseFl: number | null;
  avgAltEfficiency: number | null;
  avgApuGal: number | null;
  apuGaps: number;
  byType: ByType[]; insights: string[]; recentFlights: RecentFlight[];
  costImpact: number; extraLbs: number; extraGal: number;
}
interface FleetTypeStats { avgBurnRate: number; avgLbsNm: number; avgClimbPct: number; avgInitialAlt: number; flights: number; hours: number }

interface Tail { tail: string; type: string; flights: number; avgBurnRate: number; avgLbsNm: number; variancePct: number }
interface Data {
  fleetStats: { byType: Record<string, FleetTypeStats>; ffAccuracy: number; fleetCruiseFl: number | null; fleetAvgApuGal: number | null; totalFlights: number; matchedFlights: number; dateRange: { start: string; end: string } };
  pilots: Pilot[]; tails: Tail[];
  trend: Array<{ month: string; avgLbsNm: number; avgGalHr: number; flights: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmt = (n: number | null | undefined, d = 0) => n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtMin = (m: number | null) => { if (m == null || m === 0) return "—"; const h = Math.floor(m / 60); const mm = Math.round(m % 60); return h > 0 ? `${h}:${String(mm).padStart(2, "0")}` : `${mm}m`; };
const pctClass = (v: number, hi = 5, lo = -5) => v > hi ? "text-red-600" : v < lo ? "text-green-600" : "text-gray-600";

function PhaseBar({ climb, cruise, descent }: { climb: number; cruise: number; descent: number }) {
  const total = climb + cruise + descent;
  if (total <= 0) return null;
  return (
    <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-100 w-full">
      <div className="bg-red-400" style={{ width: `${(climb / total) * 100}%` }} title={`Climb: ${climb.toFixed(0)}m`} />
      <div className="bg-blue-400" style={{ width: `${(cruise / total) * 100}%` }} title={`Cruise: ${cruise.toFixed(0)}m`} />
      <div className="bg-amber-400" style={{ width: `${(descent / total) * 100}%` }} title={`Descent: ${descent.toFixed(0)}m`} />
    </div>
  );
}

function Badge({ children, color }: { children: React.ReactNode; color: "red" | "green" | "blue" | "amber" | "gray" }) {
  const cls: Record<string, string> = {
    red: "bg-red-50 text-red-700", green: "bg-green-50 text-green-700",
    blue: "bg-blue-50 text-blue-700", amber: "bg-amber-50 text-amber-700", gray: "bg-gray-100 text-gray-600",
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls[color]}`}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function UnifiedFuelEfficiency() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(0.5); // default 2 weeks
  const [typeFilter, setTypeFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"lbsNm" | "burnRate" | "climbPct" | "ffVar">("lbsNm");
  const [showTails, setShowTails] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [profileFlight, setProfileFlight] = useState<string | null>(null); // "pilotName:flightIndex"

  const loadData = useCallback(() => {
    setLoading(true);
    fetch(`/api/fuel-planning/unified-efficiency?months=${months}&type=${typeFilter}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .finally(() => setLoading(false));
  }, [months, typeFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  // Sync ForeFlight predictions
  async function syncForeFlight() {
    setSyncing(true);
    setSyncMsg("Fetching flight list...");
    try {
      const listRes = await fetch("/api/fuel-planning/sync-predictions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months, action: "list" }),
      });
      const listData = await listRes.json();
      if (!listRes.ok) throw new Error(listData.error);
      const flights = listData.flights as Array<{ id: string }>;
      if (flights.length === 0) { setSyncMsg(`All ${listData.total} flights synced`); setSyncing(false); return; }
      let stored = 0;
      for (let i = 0; i < flights.length; i += 10) {
        const batch = flights.slice(i, i + 10);
        setSyncMsg(`Syncing ${i + 1}–${Math.min(i + 10, flights.length)} of ${flights.length}...`);
        const res = await fetch("/api/fuel-planning/sync-predictions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flightIds: batch.map((f) => f.id) }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        stored += d.stored ?? 0;
      }
      setSyncMsg(`Done: ${stored} predictions synced`);
      loadData();
    } catch (err) { setSyncMsg(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    setSyncing(false);
  }

  // Sync FlightAware ADS-B tracks (two-step: discover → fetch)
  async function syncTracks() {
    setSyncing(true);
    setSyncMsg("Discovering historical flights from FlightAware...");
    try {
      // Step 1: Discover flights by callsign
      const discoverRes = await fetch("/api/fuel-planning/sync-tracks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discover" }),
        signal: AbortSignal.timeout(280_000),
      });
      const discoverData = await discoverRes.json();
      if (!discoverRes.ok) throw new Error(discoverData.error);

      const flights = discoverData.flights as Array<{ id: string; tail: string; origin: string; dest: string; date: string }>;
      if (flights.length === 0) {
        setSyncMsg(`All flights already synced (${discoverData.alreadySynced} tracks stored)`);
        setSyncing(false);
        return;
      }

      setSyncMsg(`Found ${flights.length} new flights across ${discoverData.callsigns} aircraft. Pulling tracks...`);

      // Step 2: Fetch tracks in batches
      let totalStored = 0;
      const batchSize = 5;
      for (let i = 0; i < flights.length; i += batchSize) {
        const batch = flights.slice(i, i + batchSize);
        setSyncMsg(`Pulling tracks ${i + 1}–${Math.min(i + batchSize, flights.length)} of ${flights.length}... (${totalStored} stored)`);
        const res = await fetch("/api/fuel-planning/sync-tracks", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ faFlightIds: batch }),
          signal: AbortSignal.timeout(60_000),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        totalStored += d.stored ?? 0;
      }
      setSyncMsg(`Done: ${totalStored} ADS-B tracks synced (${flights.length} flights processed)`);
    } catch (err) { setSyncMsg(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    setSyncing(false);
  }

  // Sort pilots
  const sortedPilots = [...(data?.pilots ?? [])].sort((a, b) => {
    if (sortBy === "lbsNm") return b.lbsNmVariancePct - a.lbsNmVariancePct;
    if (sortBy === "burnRate") return b.burnRateVariancePct - a.burnRateVariancePct;
    if (sortBy === "climbPct") return (a.avgCruiseFl ?? 999) - (b.avgCruiseFl ?? 999); // lowest cruise FL first
    if (sortBy === "ffVar") return (b.ffVariancePct ?? 0) - (a.ffVariancePct ?? 0);
    return 0;
  });

  if (loading) return <p className="px-6 py-4 text-sm text-gray-500">Loading fuel efficiency data...</p>;
  if (!data) return <p className="px-6 py-4 text-sm text-red-500">Failed to load data</p>;

  const { fleetStats, tails } = data;
  const types = Object.entries(fleetStats.byType);

  return (
    <div className="px-6 py-4 space-y-6 max-w-[1600px] mx-auto">
      {/* ─── Command Bar ─── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">Fuel Efficiency — {fleetStats.totalFlights} flights</h3>
          <p className="text-xs text-gray-400">
            {fleetStats.dateRange.start} to {fleetStats.dateRange.end} | {fleetStats.matchedFlights} matched to ForeFlight
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={syncForeFlight} disabled={syncing}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {syncing ? "Syncing..." : "Sync ForeFlight"}
          </button>
          <button onClick={syncTracks} disabled={syncing}
            className="rounded-md bg-purple-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50">
            {syncing ? "Syncing..." : "Sync ADS-B Tracks"}
          </button>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm">
            <option value="all">All Types</option>
            <option value="CE-750">CE-750</option>
            <option value="CL-30">CL-30</option>
          </select>
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm">
            <option value={0.5}>2 weeks</option>
            <option value={1}>1 month</option>
            <option value={3}>3 months</option>
            <option value={6}>6 months</option>
            <option value={12}>12 months</option>
          </select>
        </div>
      </div>

      {syncMsg && (
        <div className={`rounded-md px-4 py-2 text-sm ${syncMsg.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {syncMsg}
        </div>
      )}

      {/* ─── Fleet Scorecard ─── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {types.map(([type, stats]) => (
          <div key={type} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs text-gray-500">{type}</p>
            <p className="text-xl font-bold text-gray-900">{stats.avgLbsNm.toFixed(2)} <span className="text-sm font-normal text-gray-400">lbs/NM</span></p>
            <p className="text-sm font-semibold text-gray-700">{fmt(Math.round(stats.avgBurnRate / 6.7))} <span className="text-xs font-normal text-gray-400">gal/hr</span></p>
            <p className="text-xs text-gray-400">{stats.flights} flights</p>
          </div>
        ))}
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <p className="text-xs text-gray-500">FF Accuracy</p>
          <p className={`text-xl font-bold ${fleetStats.ffAccuracy > 5 ? "text-amber-600" : "text-gray-900"}`}>
            {fleetStats.ffAccuracy > 0 ? "+" : ""}{fleetStats.ffAccuracy}%
          </p>
          <p className="text-xs text-gray-400">actual vs predicted</p>
        </div>
        {fleetStats.fleetCruiseFl != null && (
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs text-gray-500">Fleet Avg Cruise</p>
            <p className="text-xl font-bold text-gray-900">FL{fleetStats.fleetCruiseFl}</p>
            <p className="text-xs text-gray-400">from ADS-B data</p>
          </div>
        )}
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <p className="text-xs text-gray-500">Pilot Spread</p>
          {sortedPilots.length >= 2 ? (
            <>
              <p className="text-xl font-bold text-gray-900">
                {Math.round(sortedPilots[0].lbsNmVariancePct - sortedPilots[sortedPilots.length - 1].lbsNmVariancePct)}%
              </p>
              <p className="text-xs text-gray-400">range on lbs/NM</p>
            </>
          ) : <p className="text-sm text-gray-400">—</p>}
        </div>
        {(() => {
          const totalCost = sortedPilots.reduce((s, p) => s + (p.costImpact > 0 ? p.costImpact : 0), 0);
          const savingsIfBest = sortedPilots.reduce((s, p) => s + Math.max(0, p.costImpact), 0);
          return (
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Savings Opportunity</p>
              <p className="text-xl font-bold text-red-600">${savingsIfBest.toLocaleString()}</p>
              <p className="text-xs text-gray-400">if all pilots matched fleet avg</p>
            </div>
          );
        })()}
      </div>

      {/* ─── Fleet Trend Chart ─── */}
      {data.trend.length > 1 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Fleet Efficiency Trend (lbs/NM)</h4>
          <TrendChartInner data={data.trend} />
        </div>
      )}

      {/* ─── Sort Controls ─── */}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>Sort by:</span>
          {(["lbsNm", "burnRate", "climbPct", "ffVar"] as const).map((s) => (
            <button key={s} onClick={() => setSortBy(s)}
              className={`px-2 py-0.5 rounded ${sortBy === s ? "bg-blue-100 text-blue-700 font-medium" : "hover:bg-gray-100"}`}>
              {{ lbsNm: "lbs/NM", burnRate: "gal/hr", climbPct: "Cruise FL", ffVar: "vs FF" }[s]}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Pilot Leaderboard ─── */}
      <div className="space-y-2">
        {sortedPilots.map((p) => (
          <div key={p.name} className="rounded-lg border border-gray-200 bg-white">
            <button onClick={() => setExpanded(expanded === p.name ? null : p.name)}
              className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-gray-50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <span className="text-xs text-gray-400">{p.flights} flights | {p.totalHrs} hrs</span>
                  {p.lbsNmVariancePct > 8 && <Badge color="red">High burn</Badge>}
                  {p.lbsNmVariancePct < -5 && <Badge color="green">Efficient</Badge>}
                  {p.avgCruiseFl != null && fleetStats.fleetCruiseFl != null && p.avgCruiseFl < fleetStats.fleetCruiseFl - 20 && <Badge color="amber">Low cruise FL</Badge>}
                  {p.avgStartFuel > 8000 && p.burnRateVariancePct > 3 && <Badge color="blue">Possible tankering</Badge>}
                  {p.totalStepClimbs > p.flights && <Badge color="blue">Step climbs</Badge>}
                </div>
                {false && p.avgClimbPct != null && (
                  <div className="mt-1.5 w-full max-w-xs">
                    <PhaseBar climb={p.avgClimbMin ?? 0} cruise={(p.recentFlights[0]?.cruiseMin ?? 0) || 0} descent={(p.recentFlights[0]?.descentMin ?? 0) || 0} />
                  </div>
                )}
              </div>
              <div className="grid grid-cols-7 gap-1 text-sm shrink-0" style={{ width: 580 }}>
                <div className="text-right">
                  <div className="text-[10px] text-gray-400 uppercase">lbs/NM</div>
                  <div className="font-bold">{p.avgLbsNm.toFixed(2)}</div>
                  <div className={`text-xs font-medium ${pctClass(p.lbsNmVariancePct)}`}>{p.lbsNmVariancePct > 0 ? "+" : ""}{p.lbsNmVariancePct.toFixed(1)}%</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-gray-400 uppercase">gal/hr</div>
                  <div className="font-bold">{fmt(Math.round(p.avgBurnRate / 6.7))}</div>
                  <div className={`text-xs font-medium ${pctClass(p.burnRateVariancePct)}`}>{p.burnRateVariancePct > 0 ? "+" : ""}{p.burnRateVariancePct}%</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-gray-400 uppercase">Cruise FL</div>
                  <div className={`font-bold ${p.avgCruiseFl != null && fleetStats.fleetCruiseFl != null && p.avgCruiseFl < fleetStats.fleetCruiseFl - 15 ? "text-amber-600" : ""}`}>
                    {p.avgCruiseFl != null ? `FL${p.avgCruiseFl}` : "—"}
                  </div>
                  <div className="text-xs text-gray-400">{p.avgCruiseFl != null ? `fleet FL${fleetStats.fleetCruiseFl}` : "no ADS-B"}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-gray-400 uppercase">Alt Eff</div>
                  <div className={`font-bold ${p.avgAltEfficiency != null ? (p.avgAltEfficiency >= 70 ? "text-green-600" : p.avgAltEfficiency >= 40 ? "text-amber-600" : "text-red-600") : ""}`}>
                    {p.avgAltEfficiency != null ? `${p.avgAltEfficiency}%` : "—"}
                  </div>
                  <div className="text-xs text-gray-400">{p.avgAltEfficiency != null ? "at optimal" : ""}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-gray-400 uppercase">APU</div>
                  <div className={`font-bold ${p.avgApuGal != null && fleetStats.fleetAvgApuGal != null && p.avgApuGal > fleetStats.fleetAvgApuGal * 1.5 ? "text-red-600" : ""}`}>
                    {p.avgApuGal != null ? `${p.avgApuGal}g` : "—"}
                  </div>
                  <div className="text-xs text-gray-400">{p.avgApuGal != null && fleetStats.fleetAvgApuGal != null ? `fleet ${fleetStats.fleetAvgApuGal}g` : ""}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-gray-400 uppercase">vs FF</div>
                  <div className={`font-bold ${pctClass(p.ffVariancePct ?? 0, 10)}`}>
                    {p.ffVariancePct != null ? `${p.ffVariancePct > 0 ? "+" : ""}${p.ffVariancePct}%` : "—"}
                  </div>
                  <div className="text-xs text-gray-400">{p.matchedPredictions > 0 ? `${p.matchedPredictions} matched` : ""}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-gray-400 uppercase">Cost Impact</div>
                  <div className={`font-bold ${p.costImpact > 0 ? "text-red-600" : p.costImpact < -100 ? "text-green-600" : "text-gray-600"}`}>
                    {p.costImpact > 0 ? "+" : ""}{p.costImpact < 0 ? "-" : ""}${Math.abs(p.costImpact).toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-400">{p.extraLbs > 0 ? "+" : ""}{Math.round(p.extraLbs / 6.7).toLocaleString()} gal</div>
                </div>
              </div>
            </button>

            {/* ─── Expanded Detail ─── */}
            {expanded === p.name && (
              <div className="border-t border-gray-100 px-4 py-4 space-y-4">
                {/* Insight callouts */}
                {p.insights.length > 0 && (
                  <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 space-y-1">
                    <p className="text-xs font-semibold text-amber-800 uppercase">Opportunities</p>
                    {p.insights.map((ins, i) => (
                      <p key={i} className="text-sm text-amber-700">• {ins}</p>
                    ))}
                  </div>
                )}

                {/* Per-type cards */}
                <div className="flex gap-4 flex-wrap">
                  {p.byType.map((t) => {
                    const lbsNmDiff = t.fleetAvgLbsNm > 0 ? Math.round(((t.avgLbsNm - t.fleetAvgLbsNm) / t.fleetAvgLbsNm) * 100) : 0;
                    const rateDiff = t.avgBurnRate && p.avgBurnRate ? p.burnRateVariancePct : 0;
                    return (
                      <div key={t.type} className="rounded-md bg-gray-50 px-4 py-2.5">
                        <p className="text-xs text-gray-500 font-medium">{t.type}</p>
                        <div className="flex items-baseline gap-3 mt-0.5">
                          <span className="text-sm font-bold">{t.avgLbsNm.toFixed(2)} lbs/NM</span>
                          <span className={`text-xs font-medium ${pctClass(lbsNmDiff)}`}>
                            ({lbsNmDiff > 0 ? "+" : ""}{lbsNmDiff}% vs {t.fleetAvgLbsNm.toFixed(2)})
                          </span>
                        </div>
                        <p className="text-xs text-gray-400">{Math.round(t.avgBurnRate / 6.7)} gal/hr | {t.flights} flights, {t.hours} hrs</p>
                      </div>
                    );
                  })}
                </div>

                {/* Unified flight table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-400 text-[10px] uppercase tracking-wide">
                        <th colSpan={5} className="pb-0.5" />
                        <th colSpan={3} className="pb-0.5 text-center border-b border-blue-200 text-blue-500">FF Predicted</th>
                        <th colSpan={3} className="pb-0.5 text-center border-b border-gray-200 text-gray-500">Actual</th>
                        <th colSpan={2} className="pb-0.5" />
                      </tr>
                      <tr className="border-b border-gray-200 text-left text-gray-500">
                        <th className="pb-1 pt-1 font-medium">Date</th>
                        <th className="pb-1 pt-1 font-medium">Tail</th>
                        <th className="pb-1 pt-1 font-medium">Route</th>
                        <th className="pb-1 pt-1 font-medium">NM</th>
                        <th className="pb-1 pt-1 font-medium">vs Plan</th>
                        <th className="pb-1 pt-1 font-medium text-blue-500">Time</th>
                        <th className="pb-1 pt-1 font-medium text-blue-500">Fuel</th>
                        <th className="pb-1 pt-1 font-medium text-blue-500">Landing</th>
                        <th className="pb-1 pt-1 font-medium">Time</th>
                        <th className="pb-1 pt-1 font-medium">Burn</th>
                        <th className="pb-1 pt-1 font-medium">lbs/NM</th>
                        <th className="pb-1 pt-1 font-medium">vs FF</th>
                        <th className="pb-1 pt-1 font-medium">vs Fleet</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.recentFlights.map((f, i) => {
                        const ffHrs = f.ffTimeMin != null ? f.ffTimeMin / 60 : null;
                        const fmtH = (h: number) => { const hh = Math.floor(h); const mm = Math.round((h - hh) * 60); return `${hh}:${String(mm).padStart(2, "0")}`; };
                        const profileKey = `${p.name}:${i}`;
                        const showProfile = profileFlight === profileKey;
                        const [routeOrigin, routeDest] = f.route.split("-");
                        const excluded = f.excludedFromAvg;
                        return (
                          <tr key={i} className={`border-b border-gray-50 ${excluded ? "opacity-40" : ""} ${showProfile ? "bg-blue-50/30" : "hover:bg-gray-50/50 cursor-pointer"}`}
                            onClick={() => setProfileFlight(showProfile ? null : profileKey)}
                            title={excluded ? "< 45 min — excluded from averages" : ""}>
                            <td className="py-1.5">{new Date(f.date).toLocaleDateString()}</td>
                            <td className="py-1.5">{f.tail}</td>
                            <td className="py-1.5 font-medium">
                              {f.route}
                              {showProfile && <span className="ml-1 text-blue-500 text-[10px]">▼</span>}
                            </td>
                            <td className="py-1.5">{Math.round(f.nm)}</td>
                            {/* Climb delta: actual time minus FF planned */}
                            <td className="py-1.5">
                              {f.ffTimeMin != null && f.hrs > 0 ? (() => {
                                const deltaMin = Math.round((f.hrs - f.ffTimeMin / 60) * 60);
                                return (
                                  <span className={Math.abs(deltaMin) > 10 ? (deltaMin > 0 ? "text-red-600 font-medium" : "text-green-600 font-medium") : "text-gray-600"}>
                                    {deltaMin > 0 ? "+" : ""}{deltaMin}m
                                  </span>
                                );
                              })() : "—"}
                            </td>
                            {/* FF Predicted */}
                            <td className="py-1.5 text-blue-600">{ffHrs != null ? fmtH(ffHrs) : "—"}</td>
                            <td className="py-1.5 text-blue-600">{f.ffFlightFuel != null ? fmt(f.ffFlightFuel) : "—"}</td>
                            <td className="py-1.5 text-blue-600">{f.ffLandingFuel != null ? fmt(f.ffLandingFuel) : "—"}</td>
                            {/* Actual */}
                            <td className="py-1.5 font-medium">{f.hrs > 0 ? fmtH(f.hrs) : "—"}</td>
                            <td className="py-1.5 font-medium">{fmt(f.actualBurn)}</td>
                            <td className="py-1.5 font-medium">{f.lbsNm > 0 ? f.lbsNm.toFixed(1) : "—"}</td>
                            {/* Variance */}
                            <td className={`py-1.5 font-medium ${pctClass(f.predictedVariance ?? 0, 10)}`}>
                              {f.predictedVariance != null ? `${f.predictedVariance > 0 ? "+" : ""}${f.predictedVariance}%` : "—"}
                            </td>
                            <td className={`py-1.5 font-medium ${pctClass(f.fleetVariance)}`}>
                              {f.fleetVariance > 0 ? "+" : ""}{f.fleetVariance}%
                            </td>
                          </tr>
                        );
                      })}
                      {/* Altitude profile chart (renders below the clicked row's parent tbody) */}
                      {p.recentFlights.map((f, i) => {
                        const profileKey = `${p.name}:${i}`;
                        if (profileFlight !== profileKey) return null;
                        const [routeOrigin, routeDest] = f.route.split("-");
                        return (
                          <tr key={`profile-${i}`}>
                            <td colSpan={13} className="p-0">
                              <AltitudeProfileChart tail={f.tail} origin={routeOrigin} dest={routeDest} date={f.date} type={f.type} actualBurn={f.actualBurn} flightHrs={f.hrs} />
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
        ))}
      </div>

      {/* ─── Tail Analysis ─── */}
      {tails.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white">
          <button onClick={() => setShowTails(!showTails)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50">
            <div>
              <span className="text-sm font-semibold text-gray-700">Tail Analysis</span>
              <span className="text-xs text-gray-400 ml-2">{tails.length} aircraft — ±{Math.round(Math.max(...tails.map(t => Math.abs(t.variancePct))))}% spread</span>
            </div>
            <span className="text-xs text-gray-400">{showTails ? "Hide" : "Show"}</span>
          </button>
          {showTails && (
            <div className="border-t border-gray-100 px-4 py-3">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500">
                    <th className="pb-1 font-medium">Tail</th>
                    <th className="pb-1 font-medium">Type</th>
                    <th className="pb-1 font-medium text-right">lbs/NM</th>
                    <th className="pb-1 font-medium text-right">lbs/hr</th>
                    <th className="pb-1 font-medium text-right">vs Type Avg</th>
                    <th className="pb-1 font-medium text-right">Flights</th>
                  </tr>
                </thead>
                <tbody>
                  {tails.map((t) => (
                    <tr key={t.tail} className="border-b border-gray-50">
                      <td className="py-1.5 font-medium">{t.tail}</td>
                      <td className="py-1.5 text-gray-500">{t.type}</td>
                      <td className="py-1.5 text-right font-mono">{t.avgLbsNm.toFixed(2)}</td>
                      <td className="py-1.5 text-right font-mono">{fmt(t.avgBurnRate)}</td>
                      <td className={`py-1.5 text-right font-medium ${pctClass(t.variancePct)}`}>
                        {t.variancePct > 0 ? "+" : ""}{t.variancePct.toFixed(1)}%
                      </td>
                      <td className="py-1.5 text-right text-gray-500">{t.flights}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
