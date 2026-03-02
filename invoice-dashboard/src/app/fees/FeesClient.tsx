"use client";

import { useState, useEffect, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";

/* ── types ──────────────────────────────────────────── */
interface CategorySummary {
  name: string;
  count: number;
  total: number;
  max: number;
  avg: number;
}

interface AirportRow {
  airport: string;
  fbo: string;
  count: number;
  total: number;
  max: number;
  avg: number;
  maxVendor: string;
}

interface MonthlyPoint {
  month: string;
  total: number;
}

interface AirportCategory {
  category: string;
  count: number;
  total: number;
  max: number;
  avg: number;
  maxVendor: string;
}

interface VendorRow {
  vendor: string;
  count: number;
  total: number;
}

/* ── helpers ────────────────────────────────────────── */
const fmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const COLORS = [
  "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#059669",
  "#0891b2", "#4f46e5", "#c026d3", "#d97706", "#0d9488",
  "#6366f1", "#e11d48", "#65a30d", "#0284c7", "#9333ea",
];

/* ── component ──────────────────────────────────────── */
export default function FeesClient() {
  const [view, setView] = useState<"category" | "airport">("category");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Summary data
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [airports, setAirports] = useState<string[]>([]);
  const [months, setMonths] = useState<string[]>([]);
  const [totalRows, setTotalRows] = useState(0);

  // Filters
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedAirport, setSelectedAirport] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");

  // Drill-down data
  const [categoryData, setCategoryData] = useState<{
    byAirport: AirportRow[];
    monthlyTrend: MonthlyPoint[];
  } | null>(null);
  const [airportData, setAirportData] = useState<{
    byCategory: AirportCategory[];
    topVendors: VendorRow[];
  } | null>(null);

  // Load summary
  useEffect(() => {
    setLoading(true);
    fetch("/api/fees?view=summary", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) throw new Error(d.error);
        setCategories(d.categories);
        setAirports(d.airports);
        setMonths(d.months);
        setTotalRows(d.totalRows);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Load category drill-down
  const loadCategoryView = useCallback(
    (cat: string, month: string) => {
      if (!cat) {
        setCategoryData(null);
        return;
      }
      const params = new URLSearchParams({ view: "by-category", category: cat });
      if (month) params.set("month", month);
      fetch(`/api/fees?${params}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (!d.ok) throw new Error(d.error);
          setCategoryData({ byAirport: d.byAirport, monthlyTrend: d.monthlyTrend });
        })
        .catch((e) => setError(String(e)));
    },
    [],
  );

  // Load airport drill-down
  const loadAirportView = useCallback(
    (apt: string, month: string) => {
      if (!apt) {
        setAirportData(null);
        return;
      }
      const params = new URLSearchParams({ view: "by-airport", airport: apt });
      if (month) params.set("month", month);
      fetch(`/api/fees?${params}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (!d.ok) throw new Error(d.error);
          setAirportData({ byCategory: d.byCategory, topVendors: d.topVendors });
        })
        .catch((e) => setError(String(e)));
    },
    [],
  );

  // Trigger drill-down on filter change
  useEffect(() => {
    if (view === "category" && selectedCategory) {
      loadCategoryView(selectedCategory, selectedMonth);
    }
  }, [view, selectedCategory, selectedMonth, loadCategoryView]);

  useEffect(() => {
    if (view === "airport" && selectedAirport) {
      loadAirportView(selectedAirport, selectedMonth);
    }
  }, [view, selectedAirport, selectedMonth, loadAirportView]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Tab bar + month filter ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          <button
            onClick={() => { setView("category"); setSelectedAirport(""); setAirportData(null); }}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              view === "category" ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            By Fee Category
          </button>
          <button
            onClick={() => { setView("airport"); setSelectedCategory(""); setCategoryData(null); }}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              view === "airport" ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            By Airport / FBO
          </button>
        </div>

        <select
          value={selectedMonth}
          onChange={(e) => setSelectedMonth(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All months</option>
          {months.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        <span className="ml-auto text-xs text-gray-400">
          {totalRows.toLocaleString()} expense records
        </span>
      </div>

      {/* ── Category view ── */}
      {view === "category" && (
        <div className="space-y-6">
          {/* Category selector cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {categories.map((cat) => (
              <button
                key={cat.name}
                onClick={() => setSelectedCategory(cat.name === selectedCategory ? "" : cat.name)}
                className={`rounded-xl border p-3 text-left transition-all ${
                  selectedCategory === cat.name
                    ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200"
                    : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm"
                }`}
              >
                <div className="text-xs font-medium text-gray-500 truncate">{cat.name}</div>
                <div className="mt-1 text-lg font-semibold text-gray-900">{fmt(cat.total)}</div>
                <div className="mt-0.5 text-xs text-gray-400">
                  {cat.count} records · max {fmt(cat.max)}
                </div>
              </button>
            ))}
          </div>

          {/* Drill-down: selected category */}
          {selectedCategory && categoryData && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">
                {selectedCategory} — Top Locations
              </h2>

              {/* Bar chart */}
              {categoryData.byAirport.length > 0 && (
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <h3 className="text-sm font-medium text-gray-600 mb-3">
                    Total spend by airport (top 15)
                  </h3>
                  <ResponsiveContainer width="100%" height={350}>
                    <BarChart
                      data={categoryData.byAirport.slice(0, 15)}
                      margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="airport" tick={{ fontSize: 12 }} />
                      <YAxis
                        tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                        tick={{ fontSize: 12 }}
                      />
                      <Tooltip
                        formatter={(value) => [fmt(Number(value ?? 0)), "Total"]}
                        contentStyle={{ borderRadius: 8, fontSize: 13 }}
                      />
                      <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                        {categoryData.byAirport.slice(0, 15).map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Monthly trend */}
              {categoryData.monthlyTrend.length > 1 && (
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <h3 className="text-sm font-medium text-gray-600 mb-3">Monthly trend</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart
                      data={categoryData.monthlyTrend}
                      margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis
                        tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                        tick={{ fontSize: 12 }}
                      />
                      <Tooltip
                        formatter={(value) => [fmt(Number(value ?? 0)), "Total"]}
                        contentStyle={{ borderRadius: 8, fontSize: 13 }}
                      />
                      <Bar dataKey="total" fill="#2563eb" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Table */}
              <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <th className="px-4 py-3">Rank</th>
                      <th className="px-4 py-3">Airport</th>
                      <th className="px-4 py-3">FBO</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Avg</th>
                      <th className="px-4 py-3 text-right">Max</th>
                      <th className="px-4 py-3">Highest from</th>
                      <th className="px-4 py-3 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryData.byAirport.map((row, i) => (
                      <tr key={row.airport} className="border-t hover:bg-gray-50">
                        <td className="px-4 py-2.5 text-gray-400 font-mono text-xs">{i + 1}</td>
                        <td className="px-4 py-2.5 font-semibold text-gray-900">{row.airport}</td>
                        <td className="px-4 py-2.5 text-gray-600">{row.fbo || "—"}</td>
                        <td className="px-4 py-2.5 text-right font-semibold">{fmt(row.total)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-500">{fmt(row.avg)}</td>
                        <td className="px-4 py-2.5 text-right text-red-600 font-medium">{fmt(row.max)}</td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{row.maxVendor}</td>
                        <td className="px-4 py-2.5 text-right text-gray-400">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {selectedCategory && !categoryData && (
            <div className="flex justify-center py-10">
              <div className="animate-spin h-6 w-6 border-4 border-blue-500 border-t-transparent rounded-full" />
            </div>
          )}
        </div>
      )}

      {/* ── Airport view ── */}
      {view === "airport" && (
        <div className="space-y-6">
          <div>
            <select
              value={selectedAirport}
              onChange={(e) => setSelectedAirport(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm w-64"
            >
              <option value="">Select an airport...</option>
              {airports.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>

          {selectedAirport && airportData && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">
                {selectedAirport} — Fee Breakdown
              </h2>

              {/* Bar chart by category */}
              {airportData.byCategory.length > 0 && (
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <h3 className="text-sm font-medium text-gray-600 mb-3">
                    Spend by fee type
                  </h3>
                  <ResponsiveContainer width="100%" height={350}>
                    <BarChart
                      data={airportData.byCategory.slice(0, 15)}
                      layout="vertical"
                      margin={{ top: 5, right: 20, bottom: 5, left: 120 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis
                        type="number"
                        tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                        tick={{ fontSize: 12 }}
                      />
                      <YAxis
                        type="category"
                        dataKey="category"
                        tick={{ fontSize: 11 }}
                        width={115}
                      />
                      <Tooltip
                        formatter={(value) => [fmt(Number(value ?? 0)), "Total"]}
                        contentStyle={{ borderRadius: 8, fontSize: 13 }}
                      />
                      <Bar dataKey="total" radius={[0, 4, 4, 0]}>
                        {airportData.byCategory.slice(0, 15).map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Fee categories table */}
              <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <h3 className="text-sm font-medium text-gray-600 px-4 pt-4 pb-2">
                  All fees at {selectedAirport}
                </h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <th className="px-4 py-3">Fee Type</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Avg</th>
                      <th className="px-4 py-3 text-right">Max</th>
                      <th className="px-4 py-3">Highest Vendor</th>
                      <th className="px-4 py-3 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {airportData.byCategory.map((row) => (
                      <tr key={row.category} className="border-t hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-medium text-gray-900">{row.category}</td>
                        <td className="px-4 py-2.5 text-right font-semibold">{fmt(row.total)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-500">{fmt(row.avg)}</td>
                        <td className="px-4 py-2.5 text-right text-red-600 font-medium">{fmt(row.max)}</td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{row.maxVendor}</td>
                        <td className="px-4 py-2.5 text-right text-gray-400">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Top vendors */}
              {airportData.topVendors.length > 0 && (
                <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                  <h3 className="text-sm font-medium text-gray-600 px-4 pt-4 pb-2">
                    Top vendors at {selectedAirport}
                  </h3>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        <th className="px-4 py-3">Vendor</th>
                        <th className="px-4 py-3 text-right">Total</th>
                        <th className="px-4 py-3 text-right">Transactions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {airportData.topVendors.map((v) => (
                        <tr key={v.vendor} className="border-t hover:bg-gray-50">
                          <td className="px-4 py-2.5 font-medium text-gray-900">{v.vendor}</td>
                          <td className="px-4 py-2.5 text-right font-semibold">{fmt(v.total)}</td>
                          <td className="px-4 py-2.5 text-right text-gray-400">{v.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {selectedAirport && !airportData && (
            <div className="flex justify-center py-10">
              <div className="animate-spin h-6 w-6 border-4 border-blue-500 border-t-transparent rounded-full" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
