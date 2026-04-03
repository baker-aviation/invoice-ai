"use client";

import { useState, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

interface AltitudeProfileProps {
  tail: string;
  origin: string;
  dest: string;
  date: string;
  type?: string;
  actualBurn?: number;
}

interface DataPoint {
  minutesFromDep: number;
  planned?: number;
  actual?: number;
}

interface AttributionItem {
  label: string;
  lbs: number;
  pct: number;
  detail: string;
}

interface Attribution {
  ffBurn: number;
  actualBurn: number;
  overBurn: number;
  overBurnPct: number;
  items: AttributionItem[];
  totalAttributed: number;
}

export default function AltitudeProfileChart({ tail, origin, dest, date, type, actualBurn }: AltitudeProfileProps) {
  const [data, setData] = useState<DataPoint[] | null>(null);
  const [attribution, setAttribution] = useState<Attribution | null>(null);
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

    fetch(`/api/fuel-planning/altitude-profile?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.hasPlan && !d.hasTrack) {
          setError("No altitude data available for this flight");
          setData(null);
          return;
        }

        // Merge planned and actual into unified timeline
        const timeMap = new Map<number, DataPoint>();

        for (const wp of d.planned ?? []) {
          const t = Math.round(wp.minutesFromDep);
          const existing = timeMap.get(t) ?? { minutesFromDep: t };
          existing.planned = wp.altitudeFl;
          timeMap.set(t, existing);
        }

        const actualPoints = d.actual ?? [];
        const step = Math.max(1, Math.floor(actualPoints.length / 200));
        for (let i = 0; i < actualPoints.length; i += step) {
          const pt = actualPoints[i];
          const t = Math.round(pt.minutesFromDep * 2) / 2;
          const existing = timeMap.get(t) ?? { minutesFromDep: t };
          existing.actual = pt.altitudeFl;
          timeMap.set(t, existing);
        }
        if (actualPoints.length > 0) {
          const last = actualPoints[actualPoints.length - 1];
          const t = Math.round(last.minutesFromDep * 2) / 2;
          const existing = timeMap.get(t) ?? { minutesFromDep: t };
          existing.actual = last.altitudeFl;
          timeMap.set(t, existing);
        }

        setData([...timeMap.values()].sort((a, b) => a.minutesFromDep - b.minutesFromDep));
        setMaxAlt(Math.ceil(Math.max(d.maxPlannedAlt ?? 0, d.maxActualAlt ?? 0, 100) / 50) * 50 + 50);
        setAttribution(d.attribution ?? null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [tail, origin, dest, date, type, actualBurn]);

  if (loading) return <div className="py-4 text-xs text-gray-400 text-center">Loading altitude profile...</div>;
  if (error) return <div className="py-3 text-xs text-gray-400 text-center">{error}</div>;
  if (!data?.length) return null;

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
        </div>
      </div>

      {/* Altitude chart */}
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="minutesFromDep"
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickFormatter={(v) => { const h = Math.floor(v / 60); const m = Math.round(v % 60); return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}m`; }}
          />
          <YAxis domain={[0, maxAlt]} tick={{ fontSize: 10, fill: "#9ca3af" }} tickFormatter={(v) => `FL${v}`} width={42} />
          <Tooltip
            contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e5e7eb" }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={((v: any, name: any) => [`FL${v}`, name === "planned" ? "FF Planned" : "ADS-B Actual"]) as any}
            labelFormatter={(v) => { const h = Math.floor(Number(v) / 60); const m = Math.round(Number(v) % 60); return `T+${h > 0 ? `${h}h ${m}m` : `${m}m`}`; }}
          />
          <Line type="stepAfter" dataKey="planned" stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls />
          <Line type="monotone" dataKey="actual" stroke="#ef4444" strokeWidth={1.5} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>

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
                      item.label === "Climb" ? "bg-red-400" :
                      item.label === "Altitude" ? "bg-amber-400" :
                      item.label === "Descent" ? "bg-orange-400" :
                      "bg-gray-400"
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

          {attribution.items.length === 0 && Math.abs(attribution.overBurn) < 50 && (
            <p className="text-xs text-green-600">Flight matched plan closely — no significant deviations.</p>
          )}
        </div>
      )}
    </div>
  );
}
