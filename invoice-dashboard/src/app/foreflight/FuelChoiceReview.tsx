"use client";

import { useState, useEffect, useMemo } from "react";

interface FuelChoice {
  id: number;
  jetinsight_trip_id: string;
  airport_code: string;
  fbo_name: string;
  fuel_vendor: string;
  volume_tier: string;
  price_per_gallon: number;
  tail_number: string | null;
  salesperson: string | null;
  flight_date: string | null;
  best_price_at_fbo: number | null;
  best_vendor_at_fbo: string | null;
  best_price_at_airport: number | null;
  best_vendor_at_airport: string | null;
  overpay_vs_fbo: number | null;
  overpay_vs_airport: number | null;
}

interface Summary {
  totalChoices: number;
  choicesWithOverpay: number;
  avgOverpayPerGalFbo: number;
  avgOverpayPerGalAirport: number;
}

function fmt$(n: number): string {
  return "$" + n.toFixed(2);
}

function fmtPpg(n: number): string {
  return "$" + n.toFixed(4);
}

function stripK(code: string): string {
  return code.length === 4 && code.startsWith("K") ? code.slice(1) : code;
}

export default function FuelChoiceReview() {
  const [loading, setLoading] = useState(true);
  const [choices, setChoices] = useState<FuelChoice[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/fuel-planning/fuel-choice-review?days=${days}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load");
        return;
      }
      setChoices(data.choices ?? []);
      setSummary(data.summary ?? null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [days]);

  const handleSync = async () => {
    if (!window.confirm(`Sync fuel choices from JetInsight trip notes for the last ${days} days?`)) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`/api/cron/jetinsight-fuel-choices?days=${days}`);
      const data = await res.json();
      if (data.ok) {
        setSyncResult(`Scraped ${data.tripsScraped} trips, found ${data.fuelChoicesFound} fuel choices, inserted ${data.inserted}`);
        fetchData(); // Refresh
      } else {
        setSyncResult(`Error: ${data.errors?.[0] ?? "Unknown"}`);
      }
    } catch (err) {
      setSyncResult(String(err));
    } finally {
      setSyncing(false);
    }
  };

  // Sort: overpays first, biggest first
  const sorted = useMemo(() =>
    [...choices].sort((a, b) => (b.overpay_vs_fbo ?? 0) - (a.overpay_vs_fbo ?? 0)),
  [choices]);

  const overpays = sorted.filter((c) => (c.overpay_vs_fbo ?? 0) > 0.01);
  const optimal = sorted.filter((c) => (c.overpay_vs_fbo ?? 0) <= 0.01);

  return (
    <div className="px-6 py-4 space-y-5 max-w-7xl mx-auto">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Period</label>
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value={3}>Last 3 days</option>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="px-4 py-2 bg-gray-100 border border-gray-300 text-sm font-medium rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          {syncing ? "Syncing..." : "Sync Trip Notes"}
        </button>
        {syncResult && (
          <span className="text-sm text-gray-600">{syncResult}</span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading && (
        <div className="text-center py-12 text-gray-400">Loading fuel choice data...</div>
      )}

      {!loading && choices.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-12 text-center">
          <p className="text-gray-500 text-sm">No fuel choices found. Click &ldquo;Sync Trip Notes&rdquo; to pull data from JetInsight.</p>
        </div>
      )}

      {/* Summary */}
      {summary && choices.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <h3 className="text-lg font-semibold text-gray-900 mb-3">Fuel Choice Analysis</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="rounded-lg bg-gray-50 p-3 text-center">
              <div className="text-2xl font-bold text-gray-900">{summary.totalChoices}</div>
              <div className="text-xs text-gray-500">Total Fuel Stops</div>
            </div>
            <div className="rounded-lg bg-red-50 p-3 text-center">
              <div className="text-2xl font-bold text-red-600">{summary.choicesWithOverpay}</div>
              <div className="text-xs text-red-500">Suboptimal Choices</div>
            </div>
            <div className="rounded-lg bg-amber-50 p-3 text-center">
              <div className="text-2xl font-bold text-amber-600">
                {summary.avgOverpayPerGalFbo > 0 ? fmtPpg(summary.avgOverpayPerGalFbo) : "—"}
              </div>
              <div className="text-xs text-amber-500">Avg Overpay/gal (vs FBO best)</div>
            </div>
            <div className="rounded-lg bg-blue-50 p-3 text-center">
              <div className="text-2xl font-bold text-blue-600">
                {summary.avgOverpayPerGalAirport > 0 ? fmtPpg(summary.avgOverpayPerGalAirport) : "—"}
              </div>
              <div className="text-xs text-blue-500">Avg Overpay/gal (vs Airport best)</div>
            </div>
          </div>
        </div>
      )}

      {/* Overpays */}
      {overpays.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-red-600 uppercase tracking-wide mb-2">
            Suboptimal Fuel Choices ({overpays.length})
          </h3>
          <div className="rounded-lg border border-red-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-red-50 text-left text-xs text-red-600 border-b border-red-200">
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Tail</th>
                  <th className="px-4 py-2">Rep</th>
                  <th className="px-4 py-2">Airport</th>
                  <th className="px-4 py-2">FBO</th>
                  <th className="px-4 py-2">Vendor Picked</th>
                  <th className="px-4 py-2 text-right">Price</th>
                  <th className="px-4 py-2">Best at FBO</th>
                  <th className="px-4 py-2 text-right">Best Price</th>
                  <th className="px-4 py-2 text-right">Overpay/gal</th>
                </tr>
              </thead>
              <tbody>
                {overpays.map((c) => (
                  <tr key={c.id} className="border-b border-gray-100 hover:bg-red-50/30">
                    <td className="px-4 py-2.5 text-gray-600">{c.flight_date ?? "—"}</td>
                    <td className="px-4 py-2.5 font-medium text-gray-900">{c.tail_number ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-600 text-xs">{c.salesperson ?? "—"}</td>
                    <td className="px-4 py-2.5 font-mono font-medium">{stripK(c.airport_code)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{c.fbo_name}</td>
                    <td className="px-4 py-2.5">
                      <span className="text-gray-700">{c.fuel_vendor}</span>
                      <span className="text-gray-400 text-xs ml-1">{c.volume_tier}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-red-600 font-semibold">
                      {fmtPpg(c.price_per_gallon)}
                    </td>
                    <td className="px-4 py-2.5 text-green-700 text-xs">
                      {c.best_vendor_at_fbo ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-green-600 font-semibold">
                      {c.best_price_at_fbo != null ? fmtPpg(c.best_price_at_fbo) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="font-mono font-bold text-red-600">
                        +{fmtPpg(c.overpay_vs_fbo ?? 0)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Optimal choices */}
      {optimal.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-green-600 uppercase tracking-wide mb-2">
            Optimal / Near-Optimal ({optimal.length})
          </h3>
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs text-gray-500 border-b border-gray-200">
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Tail</th>
                  <th className="px-4 py-2">Rep</th>
                  <th className="px-4 py-2">Airport</th>
                  <th className="px-4 py-2">FBO</th>
                  <th className="px-4 py-2">Vendor</th>
                  <th className="px-4 py-2 text-right">Price</th>
                  <th className="px-4 py-2 text-right">Airport Best</th>
                  <th className="px-4 py-2 text-right">vs Airport</th>
                </tr>
              </thead>
              <tbody>
                {optimal.map((c) => (
                  <tr key={c.id} className="border-b border-gray-50">
                    <td className="px-4 py-2.5 text-gray-600">{c.flight_date ?? "—"}</td>
                    <td className="px-4 py-2.5 font-medium text-gray-900">{c.tail_number ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-600 text-xs">{c.salesperson ?? "—"}</td>
                    <td className="px-4 py-2.5 font-mono font-medium">{stripK(c.airport_code)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{c.fbo_name}</td>
                    <td className="px-4 py-2.5">
                      <span className="text-gray-700">{c.fuel_vendor}</span>
                      <span className="text-gray-400 text-xs ml-1">{c.volume_tier}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-green-600 font-semibold">
                      {fmtPpg(c.price_per_gallon)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-500">
                      {c.best_price_at_airport != null ? fmtPpg(c.best_price_at_airport) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {(c.overpay_vs_airport ?? 0) > 0.01 ? (
                        <span className="font-mono text-amber-500 text-xs">
                          +{fmtPpg(c.overpay_vs_airport ?? 0)} vs diff FBO
                        </span>
                      ) : (
                        <span className="text-green-500 text-xs">Best available</span>
                      )}
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
}
