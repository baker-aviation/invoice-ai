"use client";

import { useEffect, useState, useCallback } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

type ServiceHealth = {
  name: string;
  status: "ok" | "error" | "unconfigured";
  latencyMs: number | null;
  error?: string;
};

type PipelineStatus = {
  slug: string;
  name: string;
  lastRun: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  staleMins: number;
  status: "ok" | "warning" | "error" | "unknown";
};

type TableCount = { table: string; count: number | null; error?: string };
type QueueDepth = { queue: string; count: number };

type UserInfo = {
  id: string;
  email: string;
  role: string | null;
  lastSignIn: string | null;
  createdAt: string;
  isSuperAdmin: boolean;
};

type FaHealth = {
  status: string;
  count: number;
  cached: boolean;
  error: string | null;
};

type DashboardData = {
  checked_at: string;
  services: ServiceHealth[];
  pipelines: PipelineStatus[];
  tables: TableCount[];
  users: UserInfo[];
  queues: QueueDepth[];
  flightaware: FaHealth;
};

// ─── Styles ──────────────────────────────────────────────────────────────────

const STATUS = {
  ok: { dot: "bg-emerald-500", bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", label: "Healthy" },
  warning: { dot: "bg-amber-500", bg: "bg-amber-50 border-amber-200", text: "text-amber-700", label: "Stale" },
  error: { dot: "bg-red-500", bg: "bg-red-50 border-red-200", text: "text-red-700", label: "Down" },
  unknown: { dot: "bg-gray-400", bg: "bg-gray-50 border-gray-200", text: "text-gray-500", label: "Unknown" },
  unconfigured: { dot: "bg-gray-300", bg: "bg-gray-50 border-gray-200", text: "text-gray-400", label: "Not configured" },
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-purple-100 text-purple-800",
  dashboard: "bg-slate-100 text-slate-800",
  pilot: "bg-blue-100 text-blue-800",
  van: "bg-orange-100 text-orange-800",
};

const PIPELINE_ENDPOINTS: Record<string, string> = {
  "flight-sync": "/jobs/sync_schedule",
  "edct-pull": "/jobs/pull_edct",
  "notam-check": "/jobs/check_notams",
  "invoice-ingest": "/jobs/pull_mailbox",
  "invoice-parse": "/jobs/parse_next",
  "alert-generation": "/jobs/run_alerts_next",
  "slack-flush": "/jobs/flush_alerts",
  "fuel-price-extract": "/jobs/extract_fuel_prices_next",
  "job-ingest": "/jobs/pull_applicants",
  "job-parse": "/jobs/parse_next",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtAge(mins: number): string {
  if (mins < 0) return "—";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

const QUEUE_LABELS: Record<string, string> = {
  pending_parse: "Invoices Pending Parse",
  pending_alerts: "Alerts Pending Send",
  unacked_ops_alerts: "Unacknowledged Ops Alerts",
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function SuperAdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerResult, setTriggerResult] = useState<{ slug: string; ok: boolean } | null>(null);
  const [roleUpdating, setRoleUpdating] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/super", { cache: "no-store" });
      if (res.status === 403) {
        setError("Access denied. Super admin privileges required.");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(`Failed to load (${res.status})`);
        setLoading(false);
        return;
      }
      const json: DashboardData = await res.json();
      setData(json);
      setError(null);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60_000); // refresh every minute
    return () => clearInterval(id);
  }, [fetchData]);

  async function triggerPipeline(slug: string) {
    setTriggering(slug);
    setTriggerResult(null);
    try {
      const res = await fetch("/api/health/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipeline: slug }),
      });
      setTriggerResult({ slug, ok: res.ok });
      if (res.ok) setTimeout(fetchData, 4000);
    } catch {
      setTriggerResult({ slug, ok: false });
    } finally {
      setTriggering(slug);
      setTimeout(() => { setTriggering(null); setTriggerResult(null); }, 3000);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    setRoleUpdating(userId);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: newRole }),
      });
      if (res.ok) {
        setData((prev) => prev ? {
          ...prev,
          users: prev.users.map((u) => u.id === userId ? { ...u, role: newRole } : u),
        } : prev);
      }
    } finally {
      setRoleUpdating(null);
    }
  }

  if (loading) {
    return (
      <div className="p-6 mx-auto">
        <div className="animate-pulse space-y-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-16 bg-gray-100 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 mx-auto">
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <div className="text-red-700 font-semibold text-lg mb-1">Access Denied</div>
          <div className="text-red-600 text-sm">{error}</div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const servicesOk = data.services.filter((s) => s.status === "ok").length;
  const pipelinesOk = data.pipelines.filter((p) => p.status === "ok").length;
  const overallStatus = data.services.some((s) => s.status === "error") || data.pipelines.some((p) => p.status === "error")
    ? "error"
    : data.pipelines.some((p) => p.status === "warning")
      ? "warning"
      : "ok";
  const overall = STATUS[overallStatus];

  return (
    <div className="p-4 sm:p-6 mx-auto space-y-6">
      {/* Overall Status */}
      <div className={`rounded-xl border p-4 flex items-center justify-between ${overall.bg}`}>
        <div className="flex items-center gap-3">
          <div className={`h-4 w-4 rounded-full ${overall.dot} ${overallStatus !== "ok" ? "animate-pulse" : ""}`} />
          <div>
            <div className={`font-bold text-lg ${overall.text}`}>
              {overallStatus === "ok" ? "All Systems Operational" : overallStatus === "warning" ? "Degraded Performance" : "Issues Detected"}
            </div>
            <div className="text-sm text-gray-500">
              {servicesOk}/{data.services.length} services up · {pipelinesOk}/{data.pipelines.length} pipelines healthy
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Last checked</div>
          <div className="text-sm text-gray-600">{fmtTs(data.checked_at)}</div>
          <button
            onClick={fetchData}
            className="mt-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            Refresh Now
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {data.queues.map((q) => (
          <div key={q.queue} className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="text-2xl font-bold text-gray-900">{fmtNum(q.count)}</div>
            <div className="text-xs text-gray-500 mt-1">{QUEUE_LABELS[q.queue] ?? q.queue}</div>
          </div>
        ))}
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="text-2xl font-bold text-gray-900">{data.users.length}</div>
          <div className="text-xs text-gray-500 mt-1">Total Users</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cloud Run Services */}
        <div>
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Cloud Run Services</h2>
          <div className="space-y-2">
            {data.services.map((svc) => {
              const s = STATUS[svc.status];
              return (
                <div key={svc.name} className="rounded-lg border bg-white p-3 flex items-center justify-between shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
                    <div>
                      <div className="text-sm font-medium text-gray-900">{svc.name}</div>
                      {svc.error && <div className="text-xs text-red-500 truncate max-w-[200px]">{svc.error}</div>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {svc.latencyMs != null && (
                      <span className="text-xs text-gray-400 tabular-nums">{svc.latencyMs}ms</span>
                    )}
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}>
                      {s.label}
                    </span>
                  </div>
                </div>
              );
            })}

            {/* FlightAware API */}
            {data.flightaware && (() => {
              const faStatus = data.flightaware.status === "ok" ? "ok" : data.flightaware.status === "error" ? "error" : "unknown";
              const s = STATUS[faStatus as keyof typeof STATUS];
              return (
                <div className="rounded-lg border bg-white p-3 flex items-center justify-between shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
                    <div>
                      <div className="text-sm font-medium text-gray-900">FlightAware AeroAPI</div>
                      <div className="text-xs text-gray-400">
                        {data.flightaware.count} flights · {data.flightaware.cached ? "cached" : "fresh"}
                      </div>
                    </div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}>
                    {s.label}
                  </span>
                </div>
              );
            })()}
          </div>
        </div>

        {/* Database Tables */}
        <div>
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Database Tables</h2>
          <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Table</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-gray-500">Rows</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.tables.map((t) => (
                  <tr key={t.table} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs text-gray-700">{t.table}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-900">
                      {t.error ? (
                        <span className="text-red-500 text-xs">{t.error}</span>
                      ) : (
                        fmtNum(t.count)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Pipelines */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Pipeline Status</h2>
        <div className="space-y-2">
          {data.pipelines.map((p) => {
            const s = STATUS[p.status];
            const isTriggering = triggering === p.slug;
            const result = triggerResult?.slug === p.slug ? triggerResult : null;
            return (
              <div key={p.slug} className="rounded-lg border bg-white p-3 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${s.dot} ${p.status !== "ok" && p.status !== "unknown" ? "animate-pulse" : ""}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900">{p.name}</div>
                    <div className="text-xs text-gray-400 truncate">
                      {p.lastMessage ?? (p.lastStatus ? `Last: ${p.lastStatus}` : "No runs recorded")}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                  <div className="text-right">
                    <div className="text-sm font-medium tabular-nums text-gray-700">{fmtAge(p.staleMins)}</div>
                    <div className="text-[11px] text-gray-400">{fmtTs(p.lastRun)}</div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}>
                    {s.label}
                  </span>
                  {PIPELINE_ENDPOINTS[p.slug] && (
                    <button
                      onClick={() => triggerPipeline(p.slug)}
                      disabled={isTriggering}
                      className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition ${
                        result
                          ? result.ok
                            ? "bg-emerald-50 border-emerald-200 text-emerald-600"
                            : "bg-red-50 border-red-200 text-red-600"
                          : "bg-white border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600"
                      } disabled:opacity-50`}
                    >
                      {isTriggering ? "Running…" : result ? (result.ok ? "Done" : "Failed") : "Run"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Users */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
          User Management
          <span className="ml-2 text-xs font-normal text-gray-400 normal-case">({data.users.length} users)</span>
        </h2>
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Email</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Role</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Last Sign In</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Created</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.users
                .sort((a, b) => {
                  // Super admins first, then admins, then by email
                  if (a.isSuperAdmin && !b.isSuperAdmin) return -1;
                  if (!a.isSuperAdmin && b.isSuperAdmin) return 1;
                  if (a.role === "admin" && b.role !== "admin") return -1;
                  if (a.role !== "admin" && b.role === "admin") return 1;
                  return a.email.localeCompare(b.email);
                })
                .map((user) => {
                  const roleColor = ROLE_COLORS[user.role ?? ""] ?? "bg-gray-100 text-gray-600";
                  return (
                    <tr key={user.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-800">{user.email}</span>
                          {user.isSuperAdmin && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800">SUPER</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${roleColor}`}>
                          {user.role ?? "No role"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs">
                        {user.lastSignIn ? fmtTs(user.lastSignIn) : "Never"}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs">
                        {fmtTs(user.createdAt)}
                      </td>
                      <td className="px-4 py-2.5">
                        <select
                          value={user.role ?? ""}
                          onChange={(e) => handleRoleChange(user.id, e.target.value)}
                          disabled={roleUpdating === user.id || user.isSuperAdmin}
                          className="border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-slate-500 disabled:opacity-50"
                        >
                          <option value="" disabled>Select</option>
                          <option value="admin">Admin</option>
                          <option value="dashboard">Dashboard</option>
                          <option value="pilot">Pilot</option>
                          <option value="van">Van</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-xs text-gray-400 pb-4">
        Super Admin Dashboard · Auto-refreshes every 60s · Last: {fmtTs(data.checked_at)}
      </div>
    </div>
  );
}
