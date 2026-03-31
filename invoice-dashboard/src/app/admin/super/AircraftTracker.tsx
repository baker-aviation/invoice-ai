"use client";

import { useEffect, useState, useCallback, useRef } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Aircraft {
  id: string;
  tail_number: string;
  aircraft_type: string | null;
  part_135_flying: string | null;
  wb_date: string | null;
  wb_on_jet_insight: string | null;
  foreflight_wb_built: string | null;
  starlink_on_wb: string | null;
  initial_foreflight_build: string | null;
  foreflight_subscription: string | null;
  foreflight_config_built: string | null;
  validation_complete: string | null;
  beta_tested: string | null;
  go_live_approved: string | null;
  genesis_removed: string | null;
  overall_status: string | null;
  notes: string | null;
  kow_callsign: string | null;
  jet_insight_url: string | null;
  created_at: string;
  updated_at: string;
}

type EditableField = keyof Omit<Aircraft, "id" | "created_at" | "updated_at">;

// "location" is a virtual column — not an Aircraft field, rendered separately
type ColumnKey = EditableField | "location";

const DISPLAY_COLUMNS: { key: ColumnKey; label: string; width: string }[] = [
  { key: "tail_number", label: "Tail #", width: "w-24" },
  { key: "aircraft_type", label: "Type", width: "w-28" },
  { key: "location", label: "Location", width: "w-32" },
  { key: "part_135_flying", label: "135 Flying", width: "w-24" },
  { key: "wb_date", label: "W&B Date", width: "w-28" },
  { key: "wb_on_jet_insight", label: "W&B on JI", width: "w-24" },
  { key: "foreflight_wb_built", label: "FF W&B Built", width: "w-28" },
  { key: "starlink_on_wb", label: "Starlink W&B", width: "w-28" },
  { key: "initial_foreflight_build", label: "Initial FF Build", width: "w-28" },
  { key: "foreflight_subscription", label: "FF Subscription", width: "w-32" },
  { key: "foreflight_config_built", label: "FF Config Built", width: "w-28" },
  { key: "validation_complete", label: "Validated", width: "w-24" },
  { key: "beta_tested", label: "Beta Tested", width: "w-24" },
  { key: "go_live_approved", label: "Go Live", width: "w-24" },
  { key: "genesis_removed", label: "Genesis Removed", width: "w-28" },
  { key: "overall_status", label: "Status", width: "w-28" },
  { key: "notes", label: "Notes", width: "w-48" },
  { key: "kow_callsign", label: "KOW Callsign", width: "w-28" },
  { key: "jet_insight_url", label: "Jet Insight URL", width: "w-40" },
];

const STATUS_COLORS: Record<string, string> = {
  "Configured": "bg-green-900/50 text-green-300 border-green-700",
  "Not Started": "bg-amber-900/50 text-amber-300 border-amber-700",
  "Validated": "bg-blue-900/50 text-blue-300 border-blue-700",
};

// Columns that get dropdown editors instead of free text
const YES_NO_FIELDS: Set<EditableField> = new Set([
  "part_135_flying",
  "wb_on_jet_insight",
  "foreflight_wb_built",
  "starlink_on_wb",
  "initial_foreflight_build",
  "foreflight_subscription",
  "foreflight_config_built",
  "validation_complete",
  "beta_tested",
  "go_live_approved",
  "genesis_removed",
]);

const YES_NO_OPTIONS = ["Yes", "No", "Unsure", "N/A", ""];
const STATUS_OPTIONS = ["Not Started", "Configured", "Validated", ""];

const STORAGE_KEY = "aircraft-tracker-hidden-cols";

// ─── Helpers ────────────────────────────────────────────────────────────────

function yesNoColor(val: string | null): string {
  if (!val) return "";
  const v = val.trim().toLowerCase();
  if (v === "yes") return "text-green-400";
  if (v === "no") return "text-red-400";
  if (v === "unsure" || v === "n/a") return "text-amber-400";
  return "";
}

function isUrl(val: string | null): boolean {
  if (!val) return false;
  return val.startsWith("http://") || val.startsWith("https://");
}

function loadHiddenColumns(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch {
    return new Set();
  }
}

type LocationResult = {
  airport_code: string;
  airport_name: string | null;
  city: string | null;
  state: string | null;
  last_seen: string | null;
};

// ─── Component ──────────────────────────────────────────────────────────────

export default function AircraftTracker() {
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [flyingFilter, setFlyingFilter] = useState<string>("all");
  const [showAddForm, setShowAddForm] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  // Column visibility
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(loadHiddenColumns);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const columnPickerRef = useRef<HTMLDivElement>(null);

  // FlightAware locations
  const [locations, setLocations] = useState<Record<string, LocationResult | null>>({});
  const [loadingLocations, setLoadingLocations] = useState(false);

  // Inline edit state
  const [editCell, setEditCell] = useState<{ id: string; field: EditableField } | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  // Add form state
  const [newTail, setNewTail] = useState("");
  const [newType, setNewType] = useState("");
  const [newStatus, setNewStatus] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // ── Persist hidden columns ─────────────────────────────────────────────

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...hiddenColumns]));
  }, [hiddenColumns]);

  const toggleColumn = (key: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Close column picker on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (columnPickerRef.current && !columnPickerRef.current.contains(e.target as Node)) {
        setShowColumnPicker(false);
      }
    };
    if (showColumnPicker) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showColumnPicker]);

  // Visible columns
  const visibleColumns = DISPLAY_COLUMNS.filter((col) => !hiddenColumns.has(col.key));

  // ── Fetch ───────────────────────────────────────────────────────────────

  const fetchAircraft = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/aircraft-tracker");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setAircraft(data.aircraft ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAircraft();
  }, [fetchAircraft]);

  // ── Fetch FlightAware Locations ────────────────────────────────────────

  const fetchLocations = useCallback(
    async (list: Aircraft[]) => {
      // Only look up aircraft NOT flying 135 (still in conformity)
      const nonFlying = list.filter(
        (a) => a.part_135_flying?.trim().toLowerCase() !== "yes",
      );
      if (nonFlying.length === 0) return;

      const tails = nonFlying.map((a) => a.tail_number);
      setLoadingLocations(true);
      try {
        const res = await fetch("/api/admin/aircraft-tracker/locations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tail_numbers: tails }),
        });
        if (!res.ok) throw new Error("Location fetch failed");
        const data = await res.json();
        setLocations(data.locations ?? {});
      } catch (err) {
        console.error("Failed to fetch locations:", err);
      } finally {
        setLoadingLocations(false);
      }
    },
    [],
  );

  // Locations fetched on demand via refresh button in the Location column header

  // ── Inline Edit ─────────────────────────────────────────────────────────

  const startEdit = (id: string, field: EditableField, currentValue: string | null) => {
    setEditCell({ id, field });
    setEditValue(currentValue ?? "");
    setTimeout(() => editRef.current?.focus(), 0);
  };

  const cancelEdit = () => {
    setEditCell(null);
    setEditValue("");
  };

  const saveEdit = async () => {
    if (!editCell) return;
    const { id, field } = editCell;
    const original = aircraft.find((a) => a.id === id);
    if (!original) return;

    const oldVal = original[field] ?? "";
    if (editValue === oldVal) {
      cancelEdit();
      return;
    }

    setSaving(`${id}:${field}`);
    cancelEdit();

    try {
      const res = await fetch("/api/admin/aircraft-tracker", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, [field]: editValue || null }),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      setAircraft((prev) => prev.map((a) => (a.id === id ? data.aircraft : a)));
    } catch {
      setError("Failed to save — try again");
    } finally {
      setSaving(null);
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveEdit();
    if (e.key === "Escape") cancelEdit();
  };

  // ── Add Aircraft ────────────────────────────────────────────────────────

  const addAircraft = async () => {
    if (!newTail.trim()) {
      setAddError("Tail number is required");
      return;
    }
    setAddError(null);

    try {
      const res = await fetch("/api/admin/aircraft-tracker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tail_number: newTail.trim(),
          aircraft_type: newType.trim() || null,
          overall_status: newStatus || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to add");
      }
      setNewTail("");
      setNewType("");
      setNewStatus("");
      setShowAddForm(false);
      fetchAircraft();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add aircraft");
    }
  };

  // ── Seed from Excel ─────────────────────────────────────────────────────

  const seedFromExcel = async () => {
    if (!confirm("This will import/update aircraft from the Excel spreadsheet. Continue?")) return;
    setSeeding(true);

    try {
      const res = await fetch("/api/admin/aircraft-tracker/seed", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Seed failed");
      }
      const data = await res.json();
      alert(`Imported ${data.count} aircraft successfully!`);
      fetchAircraft();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Seed failed");
    } finally {
      setSeeding(false);
    }
  };

  // ── Delete Aircraft ─────────────────────────────────────────────────────

  const deleteAircraft = async (id: string, tail: string) => {
    if (!confirm(`Delete ${tail}? This cannot be undone.`)) return;

    try {
      const res = await fetch("/api/admin/aircraft-tracker", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error("Delete failed");
      setAircraft((prev) => prev.filter((a) => a.id !== id));
    } catch {
      setError("Failed to delete");
    }
  };

  // ── Filter ──────────────────────────────────────────────────────────────

  const uniqueTypes = [...new Set(aircraft.map((a) => a.aircraft_type).filter(Boolean))].sort() as string[];

  const filtered = aircraft.filter((a) => {
    const matchSearch =
      !search ||
      a.tail_number.toLowerCase().includes(search.toLowerCase()) ||
      a.aircraft_type?.toLowerCase().includes(search.toLowerCase());
    const matchStatus =
      statusFilter === "all" ||
      (statusFilter === "none" ? !a.overall_status : a.overall_status === statusFilter);
    const matchType = typeFilter === "all" || a.aircraft_type === typeFilter;
    const matchFlying =
      flyingFilter === "all" ||
      (flyingFilter === "yes"
        ? a.part_135_flying?.trim().toLowerCase() === "yes"
        : a.part_135_flying?.trim().toLowerCase() !== "yes");
    return matchSearch && matchStatus && matchType && matchFlying;
  });

  // ── Stats ─────────────────────────────────────────────────────────────

  const stats = {
    total: aircraft.length,
    configured: aircraft.filter((a) => a.overall_status === "Configured").length,
    notStarted: aircraft.filter((a) => a.overall_status === "Not Started").length,
    validated: aircraft.filter((a) => a.overall_status === "Validated").length,
    noStatus: aircraft.filter((a) => !a.overall_status).length,
  };

  // ── Render ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400" />
        <span className="ml-3 text-zinc-400">Loading aircraft tracker...</span>
      </div>
    );
  }

  return (
    <div className="px-6 pb-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">ForeFlight Aircraft Tracker</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
          >
            {showAddForm ? "Cancel" : "+ Add Aircraft"}
          </button>
          <button
            onClick={seedFromExcel}
            disabled={seeding}
            className="px-3 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded-lg transition-colors disabled:opacity-50"
          >
            {seeding ? "Seeding..." : "Seed from Excel"}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-3">
        <div className="bg-green-900/30 border border-green-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-green-300">{stats.configured}</div>
          <div className="text-xs text-green-400">Configured</div>
        </div>
        <div className="bg-amber-900/30 border border-amber-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-amber-300">{stats.notStarted}</div>
          <div className="text-xs text-amber-400">Not Started</div>
        </div>
        <div className="bg-blue-900/30 border border-blue-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-blue-300">{stats.validated}</div>
          <div className="text-xs text-blue-400">Validated</div>
        </div>
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-zinc-300">{stats.noStatus}</div>
          <div className="text-xs text-zinc-400">No Status</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-slate-200">{stats.total}</div>
          <div className="text-xs text-slate-400">Total</div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 text-red-300 px-4 py-2 rounded-lg text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {/* Add form */}
      {showAddForm && (
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
          <div className="flex gap-3">
            <input
              placeholder="Tail Number *"
              value={newTail}
              onChange={(e) => setNewTail(e.target.value)}
              className="flex-1 bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-white placeholder-zinc-500"
            />
            <input
              placeholder="Aircraft Type"
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="flex-1 bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-white placeholder-zinc-500"
            />
            <select
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value)}
              className="bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-white"
            >
              <option value="">No Status</option>
              <option value="Not Started">Not Started</option>
              <option value="Configured">Configured</option>
              <option value="Validated">Validated</option>
            </select>
            <button
              onClick={addAircraft}
              className="px-4 py-1.5 text-sm bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
            >
              Add
            </button>
          </div>
          {addError && <p className="text-red-400 text-sm">{addError}</p>}
        </div>
      )}

      {/* Controls */}
      <div className="flex gap-3 flex-wrap items-center">
        <input
          placeholder="Search tail # or type..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 max-w-xs bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white"
        >
          <option value="all">All Statuses</option>
          <option value="Configured">Configured</option>
          <option value="Not Started">Not Started</option>
          <option value="Validated">Validated</option>
          <option value="none">No Status</option>
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white"
        >
          <option value="all">All Types</option>
          {uniqueTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={flyingFilter}
          onChange={(e) => setFlyingFilter(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white"
        >
          <option value="all">All 135 Status</option>
          <option value="yes">135 Flying</option>
          <option value="no">Not 135 Yet</option>
        </select>

        {/* Column visibility toggle */}
        <div className="relative" ref={columnPickerRef}>
          <button
            onClick={() => setShowColumnPicker(!showColumnPicker)}
            className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-600 rounded-lg transition-colors"
          >
            Columns{" "}
            {hiddenColumns.size > 0 && (
              <span className="text-xs text-amber-400 ml-1">({hiddenColumns.size} hidden)</span>
            )}
          </button>
          {showColumnPicker && (
            <div className="absolute top-full right-0 mt-1 z-50 bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl p-3 w-56 max-h-80 overflow-y-auto">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-medium text-zinc-400 uppercase">Toggle Columns</span>
                {hiddenColumns.size > 0 && (
                  <button
                    onClick={() => setHiddenColumns(new Set())}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    Show All
                  </button>
                )}
              </div>
              {DISPLAY_COLUMNS.map((col) => (
                <label
                  key={col.key}
                  className="flex items-center gap-2 py-1 px-1 rounded hover:bg-zinc-700/50 cursor-pointer text-sm"
                >
                  <input
                    type="checkbox"
                    checked={!hiddenColumns.has(col.key)}
                    onChange={() => toggleColumn(col.key)}
                    className="rounded border-zinc-500 bg-zinc-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                  />
                  <span className="text-zinc-200">{col.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <span className="text-zinc-500 text-sm">{filtered.length} shown</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-zinc-700">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-zinc-800 border-b border-zinc-700">
              {visibleColumns.map((col) => (
                <th
                  key={col.key}
                  className={`${col.width} px-3 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider whitespace-nowrap`}
                >
                  {col.label}
                  {col.key === "location" && (
                    loadingLocations ? (
                      <span className="ml-1 inline-block w-3 h-3 border border-zinc-500 border-t-blue-400 rounded-full animate-spin align-middle" />
                    ) : (
                      <button
                        onClick={() => fetchLocations(aircraft)}
                        className="ml-1 text-zinc-500 hover:text-cyan-400 transition-colors align-middle"
                        title="Refresh locations"
                      >
                        ↻
                      </button>
                    )
                  )}
                </th>
              ))}
              <th className="w-16 px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {filtered.map((row) => (
              <tr key={row.id} className="hover:bg-zinc-800/50 transition-colors">
                {visibleColumns.map((col) => {
                  // ── Location (virtual column) ──
                  if (col.key === "location") {
                    const isFlying = row.part_135_flying?.trim().toLowerCase() === "yes";
                    if (isFlying) {
                      return (
                        <td key="location" className={`${col.width} px-3 py-1.5 whitespace-nowrap`}>
                          <span className="text-zinc-600">—</span>
                        </td>
                      );
                    }
                    const loc = locations[row.tail_number];
                    return (
                      <td key="location" className={`${col.width} px-3 py-1.5 whitespace-nowrap`}>
                        {loadingLocations ? (
                          <span className="text-zinc-600 text-xs">...</span>
                        ) : loc ? (
                          <span
                            className="text-cyan-400"
                            title={[loc.airport_name, loc.city, loc.state].filter(Boolean).join(", ")}
                          >
                            {loc.airport_code}
                          </span>
                        ) : (
                          <span className="text-zinc-600 text-xs">N/A</span>
                        )}
                      </td>
                    );
                  }

                  // ── Normal editable columns ──
                  const field = col.key as EditableField;
                  const isEditing = editCell?.id === row.id && editCell?.field === field;
                  const isSaving = saving === `${row.id}:${field}`;
                  const val = row[field];

                  return (
                    <td
                      key={col.key}
                      className={`${col.width} px-3 py-1.5 whitespace-nowrap cursor-pointer ${isSaving ? "opacity-50" : ""}`}
                      onClick={() => !isEditing && startEdit(row.id, field, val)}
                    >
                      {isEditing && YES_NO_FIELDS.has(field) ? (
                        <select
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={handleEditKeyDown}
                          className="w-full bg-zinc-900 border border-blue-500 rounded px-1 py-0.5 text-sm text-white outline-none"
                        >
                          {YES_NO_OPTIONS.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt || "— clear —"}
                            </option>
                          ))}
                        </select>
                      ) : isEditing && field === "overall_status" ? (
                        <select
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={handleEditKeyDown}
                          className="w-full bg-zinc-900 border border-blue-500 rounded px-1 py-0.5 text-sm text-white outline-none"
                        >
                          {STATUS_OPTIONS.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt || "— clear —"}
                            </option>
                          ))}
                        </select>
                      ) : isEditing ? (
                        <input
                          ref={editRef}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={handleEditKeyDown}
                          className="w-full bg-zinc-900 border border-blue-500 rounded px-1.5 py-0.5 text-sm text-white outline-none"
                        />
                      ) : field === "overall_status" && val ? (
                        <span
                          className={`inline-block px-2 py-0.5 text-xs rounded border ${
                            STATUS_COLORS[val] ?? "bg-zinc-800 text-zinc-300 border-zinc-600"
                          }`}
                        >
                          {val}
                        </span>
                      ) : field === "jet_insight_url" && isUrl(val) ? (
                        <a
                          href={val!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 underline truncate block max-w-[10rem]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          View
                        </a>
                      ) : (
                        <span className={`${yesNoColor(val)} truncate block max-w-[10rem]`} title={val ?? ""}>
                          {val ?? <span className="text-zinc-600">—</span>}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="px-3 py-1.5">
                  <button
                    onClick={() => deleteAircraft(row.id, row.tail_number)}
                    className="text-zinc-600 hover:text-red-400 text-xs transition-colors"
                    title="Delete"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={visibleColumns.length + 1} className="text-center py-8 text-zinc-500">
                  {aircraft.length === 0
                    ? 'No aircraft yet — click "Seed from Excel" to import data'
                    : "No aircraft match your filters"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
