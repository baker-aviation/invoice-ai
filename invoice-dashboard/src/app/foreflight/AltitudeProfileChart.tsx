"use client";

import { useState, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

interface AltitudeProfileProps {
  tail: string;
  origin: string;
  dest: string;
  date: string;
  type?: string;
  actualBurn?: number;
  flightHrs?: number;
}

interface DataPoint { minutesFromDep: number; planned?: number; actual?: number }
interface AttributionItem { label: string; lbs: number; pct: number; detail: string }
interface Attribution { ffBurn: number; actualBurn: number; overBurn: number; overBurnPct: number; items: AttributionItem[]; totalAttributed: number }
interface AltSegment {
  altitudeFl: number; startMin: number; endMin: number; durationMin: number;
  phase: string; altDeltaFromOptimal: number; fuelPenaltyLbs: number; pilotChoice: boolean;
}
interface SegmentsSummary {
  segments: AltSegment[];
  timeToFirstCruise: number | null; initialCruiseAlt: number | null; maxCruiseAlt: number | null;
  stepClimbCount: number; totalCruiseMin: number; timeAtOptimalMin: number; timeAtOptimalPct: number;
  timeBelowOptimalMin: number; totalSubOptimalPenaltyLbs: number;
  levelOffs: Array<{ altitudeFl: number; durationMin: number }>;
}

// Color by altitude relative to optimal
function altColor(fl: number, optimal: number): string {
  const delta = fl - optimal;
  if (delta >= 0) return "bg-green-500";
  if (delta >= -20) return "bg-green-300";
  if (delta >= -40) return "bg-yellow-400";
  if (delta >= -60) return "bg-orange-400";
  return "bg-gray-400";
}
function altTextColor(fl: number, optimal: number): string {
  const delta = fl - optimal;
  if (delta >= 0) return "text-green-700";
  if (delta >= -20) return "text-green-600";
  if (delta >= -40) return "text-amber-600";
  return "text-orange-600";
}

export default function AltitudeProfileChart({ tail, origin, dest, date, type, actualBurn, flightHrs }: AltitudeProfileProps) {
  const [data, setData] = useState<DataPoint[] | null>(null);
  const [attribution, setAttribution] = useState<Attribution | null>(null);
  const [segments, setSegments] = useState<SegmentsSummary | null>(null);
  const [optimalAlt, setOptimalAlt] = useState(470);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [maxAlt, setMaxAlt] = useState(500);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ tail, date });
    if (origin) params.set("origin", origin);
    if (dest) params.set("dest", dest);
    if (type) params.set("type", type);
    if (actualBurn) params.set("actualBurn", String(Math.round(actualBurn)));
    if (flightHrs) params.set("flightHrs", String(flightHrs));

    fetch(`/api/fuel-planning/altitude-profile?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.hasPlan && !d.hasTrack) { setError("No altitude data available"); setData(null); return; }

        const timeMap = new Map<number, DataPoint>();
        for (const wp of d.planned ?? []) {
          const t = Math.round(wp.minutesFromDep);
          timeMap.set(t, { ...timeMap.get(t), minutesFromDep: t, planned: wp.altitudeFl });
        }
        const actualPoints = d.actual ?? [];
        const step = Math.max(1, Math.floor(actualPoints.length / 200));
        for (let i = 0; i < actualPoints.length; i += step) {
          const pt = actualPoints[i];
          const t = Math.round(pt.minutesFromDep * 2) / 2;
          timeMap.set(t, { ...timeMap.get(t), minutesFromDep: t, actual: pt.altitudeFl });
        }
        if (actualPoints.length > 0) {
          const last = actualPoints[actualPoints.length - 1];
          const t = Math.round(last.minutesFromDep * 2) / 2;
          timeMap.set(t, { ...timeMap.get(t), minutesFromDep: t, actual: last.altitudeFl });
        }

        setData([...timeMap.values()].sort((a, b) => a.minutesFromDep - b.minutesFromDep));
        setMaxAlt(Math.ceil(Math.max(d.maxPlannedAlt ?? 0, d.maxActualAlt ?? 0, 100) / 50) * 50 + 50);
        setAttribution(d.attribution ?? null);
        setSegments(d.segments ?? null);
        setOptimalAlt(d.optimalAlt ?? 470);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [tail, origin, dest, date, type, actualBurn]);

  if (loading) return <div className="py-4 text-xs text-gray-400 text-center">Loading altitude profile...</div>;
  if (error) return <div className="py-3 text-xs text-gray-400 text-center">{error}</div>;
  if (!data?.length) return null;

  const cruiseSegments = segments?.segments.filter((s) => s.phase === "cruise") ?? [];
  const totalFlightMin = data[data.length - 1]?.minutesFromDep ?? 1;

  return (
    <div className="mt-2 mb-1 rounded-md border border-gray-200 bg-gray-50 p-3">
      {/* Chart header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-600">{origin} → {dest}</span>
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-2 border-dashed border-blue-500" /> FF Planned
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-2 border-red-500" /> ADS-B Actual
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-2 border-dashed border-green-500" /> Optimal FL{optimalAlt}
          </span>
        </div>
      </div>

      {/* Altitude chart */}
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="minutesFromDep" tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickFormatter={(v) => { const h = Math.floor(v / 60); const m = Math.round(v % 60); return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}m`; }} />
          <YAxis domain={[0, maxAlt]} tick={{ fontSize: 10, fill: "#9ca3af" }} tickFormatter={(v) => `FL${v}`} width={42} />
          <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e5e7eb" }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={((v: any, name: any) => [`FL${v}`, name === "planned" ? "FF Planned" : "ADS-B Actual"]) as any}
            labelFormatter={(v) => { const h = Math.floor(Number(v) / 60); const m = Math.round(Number(v) % 60); return `T+${h > 0 ? `${h}h ${m}m` : `${m}m`}`; }} />
          <ReferenceLine y={optimalAlt} stroke="#22c55e" strokeDasharray="4 4" strokeWidth={1} />
          <Line type="monotone" dataKey="planned" stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls />
          <Line type="monotone" dataKey="actual" stroke="#ef4444" strokeWidth={1.5} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>

      {/* Segment timeline (Gantt bar) */}
      {cruiseSegments.length > 0 && (
        <div className="mt-3">
          <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Cruise Altitude Segments</p>
          <div className="flex h-6 rounded overflow-hidden bg-gray-200 relative">
            {segments!.segments.filter((s) => s.durationMin >= 1).map((seg, i) => {
              const widthPct = (seg.durationMin / totalFlightMin) * 100;
              const leftPct = (seg.startMin / totalFlightMin) * 100;
              if (widthPct < 1) return null;
              const isClimb = seg.phase === "climb" || seg.phase === "level-off";
              const isDescent = seg.phase === "descent";
              const bgColor = isClimb ? "bg-red-300" : isDescent ? "bg-amber-300" : altColor(seg.altitudeFl, optimalAlt);
              return (
                <div key={i} className={`absolute h-full ${bgColor} border-r border-white/50 flex items-center justify-center overflow-hidden`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={`FL${seg.altitudeFl} — ${seg.durationMin}m (${seg.phase})`}>
                  {widthPct > 6 && (
                    <span className="text-[9px] font-medium text-white drop-shadow-sm truncate px-0.5">
                      {seg.phase === "cruise" ? `FL${seg.altitudeFl}` : seg.phase === "climb" ? "↑" : "↓"}
                      {widthPct > 12 && ` ${Math.round(seg.durationMin)}m`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Segment summary stats */}
          <div className="mt-2 flex items-center gap-4 text-xs">
            <div>
              <span className="text-gray-400">Optimal time: </span>
              <span className={`font-medium ${segments!.timeAtOptimalPct >= 70 ? "text-green-600" : segments!.timeAtOptimalPct >= 40 ? "text-amber-600" : "text-red-600"}`}>
                {segments!.timeAtOptimalPct}% ({Math.round(segments!.timeAtOptimalMin)}m of {Math.round(segments!.totalCruiseMin)}m)
              </span>
            </div>
            {segments!.stepClimbCount > 0 && (
              <div>
                <span className="text-gray-400">Step climbs: </span>
                <span className="font-medium">{segments!.stepClimbCount}</span>
              </div>
            )}
            {segments!.totalSubOptimalPenaltyLbs > 0 && (
              <div>
                <span className="text-gray-400">Alt penalty: </span>
                <span className="font-medium text-red-600">+{segments!.totalSubOptimalPenaltyLbs} lbs</span>
              </div>
            )}
            {segments!.levelOffs.length > 0 && (
              <div>
                <span className="text-gray-400">Level-offs: </span>
                <span className="font-medium">{segments!.levelOffs.map((l) => `FL${l.altitudeFl} (${Math.round(l.durationMin)}m)`).join(", ")}</span>
              </div>
            )}
          </div>

          {/* Cruise segment detail table */}
          {cruiseSegments.length > 1 && (
            <div className="mt-2">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-200">
                    <th className="pb-0.5 font-medium">Altitude</th>
                    <th className="pb-0.5 font-medium">Duration</th>
                    <th className="pb-0.5 font-medium">vs Optimal</th>
                    <th className="pb-0.5 font-medium">Fuel Penalty</th>
                    <th className="pb-0.5 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {cruiseSegments.map((seg, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className={`py-1 font-medium ${altTextColor(seg.altitudeFl, optimalAlt)}`}>FL{seg.altitudeFl}</td>
                      <td className="py-1">{Math.round(seg.durationMin)}m</td>
                      <td className="py-1">{seg.altDeltaFromOptimal === 0 ? "Optimal" : `${seg.altDeltaFromOptimal > 0 ? "+" : ""}${seg.altDeltaFromOptimal} FL`}</td>
                      <td className={`py-1 ${seg.fuelPenaltyLbs > 0 ? "text-red-600 font-medium" : "text-green-600"}`}>
                        {seg.fuelPenaltyLbs > 0 ? `+${seg.fuelPenaltyLbs} lbs` : "—"}
                      </td>
                      <td className="py-1 text-gray-400">
                        {seg.pilotChoice && seg.altDeltaFromOptimal < -10 ? "Pilot choice (above FL410)" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Attribution breakdown */}
      {attribution && (
        <div className="mt-3 pt-3 border-t border-gray-200">
          <div className="flex items-center gap-6 mb-2">
            <div className="text-xs">
              <span className="text-gray-500">FF Predicted:</span>{" "}
              <span className="font-medium">{attribution.ffBurn.toLocaleString()} lbs</span>
            </div>
            <div className="text-xs">
              <span className="text-gray-500">Actual:</span>{" "}
              <span className="font-medium">{attribution.actualBurn.toLocaleString()} lbs</span>
            </div>
            <div className="text-xs">
              <span className="text-gray-500">Delta:</span>{" "}
              <span className={`font-bold ${attribution.overBurn > 0 ? "text-red-600" : "text-green-600"}`}>
                {attribution.overBurn > 0 ? "+" : ""}{attribution.overBurn.toLocaleString()} lbs ({attribution.overBurnPct > 0 ? "+" : ""}{attribution.overBurnPct}%)
              </span>
            </div>
          </div>
          {attribution.items.length > 0 && (
            <div className="space-y-1.5">
              {attribution.items.map((item, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="flex items-center gap-1.5 min-w-[120px]">
                    <span className={`inline-block w-2 h-2 rounded-full ${
                      item.label === "Climb" ? "bg-red-400" : item.label === "Altitude" ? "bg-amber-400" :
                      item.label === "Descent" ? "bg-orange-400" : "bg-gray-400"
                    }`} />
                    <span className="text-xs font-medium text-gray-700">{item.label}</span>
                    <span className={`text-xs font-bold ${item.lbs > 0 ? "text-red-600" : "text-green-600"}`}>
                      {item.lbs > 0 ? "+" : ""}{item.lbs} lbs
                    </span>
                  </div>
                  <span className="text-[11px] text-gray-500">{item.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
