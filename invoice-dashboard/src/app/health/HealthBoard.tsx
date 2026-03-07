"use client";

import { useEffect, useState, useCallback, useRef } from "react";

type PipelineCheck = {
  name: string;
  description: string;
  lastActivity: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  status: "ok" | "warning" | "error" | "unknown";
  staleMins: number;
  thresholdMins: number;
};

type HealthData = {
  overall: "ok" | "warning" | "error" | "unknown";
  checked_at: string;
  pipelines: PipelineCheck[];
  error?: string;
};

const STATUS_STYLES = {
  ok: { dot: "bg-emerald-500", bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", label: "Healthy" },
  warning: { dot: "bg-amber-500", bg: "bg-amber-50 border-amber-200", text: "text-amber-700", label: "Stale" },
  error: { dot: "bg-red-500", bg: "bg-red-50 border-red-200", text: "text-red-700", label: "Down" },
  unknown: { dot: "bg-gray-400", bg: "bg-gray-50 border-gray-200", text: "text-gray-500", label: "No data" },
};

function formatAge(mins: number): string {
  if (mins < 0) return "—";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Map display names back to pipeline slugs for triggering
const NAME_TO_SLUG: Record<string, string> = {
  "Flight Sync": "flight-sync",
  "EDCT Pull": "edct-pull",
  "NOTAM Check": "notam-check",
  "Invoice Ingest": "invoice-ingest",
  "Invoice Parse": "invoice-parse",
  "Alert Generation": "alert-generation",
  "Slack Flush": "slack-flush",
  "Fuel Price Extract": "fuel-price-extract",
  "Job Ingest": "job-ingest",
  "Job Parse": "job-parse",
};

type FaHealth = {
  status: "ok" | "warning" | "error" | "unknown";
  count: number;
  cached: boolean;
  cached_at: string | null;
  cache_age_s: number | null;
  error?: string;
};

export function HealthBoard() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerResult, setTriggerResult] = useState<{ name: string; ok: boolean; msg: string } | null>(null);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [faHealth, setFaHealth] = useState<FaHealth | null>(null);
  const [faRefreshing, setFaRefreshing] = useState(false);

  const fetchFaHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/aircraft/flights", { cache: "no-store" });
      const json = await res.json();
      const age = json.cache_age_s ?? null;
      let status: FaHealth["status"] = "unknown";
      if (json.error && json.count === 0) status = "error";
      else if (json.count > 0 && age != null && age < 900) status = "ok";
      else if (json.count > 0) status = "warning";
      else status = "unknown";
      setFaHealth({
        status,
        count: json.count ?? 0,
        cached: json.cached ?? false,
        cached_at: json.cached_at ?? null,
        cache_age_s: age,
        error: json.error,
      });
    } catch {
      setFaHealth({ status: "error", count: 0, cached: false, cached_at: null, cache_age_s: null, error: "Failed to fetch" });
    }
  }, []);

  const refreshFa = useCallback(async () => {
    setFaRefreshing(true);
    try {
      const res = await fetch("/api/aircraft/flights?refresh=true", { cache: "no-store" });
      const json = await res.json();
      setFaHealth({
        status: json.count > 0 ? "ok" : "warning",
        count: json.count ?? 0,
        cached: false,
        cached_at: json.cached_at ?? new Date().toISOString(),
        cache_age_s: 0,
        error: json.error,
      });
    } catch {
      setFaHealth((prev) => prev ? { ...prev, error: "Refresh failed" } : null);
    } finally {
      setFaRefreshing(false);
    }
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const json: HealthData = await res.json();
      setData(json);
    } catch {
      setData({ overall: "error", checked_at: new Date().toISOString(), pipelines: [], error: "Failed to fetch" });
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerPipeline = useCallback(async (name: string) => {
    const slug = NAME_TO_SLUG[name];
    if (!slug) return;
    setTriggering(name);
    setTriggerResult(null);
    try {
      const res = await fetch("/api/health/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipeline: slug }),
      });
      const ok = res.ok;
      const msg = ok ? "Triggered" : `Error ${res.status}`;
      setTriggerResult({ name, ok, msg });
      if (ok) setTimeout(fetchHealth, 3000); // refresh after a few seconds
    } catch {
      setTriggerResult({ name, ok: false, msg: "Failed" });
    } finally {
      setTriggering(null);
      if (resultTimer.current) clearTimeout(resultTimer.current);
      resultTimer.current = setTimeout(() => setTriggerResult(null), 5000);
    }
  }, [fetchHealth]);

  useEffect(() => {
    fetchHealth();
    fetchFaHealth();
    const id = setInterval(() => { fetchHealth(); fetchFaHealth(); }, 300_000);
    return () => clearInterval(id);
  }, [fetchHealth, fetchFaHealth]);

  if (loading) {
    return (
      <div className="p-6">
        <div className="max-w-4xl mx-auto">
          <div className="animate-pulse space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-16 bg-gray-100 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const overallStyle = STATUS_STYLES[data.overall];
  const okCount = data.pipelines.filter((p) => p.status === "ok").length;

  return (
    <div className="p-4 sm:p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        {/* Overall status banner */}
        <div className={`rounded-xl border p-4 flex items-center justify-between ${overallStyle.bg}`}>
          <div className="flex items-center gap-3">
            <div className={`h-3 w-3 rounded-full ${overallStyle.dot} ${data.overall === "ok" ? "" : "animate-pulse"}`} />
            <div>
              <div className={`font-semibold ${overallStyle.text}`}>
                {data.overall === "ok"
                  ? "All systems operational"
                  : data.overall === "warning"
                    ? "Some pipelines are stale"
                    : data.overall === "error"
                      ? "Pipeline issues detected"
                      : "Health unknown"}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {okCount}/{data.pipelines.length} pipelines healthy
              </div>
            </div>
          </div>
          <div className="text-xs text-gray-400">
            Checked {formatTimestamp(data.checked_at)}
          </div>
        </div>

        {data.error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {data.error}
          </div>
        )}

        {/* FlightAware API */}
        {faHealth && (() => {
          const style = STATUS_STYLES[faHealth.status];
          const ageStr = faHealth.cache_age_s != null ? formatAge(Math.round(faHealth.cache_age_s / 60)) : "—";
          return (
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wider px-1">External APIs</div>
              <div className="rounded-lg border bg-white p-4 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${style.dot}`} />
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-gray-900">FlightAware AeroAPI</div>
                    <div className="text-xs text-gray-400 truncate">
                      {faHealth.error
                        ? faHealth.error
                        : `${faHealth.count} flights tracked · ${faHealth.cached ? "cached" : "fresh"}`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                  <div className="text-right">
                    <div className="text-sm font-medium tabular-nums text-gray-700">
                      {ageStr}
                    </div>
                    <div className="text-[11px] text-gray-400">
                      {formatTimestamp(faHealth.cached_at)}
                    </div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                  <button
                    onClick={refreshFa}
                    disabled={faRefreshing}
                    className="text-xs font-medium px-2.5 py-1 rounded-lg border transition bg-white border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50"
                  >
                    {faRefreshing ? "Refreshing…" : "Refresh Now"}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Pipeline cards */}
        <div className="space-y-2">
          {data.pipelines.map((p) => {
            const style = STATUS_STYLES[p.status];
            return (
              <div key={p.name} className="rounded-lg border bg-white p-4 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${style.dot}`} />
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-gray-900">{p.name}</div>
                    <div className="text-xs text-gray-400 truncate">
                      {p.lastMessage || p.description}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                  <div className="text-right">
                    <div className="text-sm font-medium tabular-nums text-gray-700">
                      {formatAge(p.staleMins)}
                    </div>
                    <div className="text-[11px] text-gray-400">
                      {formatTimestamp(p.lastActivity)}
                    </div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                  {NAME_TO_SLUG[p.name] && (
                    <button
                      onClick={() => triggerPipeline(p.name)}
                      disabled={triggering === p.name}
                      className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition ${
                        triggerResult?.name === p.name
                          ? triggerResult.ok
                            ? "bg-emerald-50 border-emerald-200 text-emerald-600"
                            : "bg-red-50 border-red-200 text-red-600"
                          : "bg-white border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600"
                      } disabled:opacity-50`}
                    >
                      {triggering === p.name
                        ? "Running…"
                        : triggerResult?.name === p.name
                          ? triggerResult.msg
                          : "Run Now"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
