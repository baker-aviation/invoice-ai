"use client";

import { useEffect, useState } from "react";

type Stats = {
  totals: { today: number; last7d: number; last30d: number };
  successRateToday: number | null;
  avgLatencyMsToday: number | null;
  topCallersToday: Array<{ caller: string; count: number }>;
  recent: Array<{
    called_at: string;
    endpoint: string;
    origin: string | null;
    destination: string | null;
    flight_date: string | null;
    caller: string | null;
    http_ok: boolean;
    result_count: number;
    latency_ms: number;
    error: string | null;
  }>;
};

export default function HasDataStatsClient() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/integrations/hasdata-stats")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setStats(d);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!stats) return null;

  const successPct = stats.successRateToday != null ? (stats.successRateToday * 100).toFixed(0) + "%" : "—";

  return (
    <div className="space-y-4">
      {/* Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatBox label="Today" value={stats.totals.today.toLocaleString()} />
        <StatBox label="Last 7d" value={stats.totals.last7d.toLocaleString()} />
        <StatBox label="Last 30d" value={stats.totals.last30d.toLocaleString()} />
        <StatBox label="Success (24h)" value={successPct} />
        <StatBox label="Avg latency (24h)" value={stats.avgLatencyMsToday != null ? `${stats.avgLatencyMsToday} ms` : "—"} />
      </div>

      {/* Top callers */}
      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="px-4 py-2 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-900">Top Callers (Today)</h3>
        </div>
        <div className="px-4 py-2">
          {stats.topCallersToday.length === 0 ? (
            <p className="text-sm text-slate-500">No calls today.</p>
          ) : (
            <ul className="space-y-1">
              {stats.topCallersToday.map((c) => (
                <li key={c.caller} className="flex justify-between text-sm">
                  <span className="font-mono text-slate-700">{c.caller}</span>
                  <span className="text-slate-500">{c.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Recent calls */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="px-4 py-2 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-900">Recent Calls</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Time</th>
                <th className="text-left px-3 py-2">Route</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Caller</th>
                <th className="text-right px-3 py-2">Results</th>
                <th className="text-right px-3 py-2">Latency</th>
                <th className="text-center px-3 py-2">OK</th>
              </tr>
            </thead>
            <tbody>
              {stats.recent.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-600">{new Date(r.called_at).toLocaleTimeString()}</td>
                  <td className="px-3 py-1.5 text-slate-800 font-mono">{r.origin}→{r.destination}</td>
                  <td className="px-3 py-1.5 text-slate-600">{r.flight_date}</td>
                  <td className="px-3 py-1.5 text-slate-600 font-mono">{r.caller ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right text-slate-700">{r.result_count}</td>
                  <td className="px-3 py-1.5 text-right text-slate-500">{r.latency_ms} ms</td>
                  <td className="px-3 py-1.5 text-center">
                    {r.http_ok ? (
                      <span className="text-emerald-600">✓</span>
                    ) : (
                      <span className="text-red-600" title={r.error ?? ""}>✗</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}
