"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { HiringStage, JobRow } from "@/lib/types";

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------

const STAGES: { key: HiringStage; label: string; color: string }[] = [
  { key: "prd_faa_review", label: "Pending PRD Upload", color: "bg-orange-50 border-orange-300" },
  { key: "chief_pilot_review", label: "Chief Pilot Review", color: "bg-red-50 border-red-300" },
  { key: "screening", label: "Screening", color: "bg-blue-50 border-blue-300" },
  { key: "info_session", label: "Info Session", color: "bg-cyan-50 border-cyan-300" },
  { key: "tims_review", label: "Tim's Review", color: "bg-teal-50 border-teal-300" },
  { key: "interview_pre", label: "Need to Schedule Interview", color: "bg-violet-50 border-violet-300" },
  { key: "interview_scheduled", label: "Scheduled for Interview", color: "bg-fuchsia-50 border-fuchsia-300" },
  { key: "interview_post", label: "Interview Completed", color: "bg-purple-50 border-purple-300" },
  { key: "pending_offer", label: "Pending Offer", color: "bg-pink-50 border-pink-300" },
  { key: "offer", label: "Offer", color: "bg-amber-50 border-amber-300" },
  { key: "hired", label: "Hired", color: "bg-emerald-50 border-emerald-300" },
];

const CATEGORY_COLORS: Record<string, string> = {
  pilot_pic: "bg-emerald-100 text-emerald-800",
  pilot_sic: "bg-sky-100 text-sky-800",
  dispatcher: "bg-violet-100 text-violet-800",
  maintenance: "bg-amber-100 text-amber-800",
  other: "bg-gray-100 text-gray-600",
};

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PipelineBoard({ initialJobs }: { initialJobs: JobRow[] }) {
  const [jobs, setJobs] = useState<JobRow[]>(initialJobs);
  const [moving, setMoving] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [q, setQ] = useState("");

  // Group jobs by stage
  const grouped = useMemo(() => {
    const query = q.toLowerCase().trim();
    const filtered = query
      ? jobs.filter((j) =>
          [j.candidate_name, j.email, j.category, j.location, j.notes]
            .filter(Boolean)
            .some((f) => String(f).toLowerCase().includes(query)),
        )
      : jobs;

    const map: Record<HiringStage, JobRow[]> = {
      prd_faa_review: [],
      chief_pilot_review: [],
      screening: [],
      info_session: [],
      tims_review: [],
      interview_pre: [],
      interview_scheduled: [],
      interview_post: [],
      pending_offer: [],
      offer: [],
      hired: [],
    };
    for (const j of filtered) {
      const stage = (j.hiring_stage ?? "") as HiringStage;
      if (map[stage]) map[stage].push(j);
    }
    return map;
  }, [jobs, q]);

  // Move candidate to a new stage
  const moveToStage = useCallback(
    async (job: JobRow, newStage: HiringStage) => {
      if (job.hiring_stage === newStage) return;
      setMoving(job.id);

      // Optimistic update
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, hiring_stage: newStage } : j)),
      );

      try {
        const res = await fetch("/api/jobs/pipeline", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: job.id, stage: newStage }),
        });
        if (!res.ok) {
          // Revert on failure
          setJobs((prev) =>
            prev.map((j) =>
              j.id === job.id ? { ...j, hiring_stage: job.hiring_stage } : j,
            ),
          );
        }
      } catch {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id ? { ...j, hiring_stage: job.hiring_stage } : j,
          ),
        );
      } finally {
        setMoving(null);
      }
    },
    [],
  );

  // Create new candidate
  const handleCreate = useCallback(
    async (fields: Record<string, string>) => {
      const res = await fetch("/api/jobs/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.job) {
        setJobs((prev) => [data.job, ...prev]);
      }
      setShowCreate(false);
    },
    [],
  );

  return (
    <div className="p-4 space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search candidates..."
          className="w-full max-w-sm rounded-xl border bg-white px-4 py-2 text-sm shadow-sm outline-none"
        />
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-xl border bg-blue-600 text-white px-4 py-2 text-sm shadow-sm hover:bg-blue-700"
        >
          + New Candidate
        </button>
        <div className="text-xs text-gray-500">{jobs.length} total</div>
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateModal onClose={() => setShowCreate(false)} onCreate={handleCreate} />
      )}

      {/* Kanban columns */}
      <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: "70vh" }}>
        {STAGES.map((stage) => (
          <div
            key={stage.key}
            className={`flex-shrink-0 w-64 rounded-xl border-2 ${stage.color} p-3 flex flex-col`}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold">{stage.label}</div>
              <div className="text-xs text-gray-500 bg-white rounded-full px-2 py-0.5">
                {grouped[stage.key].length}
              </div>
            </div>

            <div className="space-y-2 flex-1 overflow-y-auto max-h-[calc(70vh-3rem)]">
              {grouped[stage.key].map((job) => (
                <CandidateCard
                  key={job.id}
                  job={job}
                  stages={STAGES}
                  currentStage={stage.key}
                  moving={moving === job.id}
                  onMove={(s) => moveToStage(job, s)}
                />
              ))}
              {grouped[stage.key].length === 0 && (
                <div className="text-xs text-gray-400 text-center py-8">No candidates</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function CandidateCard({
  job,
  stages,
  currentStage,
  moving,
  onMove,
}: {
  job: JobRow;
  stages: typeof STAGES;
  currentStage: HiringStage;
  moving: boolean;
  onMove: (stage: HiringStage) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const catLabel = CATEGORY_LABELS[job.category ?? ""] ?? job.category ?? "";
  const catColor = CATEGORY_COLORS[job.category ?? ""] ?? "bg-gray-100 text-gray-600";

  // Determine stage movement options: forward + backward
  const currentIdx = stages.findIndex((s) => s.key === currentStage);
  const moveOptions = stages.filter(
    (s, i) => s.key !== currentStage && (i === currentIdx + 1 || i === currentIdx - 1),
  );

  return (
    <div
      className={`rounded-lg border bg-white p-3 shadow-sm text-sm ${moving ? "opacity-50" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium truncate">{job.candidate_name ?? "Unknown"}</div>
          <div className="text-xs text-gray-500 truncate">{job.email ?? ""}</div>
        </div>
        {catLabel && (
          <span
            className={`flex-shrink-0 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${catColor}`}
          >
            {catLabel}
          </span>
        )}
      </div>

      {job.location && (
        <div className="text-xs text-gray-400 mt-1 truncate">{job.location}</div>
      )}

      {/* Pilot metrics row */}
      {(job.total_time_hours || job.pic_time_hours) && (
        <div className="flex gap-2 mt-1.5 text-[10px] text-gray-500">
          {job.total_time_hours && <span>TT {job.total_time_hours}</span>}
          {job.pic_time_hours && <span>PIC {job.pic_time_hours}</span>}
        </div>
      )}

      {/* Action row */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-blue-600 hover:underline"
        >
          {expanded ? "Less" : "Move"}
        </button>
        {job.application_id && (
          <Link
            href={`/jobs/${job.application_id}`}
            className="text-[10px] text-blue-600 hover:underline"
          >
            View
          </Link>
        )}
      </div>

      {expanded && (
        <div className="mt-2 flex flex-wrap gap-1">
          {moveOptions.map((s) => (
            <button
              key={s.key}
              onClick={() => {
                onMove(s.key);
                setExpanded(false);
              }}
              disabled={moving}
              className="rounded px-2 py-0.5 text-[10px] border border-gray-300 text-gray-700 bg-gray-50 hover:shadow-sm disabled:opacity-40"
            >
              {s.label}
            </button>
          ))}
          {/* Show all stages if not in adjacent list */}
          {stages
            .filter(
              (s) => s.key !== currentStage && !moveOptions.some((m) => m.key === s.key),
            )
            .map((s) => (
              <button
                key={s.key}
                onClick={() => {
                  onMove(s.key);
                  setExpanded(false);
                }}
                disabled={moving}
                className="rounded px-2 py-0.5 text-[10px] border border-gray-200 text-gray-400 bg-white hover:shadow-sm disabled:opacity-40"
              >
                {s.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create modal
// ---------------------------------------------------------------------------

function CreateModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (fields: Record<string, string>) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await onCreate({
      candidate_name: name,
      email,
      phone,
      location,
      category,
      notes,
      hiring_stage: "prd_faa_review",
    });
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl shadow-lg p-6 w-full max-w-md space-y-4"
      >
        <div className="text-lg font-semibold">New Candidate</div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              type="email"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Phone</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Location</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            >
              <option value="">—</option>
              <option value="pilot_pic">Pilot — PIC</option>
              <option value="pilot_sic">Pilot — SIC</option>
              <option value="dispatcher">Dispatcher</option>
              <option value="maintenance">Maintenance</option>
              <option value="line_service">Line Service</option>
              <option value="sales">Sales</option>
              <option value="admin">Admin</option>
              <option value="management">Management</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
            rows={3}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || saving}
            className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-40"
          >
            {saving ? "Saving..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
