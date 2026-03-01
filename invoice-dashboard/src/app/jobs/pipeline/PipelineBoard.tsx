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

  return (
    <div className="p-4 sm:p-6 bg-gray-50 min-h-screen">
      {/* Search */}
      <div className="mb-4 flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search candidates..."
          className="max-w-xs rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-gray-400 transition-colors"
        />
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
    </div>
  );
}
