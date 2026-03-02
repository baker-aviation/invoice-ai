"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type AircraftConfig = {
  tail_number: string;
  ics_url: string | null;
  active: boolean;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Add / Edit Aircraft Modal
// ---------------------------------------------------------------------------

function AircraftModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: AircraftConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [form, setForm] = useState({
    tail_number: initial?.tail_number ?? "",
    ics_url: initial?.ics_url ?? "",
    active: initial?.active ?? true,
    notes: initial?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const res = await fetch("/api/settings/aircraft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tail_number: form.tail_number.trim(),
        ics_url: form.ics_url.trim() || null,
        active: form.active,
        notes: form.notes.trim() || null,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to save");
      if (data.setup_sql) {
        setError((prev) => prev + " — See console for setup SQL.");
        console.log("Setup SQL:\n", data.setup_sql);
      }
      setSaving(false);
      return;
    }

    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900">{isEdit ? "Edit Aircraft" : "Add Aircraft"}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Tail Number *</label>
            <input
              value={form.tail_number}
              onChange={(e) => setForm((f) => ({ ...f, tail_number: e.target.value.toUpperCase() }))}
              placeholder="N51GB"
              disabled={isEdit}
              className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-mono outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
              autoFocus={!isEdit}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">JetInsight ICS URL</label>
            <input
              value={form.ics_url}
              onChange={(e) => setForm((f) => ({ ...f, ics_url: e.target.value }))}
              placeholder="https://jetinsight.com/ics/..."
              className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
            />
            <p className="text-[10px] text-gray-400 mt-0.5">The ICS calendar URL for this aircraft&apos;s schedule in JetInsight</p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
              className="rounded border-gray-300"
              id="active-check"
            />
            <label htmlFor="active-check" className="text-xs text-gray-600">Active (included in schedule sync)</label>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={2}
              placeholder="Aircraft type, base, etc."
              className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400 resize-none"
            />
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-1.5 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-700 disabled:opacity-50">
              {saving ? "Saving..." : isEdit ? "Save Changes" : "Add Aircraft"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Settings Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const [aircraft, setAircraft] = useState<AircraftConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<AircraftConfig | undefined>();
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadAircraft = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings/aircraft");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setAircraft(data.aircraft ?? []);
      setSource(data.source ?? "");
    } catch (e: any) {
      setError(e.message ?? "Failed to load aircraft");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAircraft(); }, [loadAircraft]);

  const handleDelete = useCallback(async (tail: string) => {
    if (!confirm(`Remove ${tail} from the fleet?`)) return;
    setDeleting(tail);
    try {
      const res = await fetch(`/api/settings/aircraft?tail_number=${encodeURIComponent(tail)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setAircraft((prev) => prev.filter((a) => a.tail_number !== tail));
      }
    } finally {
      setDeleting(null);
    }
  }, []);

  const filtered = search
    ? aircraft.filter((a) =>
        a.tail_number.toLowerCase().includes(search.toLowerCase()) ||
        (a.notes ?? "").toLowerCase().includes(search.toLowerCase())
      )
    : aircraft;

  const withUrl = aircraft.filter((a) => a.ics_url);
  const withoutUrl = aircraft.filter((a) => !a.ics_url);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <Link href="/" className="text-gray-400 hover:text-gray-600 text-sm">&larr; Home</Link>
      </div>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Settings</h1>
      <p className="text-sm text-gray-500 mb-6">Manage fleet aircraft and JetInsight ICS feed URLs</p>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border p-4">
          <div className="text-2xl font-bold text-slate-800">{aircraft.length}</div>
          <div className="text-xs text-gray-500">Total Aircraft</div>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <div className="text-2xl font-bold text-green-600">{withUrl.length}</div>
          <div className="text-xs text-gray-500">With ICS URL</div>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <div className="text-2xl font-bold text-amber-600">{withoutUrl.length}</div>
          <div className="text-xs text-gray-500">Missing ICS URL</div>
        </div>
      </div>

      {source === "flights_fallback" && (
        <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
          Showing aircraft from flights table (read-only). Create the <code className="font-mono bg-amber-100 px-1 rounded">aircraft_config</code> table in Supabase to enable editing. Check the browser console for setup SQL.
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tail numbers..."
          className="max-w-xs rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-gray-400"
        />
        <button
          onClick={() => { setEditTarget(undefined); setShowModal(true); }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-700"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Add Aircraft
        </button>
        <button
          onClick={loadAircraft}
          disabled={loading}
          className="text-xs text-blue-600 hover:underline disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</div>
      )}

      {/* Aircraft table */}
      <div className="bg-white border rounded-xl overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3">Tail Number</th>
              <th className="px-4 py-3">JetInsight ICS URL</th>
              <th className="px-4 py-3 hidden sm:table-cell">Status</th>
              <th className="px-4 py-3 hidden md:table-cell">Notes</th>
              <th className="px-4 py-3 w-24">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && aircraft.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400 animate-pulse">Loading aircraft...</td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  {search ? "No matching aircraft" : "No aircraft configured yet"}
                </td>
              </tr>
            ) : (
              filtered.map((ac) => (
                <tr key={ac.tail_number} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono font-semibold text-gray-800">{ac.tail_number}</td>
                  <td className="px-4 py-3">
                    {ac.ics_url ? (
                      <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-0.5 font-mono truncate max-w-[300px] inline-block">
                        {ac.ics_url.length > 50 ? ac.ics_url.slice(0, 50) + "..." : ac.ics_url}
                      </span>
                    ) : (
                      <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
                        Not configured
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    {ac.active ? (
                      <span className="text-xs text-green-700 bg-green-50 rounded-full px-2 py-0.5 font-medium">Active</span>
                    ) : (
                      <span className="text-xs text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-xs text-gray-500 max-w-[200px] truncate">
                    {ac.notes ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => { setEditTarget(ac); setShowModal(true); }}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Edit
                      </button>
                      {source !== "flights_fallback" && (
                        <button
                          onClick={() => handleDelete(ac.tail_number)}
                          disabled={deleting === ac.tail_number}
                          className="text-xs text-red-500 hover:underline disabled:opacity-50 ml-2"
                        >
                          {deleting === ac.tail_number ? "..." : "Remove"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Info note */}
      <div className="mt-6 text-xs text-gray-400 space-y-1">
        <p>ICS URLs are used by the ops-monitor service to sync flight schedules from JetInsight every 30 minutes.</p>
        <p>Adding a new aircraft here prepares it for schedule sync. The ICS URL can be obtained from JetInsight&apos;s calendar export for each aircraft.</p>
      </div>

      {/* Modal */}
      {showModal && (
        <AircraftModal
          initial={editTarget}
          onClose={() => { setShowModal(false); setEditTarget(undefined); }}
          onSaved={loadAircraft}
        />
      )}
    </div>
  );
}
