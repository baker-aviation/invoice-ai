"use client";

import { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";

interface AltitudeProfileProps {
  tail: string;
  origin: string;
  dest: string;
  date: string;
}

interface DataPoint {
  minutesFromDep: number;
  planned?: number;
  actual?: number;
  identifier?: string;
}

export default function AltitudeProfileChart({ tail, origin, dest, date }: AltitudeProfileProps) {
  const [data, setData] = useState<DataPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [maxAlt, setMaxAlt] = useState(500);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/fuel-planning/altitude-profile?tail=${tail}&origin=${origin}&dest=${dest}&date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.hasPlan && !d.hasTrack) {
          setError("No altitude data available for this flight");
          setData(null);
          return;
        }

        // Merge planned and actual into unified timeline
        const timeMap = new Map<number, DataPoint>();

        // Add planned waypoints
        for (const wp of d.planned ?? []) {
          const t = Math.round(wp.minutesFromDep);
          const existing = timeMap.get(t) ?? { minutesFromDep: t };
          existing.planned = wp.altitudeFl;
          existing.identifier = wp.identifier;
          timeMap.set(t, existing);
        }

        // Add actual track points (sample every ~30 sec to avoid overplotting)
        const actualPoints = d.actual ?? [];
        const step = Math.max(1, Math.floor(actualPoints.length / 200)); // max 200 points
        for (let i = 0; i < actualPoints.length; i += step) {
          const pt = actualPoints[i];
          const t = Math.round(pt.minutesFromDep * 2) / 2; // round to nearest 0.5 min
          const existing = timeMap.get(t) ?? { minutesFromDep: t };
          existing.actual = pt.altitudeFl;
          timeMap.set(t, existing);
        }
        // Always include last point
        if (actualPoints.length > 0) {
          const last = actualPoints[actualPoints.length - 1];
          const t = Math.round(last.minutesFromDep * 2) / 2;
          const existing = timeMap.get(t) ?? { minutesFromDep: t };
          existing.actual = last.altitudeFl;
          timeMap.set(t, existing);
        }

        const merged = [...timeMap.values()].sort((a, b) => a.minutesFromDep - b.minutesFromDep);
        setData(merged);

        const ma = Math.max(d.maxPlannedAlt ?? 0, d.maxActualAlt ?? 0, 100);
        setMaxAlt(Math.ceil(ma / 50) * 50 + 50);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [tail, origin, dest, date]);

  if (loading) return <div className="py-4 text-xs text-gray-400 text-center">Loading altitude profile...</div>;
  if (error) return <div className="py-3 text-xs text-gray-400 text-center">{error}</div>;
  if (!data?.length) return null;

  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-600">
          Altitude Profile — {origin} → {dest}
        </span>
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 bg-blue-500 inline-block" style={{ borderTop: "2px dashed #3b82f6" }} /> FF Planned
          </span>
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 bg-red-500 inline-block" /> ADS-B Actual
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="minutesFromDep"
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickFormatter={(v) => { const h = Math.floor(v / 60); const m = Math.round(v % 60); return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}m`; }}
            label={{ value: "Time from departure", position: "insideBottom", offset: -2, fontSize: 10, fill: "#9ca3af" }}
          />
          <YAxis
            domain={[0, maxAlt]}
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickFormatter={(v) => `FL${v}`}
            width={45}
          />
          <Tooltip
            contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e5e7eb" }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={((value: any, name: any) => [`FL${value}`, name === "planned" ? "FF Planned" : "ADS-B Actual"]) as any}
            labelFormatter={(v) => { const h = Math.floor(Number(v) / 60); const m = Math.round(Number(v) % 60); return `T+${h > 0 ? `${h}h ${m}m` : `${m}m`}`; }}
          />
          {/* Planned altitude (dashed blue) */}
          <Line
            type="stepAfter"
            dataKey="planned"
            stroke="#3b82f6"
            strokeWidth={2}
            strokeDasharray="6 3"
            dot={false}
            connectNulls
          />
          {/* Actual altitude (solid red) */}
          <Line
            type="monotone"
            dataKey="actual"
            stroke="#ef4444"
            strokeWidth={1.5}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
