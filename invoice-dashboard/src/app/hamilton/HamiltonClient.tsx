"use client";

import { useState, useEffect, useCallback } from "react";

interface AgentSummary {
  salesAgentId: string;
  salesAgentName: string | null;
  count: number;
  totalValue: number;
}

interface DeclineTrip {
  id: number;
  hamilton_trip_id: string;
  display_code: string;
  sales_agent_id: string;
  lowest_price: number | null;
  contact_name: string | null;
  contact_company: string | null;
  departure_airport: string | null;
  arrival_airport: string | null;
  departure_date: string | null;
  aircraft_category: string | null;
  pax: number | null;
  leg_count: number;
}

export default function HamiltonClient() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const today = new Date().toISOString().split("T")[0];

  const [dateFrom, setDateFrom] = useState(thirtyDaysAgo);
  const [dateTo, setDateTo] = useState(today);
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [trips, setTrips] = useState<DeclineTrip[]>([]);
  const [totalDeclines, setTotalDeclines] = useState(0);
  const [loading, setLoading] = useState(true);
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});

  const loadData = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (agentFilter) params.set("agentId", agentFilter);
    params.set("limit", "200");

    const res = await fetch(`/api/hamilton/declines?${params}`);
    if (res.ok) {
      const data = await res.json();
      setAgents(data.agentSummary ?? []);
      setTrips(data.trips ?? []);
      setTotalDeclines(data.totalDeclines ?? 0);

      const names: Record<string, string> = {};
      for (const a of data.agentSummary ?? []) {
        if (a.salesAgentName) names[a.salesAgentId] = a.salesAgentName;
      }
      setAgentNames((prev) => ({ ...prev, ...names }));
    }
    setLoading(false);
  }, [dateFrom, dateTo, agentFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const totalValue = agents.reduce((s, a) => s + a.totalValue, 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Date range + agent filter */}
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">
            From
          </label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">
            To
          </label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">
            Sales Agent
          </label>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All Agents</option>
            {agents.map((a) => (
              <option key={a.salesAgentId} value={a.salesAgentId}>
                {a.salesAgentName ?? a.salesAgentId.substring(0, 8)}
              </option>
            ))}
          </select>
        </div>
        <div className="text-sm text-slate-500">
          {loading ? "Loading..." : `${totalDeclines} declined trips`}
        </div>
      </div>

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">Total Declines</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            {totalDeclines.toLocaleString()}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">Total Declined Value</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            ${Math.round(totalValue).toLocaleString()}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">Avg Trip Value</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            ${totalDeclines > 0 ? Math.round(totalValue / totalDeclines).toLocaleString() : 0}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">Sales Agents</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            {agents.length}
          </p>
        </div>
      </div>

      {/* Agent breakdown */}
      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-6">
        <h3 className="mb-4 text-lg font-semibold text-slate-900">
          Declines by Sales Agent
        </h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase text-slate-500">
              <th className="pb-2">Agent</th>
              <th className="pb-2 text-right">Declines</th>
              <th className="pb-2 text-right">Total Value</th>
              <th className="pb-2 text-right">Avg Value</th>
              <th className="pb-2 text-right">% of Total</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr
                key={a.salesAgentId}
                className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${agentFilter === a.salesAgentId ? "bg-blue-50" : ""}`}
                onClick={() =>
                  setAgentFilter(
                    agentFilter === a.salesAgentId ? "" : a.salesAgentId,
                  )
                }
              >
                <td className="py-2.5 font-medium text-slate-900">
                  {a.salesAgentName ??
                    a.salesAgentId.substring(0, 8) + "..."}
                </td>
                <td className="py-2.5 text-right text-slate-700">
                  {a.count}
                </td>
                <td className="py-2.5 text-right text-slate-700">
                  ${Math.round(a.totalValue).toLocaleString()}
                </td>
                <td className="py-2.5 text-right text-slate-500">
                  $
                  {a.count > 0
                    ? Math.round(a.totalValue / a.count).toLocaleString()
                    : 0}
                </td>
                <td className="py-2.5 text-right text-slate-500">
                  {totalDeclines > 0
                    ? ((a.count / totalDeclines) * 100).toFixed(1)
                    : 0}
                  %
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recent trips table */}
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h3 className="mb-4 text-lg font-semibold text-slate-900">
          Recent Declined Trips
          {agentFilter && agentNames[agentFilter] && (
            <span className="ml-2 text-sm font-normal text-slate-500">
              — {agentNames[agentFilter]}
            </span>
          )}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase text-slate-500">
                <th className="pb-2">Code</th>
                <th className="pb-2">Departure</th>
                <th className="pb-2">Route</th>
                <th className="pb-2">Category</th>
                <th className="pb-2">Pax</th>
                <th className="pb-2">Contact</th>
                <th className="pb-2">Company</th>
                <th className="pb-2 text-right">Price</th>
                <th className="pb-2">Agent</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => (
                <tr
                  key={t.hamilton_trip_id}
                  className="border-b border-slate-100"
                >
                  <td className="py-2 font-mono text-xs text-slate-600">
                    {t.display_code}
                  </td>
                  <td className="py-2 text-slate-700">
                    {t.departure_date
                      ? new Date(t.departure_date).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="py-2 text-slate-700">
                    {t.departure_airport && t.arrival_airport
                      ? `${t.departure_airport} → ${t.arrival_airport}`
                      : "—"}
                  </td>
                  <td className="py-2 text-slate-500 text-xs">
                    {t.aircraft_category ?? "—"}
                  </td>
                  <td className="py-2 text-slate-700">{t.pax ?? "—"}</td>
                  <td className="py-2 text-slate-700">
                    {t.contact_name ?? "—"}
                  </td>
                  <td className="py-2 text-slate-500 text-xs">
                    {t.contact_company ?? "—"}
                  </td>
                  <td className="py-2 text-right text-slate-700">
                    {t.lowest_price
                      ? `$${Math.round(t.lowest_price).toLocaleString()}`
                      : "—"}
                  </td>
                  <td className="py-2 text-slate-500 text-xs">
                    {agentNames[t.sales_agent_id] ??
                      t.sales_agent_id?.substring(0, 8)}
                  </td>
                </tr>
              ))}
              {trips.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={9}
                    className="py-8 text-center text-slate-400"
                  >
                    No declined trips found for this date range
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
