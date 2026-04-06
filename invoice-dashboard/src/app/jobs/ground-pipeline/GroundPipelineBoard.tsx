"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { JobRow } from "@/lib/types";
import {
  ALL_GROUND_STAGES,
  GROUND_PIPELINE_STAGES,
  GROUND_STAGE_META,
  GROUND_CATEGORY_LABELS,
  GROUND_CATEGORY_COLORS,
  GROUND_CATEGORY_OPTIONS,
  getGroundStagesForCategory,
  type GroundPipelineStage,
} from "@/lib/groundPipeline";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Add Candidate Modal (ground-specific)
// ---------------------------------------------------------------------------

function AddGroundCandidateModal({
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
  });
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

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
        pipeline_stage: "screening",
      };

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

      if (resumeFile && data.application_id && data.id) {
        try {
          const fd = new FormData();
          fd.append("file", resumeFile);
          fd.append("file_category", "resume");
          fd.append("parse_id", String(data.id));
          await fetch(`/api/jobs/${data.application_id}/attach`, {
            method: "POST",
            body: fd,
          });
        } catch {}
      }

      const newJob: JobRow = {
        id: data.id,
        application_id: data.application_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        pipeline_stage: "screening" as any,
        category: form.category || null,
        employment_type: null,
        candidate_name: form.candidate_name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        location: form.location.trim() || null,
        total_time_hours: null,
        turbine_time_hours: null,
        pic_time_hours: null,
        sic_time_hours: null,
        has_citation_x: null,
        has_challenger_300_type_rating: null,
        type_ratings: null,
        has_part_135: null,
        has_part_121: null,
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
          <h2 className="text-base font-semibold text-gray-900">Add Ground Candidate</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">
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
              <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
              <select
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400 bg-white"
              >
                <option value="">Select...</option>
                {GROUND_CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
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

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Resume (PDF, DOCX)</label>
            <input
              type="file"
              accept=".pdf,.docx,.doc,.txt"
              onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:text-sm file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
            />
          </div>

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
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-600 disabled:opacity-50 transition-colors"
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
// Manager Review Gate (inline approve/reject)
// ---------------------------------------------------------------------------

function ManagerReviewGate({
  job,
  onDecision,
}: {
  job: JobRow;
  onDecision: (applicationId: number, decision: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const status = (job as any).manager_review_status;

  if (status === "approved") {
    return (
      <div className="mt-1.5 text-[10px] font-medium text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5 border border-emerald-200">
        Approved {(job as any).manager_review_by ? `by ${(job as any).manager_review_by}` : ""}
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div className="mt-1.5 text-[10px] font-medium text-red-700 bg-red-50 rounded px-1.5 py-0.5 border border-red-200">
        Rejected {(job as any).manager_review_by ? `by ${(job as any).manager_review_by}` : ""}
      </div>
    );
  }

  async function handleDecision(decision: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/jobs/ground/${job.application_id}/manager-review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, notes: notes.trim() || undefined }),
      });
      if (res.ok) {
        onDecision(job.application_id, decision);
      }
    } catch {} finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 space-y-1" onClick={(e) => e.stopPropagation()}>
      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Review notes..."
        className="w-full text-[10px] px-2 py-1 rounded border border-gray-200 focus:border-orange-400 focus:outline-none"
      />
      <div className="flex gap-1">
        <button
          onClick={() => handleDecision("approved")}
          disabled={saving}
          className="flex-1 text-[10px] font-medium px-2 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 transition-colors"
        >
          {saving ? "..." : "Approve"}
        </button>
        <button
          onClick={() => handleDecision("rejected")}
          disabled={saving}
          className="flex-1 text-[10px] font-medium px-2 py-1 rounded border border-red-300 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
        >
          {saving ? "..." : "Reject"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evaluation Badge
// ---------------------------------------------------------------------------

function EvaluationBadge({ job, evalType }: { job: JobRow; evalType: string }) {
  const evals = (job as any).ground_evaluations;
  const evalData = evals?.[evalType];
  if (!evalData) return null;

  const passed = evalData.passed;
  const score = evalData.score;

  return (
    <span
      className={`inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
        passed === true
          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
          : passed === false
          ? "bg-red-50 text-red-700 border-red-200"
          : "bg-amber-50 text-amber-700 border-amber-200"
      }`}
    >
      {score != null ? `${score}pts` : ""}{" "}
      {passed === true ? "Pass" : passed === false ? "Fail" : "Pending"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Qualification Badges
// ---------------------------------------------------------------------------

function QualBadges({ job }: { job: JobRow }) {
  const quals = (job as any).ground_qualifications;
  if (!quals) return null;

  return (
    <>
      {quals.ap_cert && (
        <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-amber-50 text-amber-700 border-amber-200">
          A&P
        </span>
      )}
      {quals.ia_authorization && (
        <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-amber-50 text-amber-700 border-amber-200">
          IA
        </span>
      )}
      {quals.cdl && (
        <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-slate-50 text-slate-700 border-slate-200">
          CDL{quals.cdl_class ? ` ${quals.cdl_class}` : ""}
        </span>
      )}
      {quals.ase_certs?.length > 0 && (
        <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-700 border-indigo-200">
          ASE ({quals.ase_certs.length})
        </span>
      )}
      {quals.years_experience != null && (
        <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-gray-50 text-gray-600 border-gray-200">
          {quals.years_experience}yr exp
        </span>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Candidate Card
// ---------------------------------------------------------------------------

function GroundCandidateCard({
  job,
  onDragStart,
  stage,
  onManagerDecision,
}: {
  job: JobRow;
  onDragStart: (e: React.DragEvent, applicationId: number) => void;
  stage: string;
  onManagerDecision: (applicationId: number, decision: string) => void;
}) {
  const catLabel = GROUND_CATEGORY_LABELS[job.category ?? ""] ?? job.category;
  const catColor = GROUND_CATEGORY_COLORS[job.category ?? ""] ?? "bg-gray-100 text-gray-600 border-gray-200";

  // Determine which eval type to show based on stage
  const evalTypeForStage: Record<string, string> = {
    technical_assessment: "technical_assessment",
    sales_exercise: "sales_exercise",
  };

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
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-teal-600 hover:bg-teal-50 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {job.category && (
          <span className={`inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${catColor}`}>
            {catLabel}
          </span>
        )}
        {job.model === "manual" && (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-gray-50 text-gray-500 border-gray-200">Manual</span>
        )}
        {job.model === "google-form-intake" && (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">Google</span>
        )}
        {job.hr_reviewed ? (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-700 border-emerald-200">HR Reviewed</span>
        ) : (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-gray-50 text-gray-400 border-gray-200">HR Pending</span>
        )}
        {job.previously_rejected && (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">Prev. Rejected</span>
        )}
        <QualBadges job={job} />
        {/* Background check status */}
        {stage === "background_check" && (job as any).background_check_status && (
          <span className={`inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
            (job as any).background_check_status === "clear"
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-amber-50 text-amber-700 border-amber-200"
          }`}>
            BG: {(job as any).background_check_status}
          </span>
        )}
        {/* Driving record status */}
        {stage === "driving_record_check" && (job as any).driving_record_status && (
          <span className={`inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
            (job as any).driving_record_status === "clear"
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-amber-50 text-amber-700 border-amber-200"
          }`}>
            DMV: {(job as any).driving_record_status}
          </span>
        )}
        {job.location && (
          <span className="text-[10px] text-gray-400 truncate max-w-[100px]">{job.location}</span>
        )}
      </div>

      {/* Eval badge for assessment stages */}
      {evalTypeForStage[stage] && (
        <div className="mt-1.5">
          <EvaluationBadge job={job} evalType={evalTypeForStage[stage]} />
        </div>
      )}

      {/* Manager review gate */}
      {stage === "manager_review" && (
        <ManagerReviewGate job={job} onDecision={onManagerDecision} />
      )}

      {/* Offer status */}
      {(stage === "offer") && (
        <div className="mt-1.5">
          {job.offer_status === "sent" && (
            <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-blue-100 text-blue-700 border-blue-200">Offer Sent</span>
          )}
          {job.offer_status === "accepted" && (
            <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-100 text-emerald-700 border-emerald-200">Accepted</span>
          )}
          {job.offer_status === "declined" && (
            <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-100 text-red-700 border-red-200">Declined</span>
          )}
        </div>
      )}

      {job.created_at && (
        <div className="mt-1.5 text-[10px] text-gray-300">{fmtDate(job.created_at)}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Board
// ---------------------------------------------------------------------------

const CARD_LIMIT = 8;

export default function GroundPipelineBoard({
  initialJobs,
}: {
  initialJobs: JobRow[];
}) {
  const [jobs, setJobs] = useState<JobRow[]>(initialJobs);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [saving, setSaving] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [expandedColumns, setExpandedColumns] = useState<Set<string>>(new Set());
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());

  const pendingRef = useRef(new Set<string>());

  // Determine which stages to show based on category filter
  const displayStages = categoryFilter
    ? getGroundStagesForCategory(categoryFilter)
    : ALL_GROUND_STAGES as unknown as string[];

  // Group jobs by stage
  const columns = new Map<string, JobRow[]>();
  for (const stage of displayStages) {
    columns.set(stage, []);
  }

  const qLower = search.toLowerCase().trim();
  for (const job of jobs) {
    const stage = job.pipeline_stage ?? "";
    if (!displayStages.includes(stage)) continue;
    if (categoryFilter && job.category !== categoryFilter) continue;
    if (qLower) {
      const haystack = [job.candidate_name, job.email, job.location, job.category]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(qLower)) continue;
    }
    columns.get(stage)?.push(job);
  }

  // Category counts
  const categoryCounts: Record<string, number> = {};
  for (const job of jobs) {
    if (!(ALL_GROUND_STAGES as readonly string[]).includes(job.pipeline_stage ?? "")) continue;
    const cat = job.category || "other";
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
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
    (e: React.DragEvent, stage: string) => {
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
    async (e: React.DragEvent, newStage: string) => {
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
          j.application_id === appId ? { ...j, pipeline_stage: newStage as any } : j,
        ),
      );
      setDraggingId(null);

      // Persist via ground stage API
      pendingRef.current.add(key);
      setSaving((prev) => new Set(prev).add(appId));
      try {
        const res = await fetch(`/api/jobs/ground/${appId}/stage`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage: newStage }),
        });
        if (!res.ok) {
          // Revert
          setJobs((prev) =>
            prev.map((j) =>
              j.application_id === appId ? { ...j, pipeline_stage: job.pipeline_stage } : j,
            ),
          );
        }
      } catch {
        setJobs((prev) =>
          prev.map((j) =>
            j.application_id === appId ? { ...j, pipeline_stage: job.pipeline_stage } : j,
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

  const handleManagerDecision = useCallback((applicationId: number, decision: string) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.application_id === applicationId
          ? { ...j, manager_review_status: decision } as any
          : j,
      ),
    );
  }, []);

  const handleCreated = useCallback((newJob: JobRow) => {
    setJobs((prev) => [newJob, ...prev]);
  }, []);

  return (
    <div className="p-4 sm:p-6 bg-gray-50 min-h-screen">
      {/* Toolbar */}
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-teal-50 border border-teal-200 rounded-lg">
            <div className="w-2 h-2 rounded-full bg-teal-500" />
            <span className="text-xs font-semibold text-teal-700">Ground Pipeline</span>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search candidates..."
            className="max-w-xs rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-gray-400 transition-colors"
          />
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-600 transition-colors"
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
        {/* Category filter pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setCategoryFilter(null)}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
              !categoryFilter
                ? "bg-teal-700 text-white border-teal-700"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
            }`}
          >
            All ({jobs.filter((j) => (ALL_GROUND_STAGES as readonly string[]).includes(j.pipeline_stage ?? "")).length})
          </button>
          {GROUND_CATEGORY_OPTIONS.filter((opt) => categoryCounts[opt.value]).map((opt) => (
            <button
              key={opt.value}
              onClick={() => setCategoryFilter(categoryFilter === opt.value ? null : opt.value)}
              className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
                categoryFilter === opt.value
                  ? "bg-teal-700 text-white border-teal-700"
                  : `${GROUND_CATEGORY_COLORS[opt.value] ?? "bg-white text-gray-600 border-gray-200"} hover:opacity-80`
              }`}
            >
              {GROUND_CATEGORY_LABELS[opt.value] ?? opt.label} ({categoryCounts[opt.value]})
            </button>
          ))}
        </div>
      </div>

      {/* Columns */}
      <div className="flex gap-4 overflow-x-auto pb-4" onDragEnd={handleDragEnd}>
        {displayStages.map((stage) => {
          const meta = GROUND_STAGE_META[stage] ?? { label: stage, color: "border-gray-200", headerColor: "bg-gray-100 text-gray-700" };
          const stageJobs = columns.get(stage) ?? [];
          const isOver = dropTarget === stage;
          const isCollapsed = collapsedColumns.has(stage);
          const isExpanded = expandedColumns.has(stage);
          const showLimit = !isExpanded && stageJobs.length > CARD_LIMIT;
          const visibleJobs = showLimit ? stageJobs.slice(0, CARD_LIMIT) : stageJobs;
          const hiddenCount = stageJobs.length - CARD_LIMIT;

          return (
            <div
              key={stage}
              onDragOver={(e) => handleDragOver(e, stage)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, stage)}
              className={`flex flex-col rounded-xl border bg-gray-50 transition-all ${
                isCollapsed ? "min-w-[56px] max-w-[56px]" : "flex-1 min-w-[200px]"
              } ${
                isOver
                  ? "border-teal-400 bg-teal-50/50 ring-2 ring-teal-200"
                  : meta.color
              }`}
            >
              {/* Column header */}
              <button
                type="button"
                onClick={() => {
                  if (isCollapsed) {
                    setCollapsedColumns((prev) => { const n = new Set(prev); n.delete(stage); return n; });
                  } else {
                    setCollapsedColumns((prev) => new Set(prev).add(stage));
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-t-xl ${meta.headerColor} w-full text-left cursor-pointer hover:opacity-80 transition-opacity`}
              >
                {isCollapsed ? (
                  <div className="flex flex-col items-center w-full gap-1">
                    <span className="text-[10px] font-bold">{stageJobs.length}</span>
                    <span className="text-[9px] font-semibold [writing-mode:vertical-lr] rotate-180 whitespace-nowrap">
                      {meta.label}
                    </span>
                  </div>
                ) : (
                  <>
                    <span className="text-xs font-semibold flex-1">{meta.label}</span>
                    <span className="text-[10px] font-bold opacity-60">{stageJobs.length}</span>
                  </>
                )}
              </button>
              {!isCollapsed && meta.subtitle && (
                <div className="px-2 py-0.5 text-[9px] text-amber-600 bg-amber-50 border-b border-amber-200 text-center font-medium">
                  {meta.subtitle}
                </div>
              )}

              {!isCollapsed && (
                <div className="flex-1 p-2 space-y-2 min-h-[120px] max-h-[calc(100vh-260px)] overflow-y-auto">
                  {visibleJobs.map((job) => (
                    <div
                      key={job.application_id}
                      className={draggingId === job.application_id ? "opacity-40" : ""}
                    >
                      <GroundCandidateCard
                        job={job}
                        onDragStart={handleDragStart}
                        stage={stage}
                        onManagerDecision={handleManagerDecision}
                      />
                    </div>
                  ))}
                  {stageJobs.length === 0 && (
                    <div className="text-center text-xs text-gray-300 py-6">
                      Drop candidates here
                    </div>
                  )}
                  {showLimit && hiddenCount > 0 && (
                    <button
                      onClick={() => setExpandedColumns((prev) => new Set(prev).add(stage))}
                      className="w-full text-center text-[10px] text-gray-400 hover:text-gray-600 py-1"
                    >
                      Show {hiddenCount} more...
                    </button>
                  )}
                  {isExpanded && stageJobs.length > CARD_LIMIT && (
                    <button
                      onClick={() => setExpandedColumns((prev) => { const n = new Set(prev); n.delete(stage); return n; })}
                      className="w-full text-center text-[10px] text-gray-400 hover:text-gray-600 py-1"
                    >
                      Show less
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showAddModal && (
        <AddGroundCandidateModal
          onClose={() => setShowAddModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
