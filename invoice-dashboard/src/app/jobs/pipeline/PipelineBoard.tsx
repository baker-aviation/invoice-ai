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
  prd_faa_review: {
    label: "Pending PRD Upload",
    color: "border-orange-200",
    headerColor: "bg-orange-100 text-orange-700",
  },
  chief_pilot_review: {
    label: "Chief Pilot Review",
    color: "border-red-200",
    headerColor: "bg-red-100 text-red-700",
  },
  screening: {
    label: "Screening",
    color: "border-blue-200",
    headerColor: "bg-blue-100 text-blue-700",
  },
  info_session: {
    label: "Info Session",
    color: "border-cyan-200",
    headerColor: "bg-cyan-100 text-cyan-700",
  },
  tims_review: {
    label: "Tim's Review",
    color: "border-teal-200",
    headerColor: "bg-teal-100 text-teal-700",
  },
  interview_pre: {
    label: "Need to Schedule Interview",
    color: "border-violet-200",
    headerColor: "bg-violet-100 text-violet-700",
  },
  interview_scheduled: {
    label: "Scheduled for Interview",
    color: "border-fuchsia-200",
    headerColor: "bg-fuchsia-100 text-fuchsia-700",
  },
  interview_post: {
    label: "Interview Completed",
    color: "border-purple-200",
    headerColor: "bg-purple-100 text-purple-700",
  },
  pending_offer: {
    label: "Pending Offer",
    color: "border-pink-200",
    headerColor: "bg-pink-100 text-pink-700",
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
};

// ---------------------------------------------------------------------------
// Category helpers (shared with JobsTable)
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, string> = {
  pilot_pic: "PIC",
  pilot_sic: "SIC",
  skillbridge: "SkillBridge",
  dispatcher: "Dispatch",
  maintenance: "Mx",
  sales: "Sales",
  hr: "HR",
  admin: "Admin",
  management: "Mgmt",
  line_service: "Line",
  other: "Other",
};

function MeetingLinkTool({ storageKey, placeholder, borderColor }: { storageKey: string; placeholder?: string; borderColor?: string }) {
  const [meetLink, setMeetLink] = useState(() => {
    try { return localStorage.getItem(storageKey) ?? ""; } catch { return ""; }
  });
  const [copied, setCopied] = useState(false);

  const handleChange = (val: string) => {
    setMeetLink(val);
    try { localStorage.setItem(storageKey, val); } catch {}
  };

  return (
    <div className="space-y-1.5">
      <input
        type="text"
        value={meetLink}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder ?? "Meeting link..."}
        className={`w-full text-[10px] px-2 py-1 rounded border border-gray-200 focus:border-${borderColor ?? "cyan"}-400 focus:outline-none`}
      />
      {meetLink && (
        <button
          onClick={() => {
            navigator.clipboard.writeText(meetLink);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="text-[10px] font-medium px-2 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
        >
          {copied ? "Copied!" : "Copy Meet Link"}
        </button>
      )}
    </div>
  );
}

function InfoSessionTools({ jobs, onAttendanceChecked }: { jobs: JobRow[]; onAttendanceChecked?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [attendanceResult, setAttendanceResult] = useState<string | null>(null);
  const emails = jobs.filter((j) => j.email).map((j) => j.email!);

  const handleCopyEmails = () => {
    const text = emails.join(", ");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleCheckAttendance = async () => {
    let meetLink = "";
    try { meetLink = localStorage.getItem("info_session_meet_link") ?? ""; } catch {}
    if (!meetLink) {
      setAttendanceResult("Enter a Google Meet link first");
      return;
    }
    setChecking(true);
    setAttendanceResult(null);
    try {
      const res = await fetch("/api/jobs/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetLink }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAttendanceResult(`Error: ${data.error}`);
        return;
      }
      const parts = [];
      if (data.markedCount > 0) parts.push(`${data.markedCount} marked attended`);
      if (data.unmatched?.length > 0) parts.push(`${data.unmatched.length} unmatched`);
      if (data.totalParticipants === 0) parts.push("No participants found (meeting may not have ended yet)");
      setAttendanceResult(parts.join(", ") || "No matches found");
      if (data.markedCount > 0) onAttendanceChecked?.();
    } catch (err) {
      setAttendanceResult(`Error: ${String(err)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="px-3 py-2 border-t border-cyan-100 space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={handleCopyEmails}
          disabled={emails.length === 0}
          className="text-[10px] font-medium px-2 py-1 rounded border border-cyan-300 bg-white text-cyan-700 hover:bg-cyan-50 disabled:opacity-40 transition-colors"
        >
          {copied ? "Copied!" : `Copy ${emails.length} Email${emails.length !== 1 ? "s" : ""}`}
        </button>
      </div>
      <MeetingLinkTool storageKey="info_session_meet_link" placeholder="Google Meet link..." />
      <button
        onClick={handleCheckAttendance}
        disabled={checking}
        className="w-full text-[10px] font-medium px-2 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 transition-colors"
      >
        {checking ? "Checking..." : "Check Attendance"}
      </button>
      {attendanceResult && (
        <div className={`text-[10px] px-2 py-1 rounded ${attendanceResult.startsWith("Error") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>
          {attendanceResult}
        </div>
      )}
    </div>
  );
}

const CATEGORY_COLORS: Record<string, string> = {
  pilot_pic: "bg-emerald-100 text-emerald-800 border-emerald-200",
  pilot_sic: "bg-sky-100 text-sky-800 border-sky-200",
  skillbridge: "bg-cyan-100 text-cyan-800 border-cyan-200",
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
  { value: "skillbridge", label: "SkillBridge" },
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
  const [resumeFile, setResumeFile] = useState<File | null>(null);
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
        pipeline_stage: "prd_faa_review",
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

      // Upload resume file if provided
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
        } catch {
          // Non-blocking — candidate was created, file can be attached later
        }
      }

      // Build a local JobRow for optimistic UI
      const newJob: JobRow = {
        id: data.id,
        application_id: data.application_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        pipeline_stage: "prd_faa_review",
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

function OfferStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status || status === "draft") {
    return (
      <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-gray-100 text-gray-500 border-gray-200">
        No Offer
      </span>
    );
  }
  const map: Record<string, string> = {
    sent: "bg-blue-100 text-blue-700 border-blue-200",
    accepted: "bg-emerald-100 text-emerald-700 border-emerald-200",
    declined: "bg-red-100 text-red-700 border-red-200",
  };
  const labels: Record<string, string> = {
    sent: "Offer Sent",
    accepted: "Accepted",
    declined: "Declined",
  };
  return (
    <span className={`inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${map[status] ?? "bg-gray-100 text-gray-500 border-gray-200"}`}>
      {labels[status] ?? status}
    </span>
  );
}

function SendInterviewEmailButton({ job }: { job: JobRow }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSend(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!job.email) {
      setError("No email");
      return;
    }
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/jobs/send-interview-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ application_id: job.application_id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed");
      } else {
        setSent(true);
      }
    } catch {
      setError("Network error");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <span className="text-[10px] text-emerald-600 font-medium">Email sent</span>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button
        onClick={handleSend}
        disabled={sending || !job.email}
        className="text-[10px] font-medium px-2 py-1 rounded border border-violet-300 bg-white text-violet-700 hover:bg-violet-50 disabled:opacity-40 transition-colors"
      >
        {sending ? "Sending..." : "Send Scheduling Email"}
      </button>
      {error && <div className="text-[10px] text-red-500 mt-0.5">{error}</div>}
    </div>
  );
}

function CandidateCard({
  job,
  onDragStart,
  stage,
  onToggleAttendance,
}: {
  job: JobRow;
  onDragStart: (e: React.DragEvent, applicationId: number) => void;
  stage: PipelineStage;
  onToggleAttendance?: (applicationId: number, attended: boolean) => void;
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
        {/* Source tag */}
        {job.model === "google-form-intake" ? (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">Google</span>
        ) : job.model === "manual" ? (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-gray-50 text-gray-500 border-gray-200">Manual</span>
        ) : job.model ? (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-600 border-indigo-200">Hiring@</span>
        ) : null}
        {/* HR Reviewed badge */}
        {job.hr_reviewed ? (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-700 border-emerald-200">HR Reviewed</span>
        ) : (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-gray-50 text-gray-400 border-gray-200">HR Pending</span>
        )}
        {/* Previously Rejected badge */}
        {job.previously_rejected && (
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">Prev. Rejected</span>
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

      {/* Interview scheduling email button */}
      {stage === "interview_pre" && (
        <div className="mt-2">
          <SendInterviewEmailButton job={job} />
        </div>
      )}

      {/* Info session attendance toggle */}
      {stage === "info_session" && (
        <div className="mt-2 flex items-center gap-1.5">
          <label
            className="flex items-center gap-1.5 cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={!!job.info_session_attended}
              onChange={(e) => {
                e.stopPropagation();
                onToggleAttendance?.(job.application_id, e.target.checked);
              }}
              className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 h-3.5 w-3.5"
            />
            <span className="text-[10px] text-gray-500">Attended</span>
          </label>
          {job.info_session_attended && (
            <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-100 text-emerald-700 border-emerald-200">
              Attended
            </span>
          )}
        </div>
      )}

      {/* Offer status badge */}
      {(stage === "pending_offer" || stage === "offer") && (
        <div className="mt-2">
          <OfferStatusBadge status={job.offer_status} />
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
    if (!(PIPELINE_STAGES as readonly string[]).includes(job.pipeline_stage ?? "")) continue;
    const stage = job.pipeline_stage as PipelineStage;
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

  const handleToggleAttendance = useCallback(
    async (applicationId: number, attended: boolean) => {
      // Optimistic update
      setJobs((prev) =>
        prev.map((j) =>
          j.application_id === applicationId
            ? {
                ...j,
                info_session_attended: attended || null,
                info_session_attended_at: attended
                  ? new Date().toISOString()
                  : null,
              }
            : j,
        ),
      );

      try {
        const res = await fetch(`/api/jobs/${applicationId}/profile`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            info_session_attended: attended ? true : null,
            info_session_attended_at: attended
              ? new Date().toISOString()
              : null,
          }),
        });
        if (!res.ok) {
          // Revert on failure
          setJobs((prev) =>
            prev.map((j) =>
              j.application_id === applicationId
                ? {
                    ...j,
                    info_session_attended: attended ? null : true,
                    info_session_attended_at: attended
                      ? null
                      : j.info_session_attended_at,
                  }
                : j,
            ),
          );
        }
      } catch {
        // Revert on network error
        setJobs((prev) =>
          prev.map((j) =>
            j.application_id === applicationId
              ? {
                  ...j,
                  info_session_attended: attended ? null : true,
                  info_session_attended_at: attended
                    ? null
                    : j.info_session_attended_at,
                }
              : j,
          ),
        );
      }
    },
    [],
  );

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
              className={`flex-1 min-w-[200px] flex flex-col rounded-xl border bg-gray-50 transition-colors ${
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

              {stage === "info_session" && (
                <InfoSessionTools
                  jobs={stageJobs}
                  onAttendanceChecked={() => window.location.reload()}
                />
              )}
              {stage === "interview_scheduled" && (
                <div className="px-3 py-2 border-t border-fuchsia-100">
                  <MeetingLinkTool storageKey="interview_meet_link" placeholder="Calendly or Meet link..." borderColor="fuchsia" />
                </div>
              )}

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
                      stage={stage}
                      onToggleAttendance={handleToggleAttendance}
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
