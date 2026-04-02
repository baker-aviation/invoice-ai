"use client";

import { useState, useEffect, useCallback } from "react";
import type { JetInsightDocument, JetInsightSyncRun } from "@/lib/jetinsight/types";

type Tab = "overview" | "crew" | "aircraft" | "trips" | "history";

const TABS: { key: Tab; label: string; slug: string }[] = [
  { key: "overview", label: "Overview", slug: "" },
  { key: "crew", label: "Crew Documents", slug: "crew" },
  { key: "aircraft", label: "Aircraft Documents", slug: "aircraft" },
  { key: "trips", label: "Trip Documents", slug: "trips" },
  { key: "history", label: "Sync History", slug: "history" },
];

export default function JetInsightClient({
  initialTab,
}: {
  initialTab: string | null;
}) {
  const [tab, setTab] = useState<Tab>(
    (TABS.find((t) => t.slug === initialTab)?.key ?? "overview") as Tab,
  );

  function switchTab(t: Tab) {
    setTab(t);
    const slug = TABS.find((x) => x.key === t)?.slug ?? "";
    window.history.replaceState(
      null,
      "",
      slug ? `/jetinsight/${slug}` : "/jetinsight",
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Tab bar */}
      <div className="mb-6 flex gap-1 rounded-lg bg-slate-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => switchTab(t.key)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "crew" && <CrewDocsTab />}
      {tab === "aircraft" && <AircraftDocsTab />}
      {tab === "trips" && <TripDocsTab />}
      {tab === "history" && <HistoryTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview Tab
// ---------------------------------------------------------------------------

function OverviewTab() {
  const [config, setConfig] = useState<Record<string, { value: string; updated_at: string }>>({});
  const [cookieStatus, setCookieStatus] = useState<string>("unknown");
  const [cookieInput, setCookieInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [stats, setStats] = useState({ crew: 0, aircraft: 0, total: 0 });
  const [lastRun, setLastRun] = useState<JetInsightSyncRun | null>(null);

  const loadConfig = useCallback(async () => {
    const res = await fetch("/api/jetinsight/config");
    if (res.ok) {
      const data = await res.json();
      setConfig(data.config ?? {});
      setCookieStatus(data.cookieStatus ?? "unknown");
    }
  }, []);

  const loadStats = useCallback(async () => {
    const [crewRes, aircraftRes, runRes] = await Promise.all([
      fetch("/api/jetinsight/documents?entity_type=crew&with_urls=false"),
      fetch("/api/jetinsight/documents?entity_type=aircraft&with_urls=false"),
      fetch("/api/jetinsight/sync/status?limit=1"),
    ]);
    if (crewRes.ok) {
      const d = await crewRes.json();
      setStats((s) => ({ ...s, crew: d.documents?.length ?? 0 }));
    }
    if (aircraftRes.ok) {
      const d = await aircraftRes.json();
      setStats((s) => ({ ...s, aircraft: d.documents?.length ?? 0 }));
    }
    if (runRes.ok) {
      const d = await runRes.json();
      const runs = d.runs ?? [];
      if (runs.length > 0) setLastRun(runs[0]);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadStats();
  }, [loadConfig, loadStats]);

  useEffect(() => {
    setStats((s) => ({ ...s, total: s.crew + s.aircraft }));
  }, [stats.crew, stats.aircraft]);

  async function saveCookie() {
    if (!cookieInput.trim()) return;
    setSaving(true);
    const res = await fetch("/api/jetinsight/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "session_cookie", value: cookieInput }),
    });
    if (res.ok) {
      setCookieInput("");
      await loadConfig();
    }
    setSaving(false);
  }

  async function triggerSync() {
    setSyncing(true);
    setSyncResult(null);
    let totalDownloaded = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    try {
      // Phase 1: Schedule JSON enrichment
      setSyncResult("Phase 1/5: Enriching flights from schedule JSON...");
      const schedRes = await fetch("/api/jetinsight/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "schedule" }),
      });
      const schedData = await schedRes.json();
      if (!schedRes.ok) throw new Error(schedData.error ?? schedData.result?.errors?.[0]?.message);
      const enriched = schedData.result?.flightsEnriched ?? 0;

      // Phase 2: Crew index
      setSyncResult("Phase 2/5: Syncing crew index...");
      const indexRes = await fetch("/api/jetinsight/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "crew_index" }),
      });
      const indexData = await indexRes.json();
      if (!indexRes.ok) throw new Error(indexData.error);
      const crewCount = indexData.count ?? 0;

      // Phase 3: Crew docs in batches
      let crewOffset = 0;
      let crewDone = false;
      while (!crewDone) {
        setSyncResult(
          `Phase 3/5: Crew documents (batch at offset ${crewOffset})... ${totalDownloaded} downloaded so far`,
        );
        const res = await fetch("/api/jetinsight/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "crew_batch", offset: crewOffset }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        totalDownloaded += data.docsDownloaded ?? 0;
        totalSkipped += data.docsSkipped ?? 0;
        totalErrors += data.errors?.length ?? 0;
        if (data.done || (data.processed ?? 0) === 0) {
          crewDone = true;
        } else {
          crewOffset = data.nextOffset ?? crewOffset + 3;
        }
      }

      // Phase 4: Aircraft docs in batches
      let acOffset = 0;
      let acDone = false;
      while (!acDone) {
        setSyncResult(
          `Phase 4/5: Aircraft documents (batch at offset ${acOffset})... ${totalDownloaded} downloaded so far`,
        );
        const res = await fetch("/api/jetinsight/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "aircraft_batch", offset: acOffset }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        totalDownloaded += data.docsDownloaded ?? 0;
        totalSkipped += data.docsSkipped ?? 0;
        totalErrors += data.errors?.length ?? 0;
        if (data.done || (data.processed ?? 0) === 0) {
          acDone = true;
        } else {
          acOffset = data.nextOffset ?? acOffset + 3;
        }
      }

      // Phase 5: Trip docs in batches (intl trips only)
      let tripOffset = 0;
      let tripDone = false;
      while (!tripDone) {
        setSyncResult(
          `Phase 5/5: Trip documents (batch at offset ${tripOffset})... ${totalDownloaded} downloaded so far`,
        );
        const res = await fetch("/api/jetinsight/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "trip_batch", offset: tripOffset }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        totalDownloaded += data.docsDownloaded ?? 0;
        totalSkipped += data.docsSkipped ?? 0;
        totalErrors += data.errors?.length ?? 0;
        if (data.done || (data.processed ?? 0) === 0) {
          tripDone = true;
        } else {
          tripOffset = data.nextOffset ?? tripOffset + 3;
        }
      }

      setSyncResult(
        `Sync complete: ${enriched} flights enriched, ${crewCount} crew found, ${totalDownloaded} docs downloaded, ${totalSkipped} skipped, ${totalErrors} errors`,
      );
      loadStats();
    } catch (err) {
      setSyncResult(
        `Error after ${totalDownloaded} downloads: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setSyncing(false);
  }

  const cookieBg =
    cookieStatus === "ok"
      ? "bg-green-100 text-green-800"
      : cookieStatus === "stale"
        ? "bg-yellow-100 text-yellow-800"
        : "bg-red-100 text-red-800";

  return (
    <div className="space-y-6">
      {/* Cookie status */}
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h3 className="mb-4 text-lg font-semibold text-slate-900">
          Session Cookie
        </h3>
        <div className="mb-4 flex items-center gap-3">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${cookieBg}`}
          >
            {cookieStatus === "ok"
              ? "Valid"
              : cookieStatus === "stale"
                ? "Stale (> 24h)"
                : "Missing"}
          </span>
          {config.session_cookie?.updated_at && (
            <span className="text-sm text-slate-500">
              Updated:{" "}
              {new Date(config.session_cookie.updated_at).toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            placeholder="Paste full cookie string from browser..."
            value={cookieInput}
            onChange={(e) => setCookieInput(e.target.value)}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={saveCookie}
            disabled={saving || !cookieInput.trim()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Log into portal.jetinsight.com, open DevTools &gt; Application &gt;
          Cookies, copy the full cookie string.
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Crew Documents" value={stats.crew} />
        <StatCard label="Aircraft Documents" value={stats.aircraft} />
        <StatCard label="Total Documents" value={stats.total} />
        <StatCard
          label="Last Sync"
          value={
            lastRun
              ? new Date(lastRun.started_at).toLocaleDateString()
              : "Never"
          }
          sub={lastRun?.status}
        />
      </div>

      {/* Sync trigger */}
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              Run Full Sync
            </h3>
            <p className="text-sm text-slate-500">
              Scrapes crew index, all crew doc pages, and all aircraft doc pages.
              Downloads new documents to GCS. GET-only &mdash; nothing is modified on
              JetInsight.
            </p>
          </div>
          <button
            onClick={triggerSync}
            disabled={syncing || cookieStatus === "missing"}
            className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Run Sync"}
          </button>
        </div>
        {syncResult && (
          <div
            className={`mt-4 rounded-md px-4 py-3 text-sm ${
              syncResult.startsWith("Error")
                ? "bg-red-50 text-red-800"
                : "bg-green-50 text-green-800"
            }`}
          >
            {syncResult}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {sub && (
        <p
          className={`mt-1 text-xs font-medium ${
            sub === "ok"
              ? "text-green-600"
              : sub === "error"
                ? "text-red-600"
                : "text-yellow-600"
          }`}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crew Documents Tab
// ---------------------------------------------------------------------------

function CrewDocsTab() {
  const [docs, setDocs] = useState<JetInsightDocument[]>([]);
  const [pilots, setPilots] = useState<Map<string, { name: string; role: string; email: string }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/jetinsight/documents?entity_type=crew").then((r) => r.json()),
      fetch("/api/pilots").then((r) => r.json()),
      fetch("/api/jetinsight/config").then((r) => r.json()),
    ])
      .then(([docsData, pilotsData, configData]) => {
        setDocs(docsData.documents ?? []);
        const map = new Map<string, { name: string; role: string; email: string }>();
        // Map by pilot_profile.id
        for (const p of pilotsData.pilots ?? []) {
          map.set(String(p.id), { name: p.full_name, role: p.role, email: p.email ?? "" });
        }
        // Also map by JetInsight UUID for crew without pilot_profiles
        try {
          const crewListStr = configData.config?.crew_list?.value;
          if (crewListStr) {
            const crewList = JSON.parse(crewListStr);
            for (const c of crewList) {
              if (!map.has(c.uuid)) {
                map.set(c.uuid, { name: c.name, role: "", email: c.email ?? "" });
              }
            }
          }
        } catch { /* ignore parse errors */ }
        setPilots(map);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-slate-500">Loading...</p>;
  if (docs.length === 0)
    return (
      <p className="text-sm text-slate-500">
        No crew documents synced yet. Run a sync from the Overview tab.
      </p>
    );

  // Group by entity_id
  const grouped = new Map<string, JetInsightDocument[]>();
  for (const d of docs) {
    const arr = grouped.get(d.entity_id) ?? [];
    arr.push(d);
    grouped.set(d.entity_id, arr);
  }

  // Sort by pilot name
  const sorted = [...grouped.entries()].sort((a, b) => {
    const nameA = pilots.get(a[0])?.name ?? a[0];
    const nameB = pilots.get(b[0])?.name ?? b[0];
    return nameA.localeCompare(nameB);
  });

  return (
    <div className="space-y-2">
      {sorted.map(([entityId, entityDocs]) => {
        const pilot = pilots.get(entityId);
        return (
        <div
          key={entityId}
          className="rounded-lg border border-slate-200 bg-white"
        >
          <button
            onClick={() =>
              setExpanded(expanded === entityId ? null : entityId)
            }
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-slate-900">
                {pilot?.name ?? entityId}
              </span>
              {pilot?.role && (
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                  pilot.role === "PIC" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
                }`}>
                  {pilot.role}
                </span>
              )}
              {pilot?.email && (
                <span className="text-xs text-slate-400">{pilot.email}</span>
              )}
            </div>
            <span className="text-sm text-slate-500">
              {entityDocs.length} doc{entityDocs.length !== 1 && "s"}
            </span>
          </button>
          {expanded === entityId && (
            <div className="border-t border-slate-100 px-4 py-3">
              <DocTable docs={entityDocs} />
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aircraft Documents Tab
// ---------------------------------------------------------------------------

function AircraftDocsTab() {
  const [docs, setDocs] = useState<JetInsightDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/jetinsight/documents?entity_type=aircraft")
      .then((r) => r.json())
      .then((d) => setDocs(d.documents ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-slate-500">Loading...</p>;
  if (docs.length === 0)
    return (
      <p className="text-sm text-slate-500">
        No aircraft documents synced yet. Run a sync from the Overview tab.
      </p>
    );

  const grouped = new Map<string, JetInsightDocument[]>();
  for (const d of docs) {
    const arr = grouped.get(d.entity_id) ?? [];
    arr.push(d);
    grouped.set(d.entity_id, arr);
  }

  // Sort by tail number
  const sorted = [...grouped.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  return (
    <div className="space-y-2">
      {sorted.map(([tail, tailDocs]) => (
        <div
          key={tail}
          className="rounded-lg border border-slate-200 bg-white"
        >
          <button
            onClick={() => setExpanded(expanded === tail ? null : tail)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
          >
            <span className="font-medium text-slate-900">{tail}</span>
            <span className="text-sm text-slate-500">
              {tailDocs.length} doc{tailDocs.length !== 1 && "s"}
            </span>
          </button>
          {expanded === tail && (
            <div className="border-t border-slate-100 px-4 py-3">
              <DocTable docs={tailDocs} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared document table
// ---------------------------------------------------------------------------

function DocTable({ docs }: { docs: JetInsightDocument[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
          <th className="pb-2 font-medium">Category</th>
          <th className="pb-2 font-medium">Document</th>
          <th className="pb-2 font-medium">Uploaded</th>
          <th className="pb-2 font-medium">Size</th>
          <th className="pb-2 font-medium"></th>
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id} className="border-b border-slate-50">
            <td className="py-2 pr-3">
              <span className="text-slate-700">{d.category}</span>
              {d.subcategory && (
                <span className="ml-1 text-xs text-slate-400">
                  ({d.subcategory})
                </span>
              )}
              {d.aircraft_type && (
                <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                  {d.aircraft_type}
                </span>
              )}
            </td>
            <td className="py-2 pr-3 text-slate-900">{d.document_name}</td>
            <td className="py-2 pr-3 text-slate-500">
              {d.uploaded_on
                ? new Date(d.uploaded_on).toLocaleDateString()
                : "-"}
            </td>
            <td className="py-2 pr-3 text-slate-500">
              {d.size_bytes
                ? `${Math.round(d.size_bytes / 1024)} KB`
                : "-"}
            </td>
            <td className="py-2">
              {d.signed_url && (
                <a
                  href={d.signed_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800"
                >
                  Download
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Trip Documents Tab
// ---------------------------------------------------------------------------

function TripDocsTab() {
  const [docs, setDocs] = useState<JetInsightDocument[]>([]);
  const [paxMap, setPaxMap] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/jetinsight/documents?entity_type=trip")
      .then((r) => r.json())
      .then((d) => setDocs(d.documents ?? []))
      .finally(() => setLoading(false));
  }, []);

  // Load pax names when a trip is expanded
  async function loadPax(tripId: string) {
    if (paxMap.has(tripId)) return;
    try {
      const res = await fetch(`/api/jetinsight/trip-passengers?trip_id=${tripId}`);
      if (res.ok) {
        const data = await res.json();
        setPaxMap((m) => new Map(m).set(tripId, data.passengers ?? []));
      }
    } catch { /* ignore */ }
  }

  if (loading) return <p className="text-sm text-slate-500">Loading...</p>;
  if (docs.length === 0)
    return (
      <p className="text-sm text-slate-500">
        No trip documents synced yet. Run a full sync — trip docs are pulled for international trips after schedule enrichment.
      </p>
    );

  // Group by trip ID
  const grouped = new Map<string, JetInsightDocument[]>();
  for (const d of docs) {
    const arr = grouped.get(d.entity_id) ?? [];
    arr.push(d);
    grouped.set(d.entity_id, arr);
  }

  return (
    <div className="space-y-2">
      {[...grouped.entries()].map(([tripId, tripDocs]) => (
        <div
          key={tripId}
          className="rounded-lg border border-slate-200 bg-white"
        >
          <button
            onClick={() => {
              const next = expanded === tripId ? null : tripId;
              setExpanded(next);
              if (next) loadPax(next);
            }}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-slate-900">Trip {tripId}</span>
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700">
                International
              </span>
            </div>
            <span className="text-sm text-slate-500">
              {tripDocs.length} doc{tripDocs.length !== 1 && "s"}
            </span>
          </button>
          {expanded === tripId && (
            <div className="border-t border-slate-100 px-4 py-3">
              <DocTable docs={tripDocs} />
              {paxMap.has(tripId) && (paxMap.get(tripId)?.length ?? 0) > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Passengers
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {paxMap.get(tripId)!.map((name) => (
                      <span
                        key={name}
                        className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-700"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync History Tab
// ---------------------------------------------------------------------------

function HistoryTab() {
  const [runs, setRuns] = useState<JetInsightSyncRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/jetinsight/sync/status?limit=50")
      .then((r) => r.json())
      .then((d) => setRuns(d.runs ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-slate-500">Loading...</p>;
  if (runs.length === 0)
    return (
      <p className="text-sm text-slate-500">No sync runs yet.</p>
    );

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
            <th className="px-4 py-3 font-medium">Started</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Crew</th>
            <th className="px-4 py-3 font-medium">Aircraft</th>
            <th className="px-4 py-3 font-medium">Downloaded</th>
            <th className="px-4 py-3 font-medium">Skipped</th>
            <th className="px-4 py-3 font-medium">Errors</th>
            <th className="px-4 py-3 font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b border-slate-50">
              <td className="px-4 py-2 text-slate-900">
                {new Date(r.started_at).toLocaleString()}
              </td>
              <td className="px-4 py-2 text-slate-700">{r.sync_type}</td>
              <td className="px-4 py-2">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                    r.status === "ok"
                      ? "bg-green-100 text-green-700"
                      : r.status === "error"
                        ? "bg-red-100 text-red-700"
                        : r.status === "running"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-yellow-100 text-yellow-700"
                  }`}
                >
                  {r.status}
                </span>
              </td>
              <td className="px-4 py-2 text-slate-700">{r.crew_synced}</td>
              <td className="px-4 py-2 text-slate-700">
                {r.aircraft_synced}
              </td>
              <td className="px-4 py-2 text-slate-700">
                {r.docs_downloaded}
              </td>
              <td className="px-4 py-2 text-slate-500">{r.docs_skipped}</td>
              <td className="px-4 py-2 text-slate-500">
                {r.errors?.length ?? 0}
              </td>
              <td className="px-4 py-2 text-slate-500">
                {r.duration_ms
                  ? `${Math.round(r.duration_ms / 1000)}s`
                  : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
