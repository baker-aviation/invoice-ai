"use client";

import { useState, useEffect, useCallback } from "react";

type IcsSource = {
  id: number;
  label: string;
  url: string;
  enabled: boolean;
  last_sync_at: string | null;
  last_sync_ok: boolean | null;
  created_at: string;
};

type BakerPprAirport = {
  id: number;
  icao: string;
  created_at: string;
};

type SlackMapping = {
  id: number;
  salesperson_name: string;
  slack_user_id: string;
  created_at: string;
};

export default function SettingsPage() {
  const [sources, setSources] = useState<IcsSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New source form
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editId, setEditId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [saving, setSaving] = useState(false);

  // Baker PPR state
  const [pprAirports, setPprAirports] = useState<BakerPprAirport[]>([]);
  const [pprLoading, setPprLoading] = useState(true);
  const [pprError, setPprError] = useState<string | null>(null);
  const [newIcao, setNewIcao] = useState("");
  const [addingIcao, setAddingIcao] = useState(false);

  // Trip CSV upload state
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvResult, setCsvResult] = useState<string | null>(null);

  // Salesperson Slack mapping state
  const [slackMappings, setSlackMappings] = useState<SlackMapping[]>([]);
  const [slackLoading, setSlackLoading] = useState(true);
  const [slackError, setSlackError] = useState<string | null>(null);
  const [newSpName, setNewSpName] = useState("");
  const [newSpSlackId, setNewSpSlackId] = useState("");
  const [addingSp, setAddingSp] = useState(false);

  // Slack test DM state
  const [testingSlackId, setTestingSlackId] = useState<string | null>(null);

  // Notification check state
  const [notifChecking, setNotifChecking] = useState(false);
  const [notifResult, setNotifResult] = useState<string | null>(null);

  // Daily summary state
  const [summaryChecking, setSummaryChecking] = useState(false);
  const [summaryResult, setSummaryResult] = useState<string | null>(null);

  // Notification log state
  type NotifLog = {
    id: number;
    salesperson_name: string;
    sent_at: string;
    tail_number: string;
    departure_icao: string;
    arrival_icao: string;
    scheduled_departure: string | null;
    flight_type: string | null;
    customer: string | null;
    trip_id: string;
  };
  const [notifLog, setNotifLog] = useState<NotifLog[]>([]);
  const [notifLogLoading, setNotifLogLoading] = useState(false);
  const [notifLogError, setNotifLogError] = useState<string | null>(null);
  const [notifLogLoaded, setNotifLogLoaded] = useState(false);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/ics-sources");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSources(data.sources ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  // ── Baker PPR fetching & handlers ────────────────────────────────────────

  const fetchPprAirports = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/baker-ppr");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPprAirports(data.airports ?? []);
      setPprError(null);
    } catch (err) {
      setPprError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setPprLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPprAirports();
  }, [fetchPprAirports]);

  // ── Salesperson Slack mapping fetching & handlers ──────────────────────────

  const fetchSlackMappings = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/salesperson-slack");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSlackMappings(data.mappings ?? []);
      setSlackError(null);
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setSlackLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSlackMappings();
  }, [fetchSlackMappings]);

  async function handleCsvUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem("csvFile") as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) return;

    setCsvUploading(true);
    setCsvResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/trip-salespersons/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCsvResult(`Uploaded ${data.upserted} trip(s) from ${data.totalParsed} parsed rows.`);
      fileInput.value = "";
    } catch (err) {
      setCsvResult(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setCsvUploading(false);
    }
  }

  async function handleAddSlackMapping(e: React.FormEvent) {
    e.preventDefault();
    if (!newSpName.trim() || !newSpSlackId.trim()) return;
    setAddingSp(true);
    try {
      const res = await fetch("/api/admin/salesperson-slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salesperson_name: newSpName.trim(), slack_user_id: newSpSlackId.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setNewSpName("");
      setNewSpSlackId("");
      await fetchSlackMappings();
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAddingSp(false);
    }
  }

  async function handleDeleteSlackMapping(name: string) {
    if (!confirm(`Remove Slack mapping for "${name}"?`)) return;
    try {
      const res = await fetch("/api/admin/salesperson-slack", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salesperson_name: name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchSlackMappings();
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function handleTestSlackDm(slackUserId: string) {
    setTestingSlackId(slackUserId);
    try {
      const res = await fetch("/api/admin/salesperson-slack/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack_user_id: slackUserId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSlackError(null);
      alert("Test DM sent! Check Slack.");
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Test DM failed");
    } finally {
      setTestingSlackId(null);
    }
  }

  async function handleCheckNotifications() {
    setNotifChecking(true);
    setNotifResult(null);
    try {
      const res = await fetch("/api/admin/trip-notifications/check", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      let msg = `Checked ${data.checked} flight(s): ${data.sent} DM(s) sent, ${data.skipped} skipped.`;
      if (data.sentDetails?.length) {
        const details = data.sentDetails.map(
          (d: { salesperson: string; tail: string; route: string; time: string }) =>
            `${d.salesperson} — ${d.tail} ${d.route} at ${d.time}`
        );
        msg += "\n\nSent to:\n" + details.join("\n");
      }
      if (data.errors?.length) msg += "\n\nErrors: " + data.errors.join("; ");
      if (data.message) msg = data.message;
      setNotifResult(msg);
    } catch (err) {
      setNotifResult(err instanceof Error ? err.message : "Check failed");
    } finally {
      setNotifChecking(false);
    }
  }

  async function handleDailySummary() {
    setSummaryChecking(true);
    setSummaryResult(null);
    try {
      const res = await fetch("/api/admin/trip-notifications/daily-summary", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      let msg = `Daily summary for ${data.date}: sent ${data.sent}/${data.total} DMs.`;
      if (data.sentDetails?.length) {
        const details = data.sentDetails.map(
          (d: { salesperson: string; legCount: number }) =>
            `${d.salesperson} — ${d.legCount} leg(s)`
        );
        msg += "\n\n" + details.join("\n");
      }
      if (data.errors?.length) msg += "\n\nErrors: " + data.errors.join("; ");
      if (data.message) msg = data.message;
      setSummaryResult(msg);
    } catch (err) {
      setSummaryResult(err instanceof Error ? err.message : "Summary failed");
    } finally {
      setSummaryChecking(false);
    }
  }

  async function fetchNotifLog() {
    setNotifLogLoading(true);
    setNotifLogError(null);
    try {
      const res = await fetch("/api/admin/trip-notifications/log");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotifLog(data.notifications ?? []);
      setNotifLogLoaded(true);
    } catch (err) {
      setNotifLogError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setNotifLogLoading(false);
    }
  }

  async function handleAddIcao(e: React.FormEvent) {
    e.preventDefault();
    if (!newIcao.trim()) return;
    setAddingIcao(true);
    try {
      const res = await fetch("/api/admin/baker-ppr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icao: newIcao.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setNewIcao("");
      await fetchPprAirports();
    } catch (err) {
      setPprError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAddingIcao(false);
    }
  }

  async function handleDeleteIcao(icao: string) {
    if (!confirm(`Remove ${icao} from Baker PPR list?`)) return;
    try {
      const res = await fetch("/api/admin/baker-ppr", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icao }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchPprAirports();
    } catch (err) {
      setPprError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newLabel.trim() || !newUrl.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/admin/ics-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel.trim(), url: newUrl.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setNewLabel("");
      setNewUrl("");
      await fetchSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(source: IcsSource) {
    try {
      const res = await fetch("/api/admin/ics-sources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: source.id, enabled: !source.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    }
  }

  async function handleSaveEdit() {
    if (editId === null || !editLabel.trim() || !editUrl.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/ics-sources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editId, label: editLabel.trim(), url: editUrl.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditId(null);
      await fetchSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Remove this ICS source? The URL will be deleted.")) return;
    try {
      const res = await fetch("/api/admin/ics-sources", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function startEdit(source: IcsSource) {
    setEditId(source.id);
    setEditLabel(source.label);
    setEditUrl(source.url);
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return "Never";
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      hour12: false, timeZone: "UTC",
    }) + "Z";
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-6">
        Manage JetInsight ICS calendar feeds. Each URL syncs flight schedules
        into the ops dashboard every 30 minutes. Add a new aircraft by pasting
        its ICS URL below.
      </p>

      {error && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      {/* Add new source */}
      <form onSubmit={handleAdd} className="mb-6 flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label (e.g. N936BA)"
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <input
          type="url"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="ICS URL"
          className="border border-gray-300 rounded-md px-3 py-2 text-sm flex-1 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <button
          type="submit"
          disabled={adding || !newLabel.trim() || !newUrl.trim()}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
        >
          {adding ? "Adding…" : "Add Source"}
        </button>
      </form>

      {/* Sources table */}
      {loading ? (
        <div className="text-sm text-gray-400 py-8 text-center">Loading…</div>
      ) : sources.length === 0 ? (
        <div className="text-sm text-gray-400 py-8 text-center border border-dashed border-gray-300 rounded-lg">
          No ICS sources configured. Add one above to start syncing flights.
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600 w-8">On</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Label</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">URL</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600 w-28">Last Sync</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600 w-24">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className={`border-t border-gray-100 ${!s.enabled ? "opacity-50" : ""}`}>
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={() => handleToggle(s)}
                      className={`w-8 h-5 rounded-full relative transition-colors ${
                        s.enabled ? "bg-green-500" : "bg-gray-300"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          s.enabled ? "left-3.5" : "left-0.5"
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-2">
                    {editId === s.id ? (
                      <input
                        type="text"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-32 focus:outline-none focus:ring-2 focus:ring-slate-500"
                      />
                    ) : (
                      <span className="font-mono font-semibold text-gray-800">{s.label}</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {editId === s.id ? (
                      <input
                        type="url"
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-xs font-mono w-full focus:outline-none focus:ring-2 focus:ring-slate-500"
                      />
                    ) : (
                      <span className="text-xs text-gray-500 font-mono truncate block max-w-[300px]" title={s.url}>
                        {s.url.split("?")[0]}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      {s.last_sync_ok === true && <span className="w-2 h-2 rounded-full bg-green-500" />}
                      {s.last_sync_ok === false && <span className="w-2 h-2 rounded-full bg-red-500" />}
                      {s.last_sync_ok === null && <span className="w-2 h-2 rounded-full bg-gray-300" />}
                      <span className="text-xs text-gray-500">{fmtDate(s.last_sync_at)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {editId === s.id ? (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={handleSaveEdit}
                          disabled={saving}
                          className="text-xs text-green-700 hover:text-green-900 font-medium px-2 py-1 rounded hover:bg-green-50"
                        >
                          {saving ? "…" : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditId(null)}
                          className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(s)}
                          className="text-xs text-gray-500 hover:text-slate-800 px-2 py-1 rounded hover:bg-gray-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(s.id)}
                          className="text-xs text-gray-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Seed + info */}
      <div className="mt-6 flex items-center gap-4 flex-wrap">
        <button
          type="button"
          onClick={async () => {
            if (!confirm("Import ICS URLs from the ops-monitor environment variable into this table?")) return;
            setError(null);
            try {
              const res = await fetch("/api/admin/ics-sources/seed", { method: "POST" });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
              await fetchSources();
              alert(`Seeded ${data.seeded} new source(s), ${data.skipped} already existed.`);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Seed failed");
            }
          }}
          className="text-xs border border-gray-300 rounded-md px-3 py-1.5 text-gray-600 hover:bg-gray-50 hover:border-gray-400 transition-colors"
        >
          Import from env var
        </button>
        <p className="text-xs text-gray-400">
          Changes take effect on the next ops-monitor sync (every 30 min) — no redeploy needed.
        </p>
      </div>

      {/* ── Baker PPR Airports ────────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Baker PPR Airports</h2>
      <p className="text-sm text-gray-500 mb-4">
        Airports that require Baker PPR (Prior Permission Required). Flights
        to/from these airports will show a &quot;Baker PPR&quot; alert on the ops board.
      </p>

      {pprError && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {pprError}
          <button onClick={() => setPprError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      <form onSubmit={handleAddIcao} className="mb-4 flex gap-2">
        <input
          type="text"
          value={newIcao}
          onChange={(e) => setNewIcao(e.target.value.toUpperCase())}
          placeholder="ICAO code (e.g. KNUQ)"
          maxLength={5}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-44 font-mono uppercase focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <button
          type="submit"
          disabled={addingIcao || !newIcao.trim()}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
        >
          {addingIcao ? "Adding…" : "Add"}
        </button>
      </form>

      {pprLoading ? (
        <div className="text-sm text-gray-400 py-4 text-center">Loading…</div>
      ) : pprAirports.length === 0 ? (
        <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-300 rounded-lg">
          No Baker PPR airports configured.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {pprAirports.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-full text-sm font-mono font-semibold text-amber-800"
            >
              {a.icao}
              <button
                type="button"
                onClick={() => handleDeleteIcao(a.icao)}
                className="text-amber-400 hover:text-red-600 transition-colors"
                title={`Remove ${a.icao}`}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── Trip Salesperson CSV Upload ─────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Trip Salesperson CSV Upload</h2>
      <p className="text-sm text-gray-500 mb-4">
        Upload a JetInsight Aircraft Activity CSV. Expected columns:
        Start Z, Start time Z, End time Z, Tail #, Trip, Salesperson, Customer, Orig, Dest.
      </p>

      <form onSubmit={handleCsvUpload} className="mb-4 flex gap-2 items-center">
        <input
          type="file"
          name="csvFile"
          accept=".csv"
          className="text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
        />
        <button
          type="submit"
          disabled={csvUploading}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
        >
          {csvUploading ? "Uploading…" : "Upload CSV"}
        </button>
      </form>

      {csvResult && (
        <div className="mb-4 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
          {csvResult}
        </div>
      )}

      {/* ── Salesperson Slack Mapping ───────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Salesperson Slack Mapping</h2>
      <p className="text-sm text-gray-500 mb-4">
        Map salesperson names (as they appear in JetInsight) to Slack user IDs
        for departure DM notifications.
      </p>

      {slackError && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {slackError}
          <button onClick={() => setSlackError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      <form onSubmit={handleAddSlackMapping} className="mb-4 flex gap-2">
        <input
          type="text"
          value={newSpName}
          onChange={(e) => setNewSpName(e.target.value)}
          placeholder="Salesperson name"
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <input
          type="text"
          value={newSpSlackId}
          onChange={(e) => setNewSpSlackId(e.target.value)}
          placeholder="Slack user ID (U...)"
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-44 font-mono focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <button
          type="submit"
          disabled={addingSp || !newSpName.trim() || !newSpSlackId.trim()}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
        >
          {addingSp ? "Adding…" : "Add Mapping"}
        </button>
      </form>

      {slackLoading ? (
        <div className="text-sm text-gray-400 py-4 text-center">Loading…</div>
      ) : slackMappings.length === 0 ? (
        <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-300 rounded-lg">
          No salesperson Slack mappings configured.
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Salesperson</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Slack User ID</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600 w-36">Actions</th>
              </tr>
            </thead>
            <tbody>
              {slackMappings.map((m) => (
                <tr key={m.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-medium text-gray-800">{m.salesperson_name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500">{m.slack_user_id}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleTestSlackDm(m.slack_user_id)}
                        disabled={testingSlackId === m.slack_user_id}
                        className="text-xs text-blue-500 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50 disabled:opacity-50"
                      >
                        {testingSlackId === m.slack_user_id ? "Sending…" : "Test DM"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSlackMapping(m.salesperson_name)}
                        className="text-xs text-gray-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Test Notifications ─────────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Test Departure Notifications</h2>
      <p className="text-sm text-gray-500 mb-4">
        Manually run the notification check. This scans flights departing in the
        next ~75 minutes, matches them to trip salespersons, and sends Slack DMs.
      </p>

      <button
        type="button"
        onClick={handleCheckNotifications}
        disabled={notifChecking}
        className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        {notifChecking ? "Checking…" : "Run Notification Check"}
      </button>

      {notifResult && (
        <div className="mt-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 whitespace-pre-line">
          {notifResult}
        </div>
      )}

      {/* ── Daily Summary ──────────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Daily Evening Summary</h2>
      <p className="text-sm text-gray-500 mb-4">
        Send each salesperson a Slack DM with their sold legs for tomorrow.
        Salespersons with no legs get a &quot;no sold legs&quot; message.
        Runs automatically at 6pm EST daily.
      </p>

      <button
        type="button"
        onClick={handleDailySummary}
        disabled={summaryChecking}
        className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        {summaryChecking ? "Sending…" : "Send Daily Summary Now"}
      </button>

      {summaryResult && (
        <div className="mt-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 whitespace-pre-line">
          {summaryResult}
        </div>
      )}

      {/* ── Notification Log ─────────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Notification Log</h2>
      <p className="text-sm text-gray-500 mb-4">
        View departure DMs sent in the last 7 days. Use this to verify if a
        salesperson received an alert for a specific flight.
      </p>

      <button
        type="button"
        onClick={fetchNotifLog}
        disabled={notifLogLoading}
        className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        {notifLogLoading ? "Loading…" : notifLogLoaded ? "Refresh Log" : "Load Notification Log"}
      </button>

      {notifLogError && (
        <div className="mt-3 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {notifLogError}
        </div>
      )}

      {notifLogLoaded && notifLog.length === 0 && (
        <div className="mt-3 text-sm text-gray-400 py-4 text-center border border-dashed border-gray-300 rounded-lg">
          No notifications sent in the last 7 days.
        </div>
      )}

      {notifLog.length > 0 && (
        <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Sent At</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Salesperson</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Tail</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Route</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Sched Dep</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Customer</th>
              </tr>
            </thead>
            <tbody>
              {notifLog.map((n) => {
                const sentDate = new Date(n.sent_at);
                const sentStr = sentDate.toLocaleString("en-US", {
                  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                  hour12: true, timeZone: "America/Chicago",
                });
                const depStr = n.scheduled_departure
                  ? new Date(n.scheduled_departure).toLocaleString("en-US", {
                      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                      hour12: true, timeZone: "America/Chicago",
                    })
                  : "—";
                const depIcao = n.departure_icao?.startsWith("K") ? n.departure_icao.slice(1) : n.departure_icao;
                const arrIcao = n.arrival_icao?.startsWith("K") ? n.arrival_icao.slice(1) : n.arrival_icao;
                return (
                  <tr key={n.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{sentStr}</td>
                    <td className="px-4 py-2 font-medium text-gray-800">{n.salesperson_name}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{n.tail_number}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{depIcao} → {arrIcao}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{depStr}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">{n.customer ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
