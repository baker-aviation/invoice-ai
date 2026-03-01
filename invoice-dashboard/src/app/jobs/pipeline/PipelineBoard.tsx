"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { JobRow, PipelineStage } from "@/lib/types";
import { PIPELINE_STAGES } from "@/lib/types";

// ---------------------------------------------------------------------------
// Stage display config
// ---------------------------------------------------------------------------

const STAGE_META: Record<
  PipelineStage,
  { label: string; color: string; headerColor: string }
> = {
  new: {
    label: "New",
    color: "border-slate-200",
    headerColor: "bg-slate-100 text-slate-700",
  },
  screening: {
    label: "Screening",
    color: "border-blue-200",
    headerColor: "bg-blue-100 text-blue-700",
  },
  interview: {
    label: "Interview",
    color: "border-violet-200",
    headerColor: "bg-violet-100 text-violet-700",
  },
  offer: {
    label: "Offer",
    color: "border-amber-200",
    headerColor: "bg-amber-100 text-amber-700",
  },
  hired: {
    label: "Hired",
    color: "border-emerald-200",
    headerColor: "bg-emerald-100 text-emerald-700",
  },
  rejected: {
    label: "Rejected",
    color: "border-red-200",
    headerColor: "bg-red-100 text-red-700",
  },
};

// ---------------------------------------------------------------------------
// Category helpers (shared with JobsTable)
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, string> = {
  pilot_pic: "PIC",
  pilot_sic: "SIC",
  dispatcher: "Dispatch",
  maintenance: "Mx",
  sales: "Sales",
  hr: "HR",
  admin: "Admin",
  management: "Mgmt",
  line_service: "Line",
  other: "Other",
};

const CATEGORY_COLORS: Record<string, string> = {
  pilot_pic: "bg-emerald-100 text-emerald-800 border-emerald-200",
  pilot_sic: "bg-sky-100 text-sky-800 border-sky-200",
  dispatcher: "bg-violet-100 text-violet-800 border-violet-200",
  maintenance: "bg-amber-100 text-amber-800 border-amber-200",
  sales: "bg-pink-100 text-pink-800 border-pink-200",
  hr: "bg-indigo-100 text-indigo-800 border-indigo-200",
  admin: "bg-slate-100 text-slate-700 border-slate-200",
  management: "bg-orange-100 text-orange-800 border-orange-200",
  line_service: "bg-teal-100 text-teal-800 border-teal-200",
  other: "bg-gray-100 text-gray-600 border-gray-200",
};

const CATEGORY_OPTIONS = [
  { value: "pilot_pic", label: "Pilot — PIC" },
  { value: "pilot_sic", label: "Pilot — SIC" },
  { value: "dispatcher", label: "Dispatcher" },
  { value: "maintenance", label: "Maintenance" },
  { value: "sales", label: "Sales" },
  { value: "hr", label: "HR" },
  { value: "admin", label: "Admin" },
  { value: "management", label: "Management" },
  { value: "line_service", label: "Line Service" },
  { value: "other", label: "Other" },
];

function fmtHours(v: number | null): string {
  if (v == null) return "";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtDate(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Add Candidate Modal
// ---------------------------------------------------------------------------

function AddCandidateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (job: JobRow) => void;
}) {
  const [form, setForm] = useState({
    candidate_name: "",
    email: "",
    phone: "",
    location: "",
    category: "",
    notes: "",
    total_time_hours: "",
    pic_time_hours: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const isPilot = form.category === "pilot_pic" || form.category === "pilot_sic";

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.candidate_name.trim()) {
      setError("Name is required");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const payload: Record<string, any> = {
        candidate_name: form.candidate_name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        location: form.location.trim() || null,
        category: form.category || null,
        notes: form.notes.trim() || null,
        pipeline_stage: "new",
      };
      if (isPilot) {
        if (form.total_time_hours) payload.total_time_hours = Number(form.total_time_hours);
        if (form.pic_time_hours) payload.pic_time_hours = Number(form.pic_time_hours);
      }

      const res = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to create candidate");
        setSubmitting(false);
        return;
      }

      const data = await res.json();

      // Build a local JobRow for optimistic UI
      const newJob: JobRow = {
        id: data.id,
        application_id: data.application_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        pipeline_stage: "new",
        category: form.category || null,
        employment_type: null,
        candidate_name: form.candidate_name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        location: form.location.trim() || null,
        total_time_hours: isPilot && form.total_time_hours ? Number(form.total_time_hours) : null,
        turbine_time_hours: null,
        pic_time_hours: isPilot && form.pic_time_hours ? Number(form.pic_time_hours) : null,
        sic_time_hours: null,
        has_citation_x: null,
        has_challenger_300_type_rating: null,
        type_ratings: null,
        soft_gate_pic_met: null,
        soft_gate_pic_status: null,
        needs_review: false,
        notes: form.notes.trim() || null,
        model: "manual",
      };

      onCreated(newJob);
      onClose();
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900">Add Candidate</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
            <input
              value={form.candidate_name}
              onChange={(e) => set("candidate_name", e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
              <input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
              <select
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400 bg-white"
              >
                <option value="">Select...</option>
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Location</label>
              <input
                value={form.location}
                onChange={(e) => set("location", e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
              />
            </div>
          </div>

          {isPilot && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Total Time (hrs)</label>
                <input
                  type="number"
                  value={form.total_time_hours}
                  onChange={(e) => set("total_time_hours", e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">PIC Time (hrs)</label>
                <input
                  type="number"
                  value={form.pic_time_hours}
                  onChange={(e) => set("pic_time_hours", e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400 resize-none"
            />
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Adding..." : "Add Candidate"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Candidate card
// ---------------------------------------------------------------------------

function CandidateCard({
  job,
  onDragStart,
}: {
  job: JobRow;
  onDragStart: (e: React.DragEvent, applicationId: number) => void;
}) {
  const isPilot =
    job.category === "pilot_pic" || job.category === "pilot_sic";
  const catLabel = CATEGORY_LABELS[job.category ?? ""] ?? job.category;
  const catColor =
    CATEGORY_COLORS[job.category ?? ""] ??
    "bg-gray-100 text-gray-600 border-gray-200";

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, job.application_id)}
      className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing active:shadow-lg"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm text-gray-900 truncate">
            {job.candidate_name ?? "Unknown"}
          </div>
          {job.email && (
            <div className="text-[11px] text-gray-400 truncate">{job.email}</div>
          )}
        </div>
        <Link
          href={`/jobs/${job.application_id}`}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3l5 5-5 5" />
          </svg>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {job.category && (
          <span
            className={`inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${catColor}`}
          >
            {catLabel}
          </span>
        )}
        {job.location && (
          <span className="text-[10px] text-gray-400 truncate max-w-[100px]">
            {job.location}
          </span>
        )}
      </div>

      {isPilot && (job.total_time_hours || job.pic_time_hours) && (
        <div className="flex gap-3 mt-2 text-[10px] text-gray-500 font-mono">
          {job.total_time_hours != null && (
            <span>TT {fmtHours(job.total_time_hours)}</span>
          )}
          {job.pic_time_hours != null && (
            <span>PIC {fmtHours(job.pic_time_hours)}</span>
          )}
        </div>
      )}

      {job.created_at && (
        <div className="mt-1.5 text-[10px] text-gray-300">
          {fmtDate(job.created_at)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main board
// ---------------------------------------------------------------------------

export default function PipelineBoard({
  initialJobs,
}: {
  initialJobs: JobRow[];
}) {
  const [jobs, setJobs] = useState<JobRow[]>(initialJobs);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<PipelineStage | null>(null);
  const [saving, setSaving] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);

  // Track pending API calls so we can dedup
  const pendingRef = useRef(new Set<string>());

  // Group jobs by stage
  const columns = new Map<PipelineStage, JobRow[]>();
  for (const stage of PIPELINE_STAGES) {
    columns.set(stage, []);
  }
  const qLower = search.toLowerCase().trim();
  for (const job of jobs) {
    const stage = (PIPELINE_STAGES as readonly string[]).includes(
      job.pipeline_stage,
    )
      ? job.pipeline_stage
      : "new";
    if (qLower) {
      const haystack = [
        job.candidate_name,
        job.email,
        job.location,
        job.category,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(qLower)) continue;
    }
    columns.get(stage)!.push(job);
  }

  // ---- Drag handlers ----
  const handleDragStart = useCallback(
    (e: React.DragEvent, applicationId: number) => {
      setDraggingId(applicationId);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(applicationId));
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, stage: PipelineStage) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(stage);
    },
    [],
  );

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, newStage: PipelineStage) => {
      e.preventDefault();
      setDropTarget(null);
      const appId = Number(e.dataTransfer.getData("text/plain"));
      if (!appId) return;

      const job = jobs.find((j) => j.application_id === appId);
      if (!job || job.pipeline_stage === newStage) {
        setDraggingId(null);
        return;
      }

      const key = `${appId}-${newStage}`;
      if (pendingRef.current.has(key)) return;

      // Optimistic update
      setJobs((prev) =>
        prev.map((j) =>
          j.application_id === appId
            ? { ...j, pipeline_stage: newStage }
            : j,
        ),
      );
      setDraggingId(null);

      // Persist
      pendingRef.current.add(key);
      setSaving((prev) => new Set(prev).add(appId));
      try {
        const res = await fetch(`/api/jobs/${appId}/stage`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage: newStage }),
        });
        if (!res.ok) {
          // Revert on failure
          setJobs((prev) =>
            prev.map((j) =>
              j.application_id === appId
                ? { ...j, pipeline_stage: job.pipeline_stage }
                : j,
            ),
          );
        }
      } catch {
        // Revert on network error
        setJobs((prev) =>
          prev.map((j) =>
            j.application_id === appId
              ? { ...j, pipeline_stage: job.pipeline_stage }
              : j,
          ),
        );
      } finally {
        pendingRef.current.delete(key);
        setSaving((prev) => {
          const next = new Set(prev);
          next.delete(appId);
          return next;
        });
      }
    },
    [jobs],
  );

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setDropTarget(null);
  }, []);

  const handleCreated = useCallback((newJob: JobRow) => {
    setJobs((prev) => [newJob, ...prev]);
  }, []);

  return (
    <div className="p-4 sm:p-6 bg-gray-50 min-h-screen">
      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search candidates..."
          className="max-w-xs rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-gray-400 transition-colors"
        />
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Add Candidate
        </button>
        {saving.size > 0 && (
          <span className="text-xs text-gray-400 animate-pulse">Saving...</span>
        )}
      </div>

      {/* Columns */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {PIPELINE_STAGES.map((stage) => {
          const meta = STAGE_META[stage];
          const stageJobs = columns.get(stage) ?? [];
          const isOver = dropTarget === stage;

          return (
            <div
              key={stage}
              onDragOver={(e) => handleDragOver(e, stage)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, stage)}
              className={`shrink-0 w-[260px] flex flex-col rounded-xl border bg-gray-50 transition-colors ${
                isOver
                  ? "border-blue-400 bg-blue-50/50 ring-2 ring-blue-200"
                  : meta.color
              }`}
            >
              {/* Column header */}
              <div
                className={`flex items-center justify-between px-3 py-2 rounded-t-xl ${meta.headerColor}`}
              >
                <span className="text-xs font-semibold">{meta.label}</span>
                <span className="text-[10px] font-bold opacity-60">
                  {stageJobs.length}
                </span>
              </div>

              {/* Cards */}
              <div className="flex-1 p-2 space-y-2 min-h-[120px] max-h-[calc(100vh-220px)] overflow-y-auto">
                {stageJobs.map((job) => (
                  <div
                    key={job.application_id}
                    className={
                      draggingId === job.application_id ? "opacity-40" : ""
                    }
                    onDragEnd={handleDragEnd}
                  >
                    <CandidateCard
                      job={job}
                      onDragStart={handleDragStart}
                    />
                  </div>
                ))}
                {stageJobs.length === 0 && (
                  <div className="text-xs text-gray-300 text-center py-8">
                    No candidates
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Candidate Modal */}
      {showAddModal && (
        <AddCandidateModal
          onClose={() => setShowAddModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
