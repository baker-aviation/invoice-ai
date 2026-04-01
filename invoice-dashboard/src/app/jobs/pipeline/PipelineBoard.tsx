"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobRow, PipelineStage } from "@/lib/types";
import { PIPELINE_STAGES } from "@/lib/types";

// ---------------------------------------------------------------------------
// Stage display config
// ---------------------------------------------------------------------------

const STAGE_META: Record<
  PipelineStage,
  { label: string; subtitle?: string; color: string; headerColor: string }
> = {
  screening: {
    label: "Screening",
    color: "border-blue-200",
    headerColor: "bg-blue-100 text-blue-700",
  },
  info_session: {
    label: "Info Session",
    subtitle: "Dropping here will send invite email",
    color: "border-cyan-200",
    headerColor: "bg-cyan-100 text-cyan-700",
  },
  tims_review: {
    label: "Tim's Review",
    subtitle: "Dropping from Info Session sends interest check email",
    color: "border-teal-200",
    headerColor: "bg-teal-100 text-teal-700",
  },
  prd_faa_review: {
    label: "PRD / FAA Review",
    color: "border-orange-200",
    headerColor: "bg-orange-100 text-orange-700",
  },
  interview_scheduled: {
    label: "Scheduled for Interview",
    subtitle: "Dropping here will send scheduling email",
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

function MeetingLinkTool({ settingsKey, placeholder, borderColor }: { settingsKey: string; placeholder?: string; borderColor?: string }) {
  const [meetLink, setMeetLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load from hiring_settings on mount
  useEffect(() => {
    fetch("/api/jobs/settings")
      .then((r) => r.json())
      .then((d) => { if (d.settings?.[settingsKey]) setMeetLink(d.settings[settingsKey]); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [settingsKey]);

  const saveTimeout = useRef<NodeJS.Timeout | null>(null);
  const handleChange = (val: string) => {
    setMeetLink(val);
    // Debounced save to hiring_settings
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      fetch("/api/jobs/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: settingsKey, value: val }),
      }).catch(() => {});
    }, 1000);
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

function CollapsibleDateGroup({ dateLabel, count, defaultOpen, children }: { dateLabel: string; count: number; defaultOpen: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-emerald-100 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-2 py-1 font-bold text-emerald-800 bg-emerald-100/50 text-left flex items-center gap-1 hover:bg-emerald-100 transition-colors"
      >
        <span className="text-[10px]">{open ? "▾" : "▸"}</span>
        {dateLabel} <span className="font-normal text-emerald-500">({count})</span>
      </button>
      {open && children}
    </div>
  );
}

function fmtShortDate(d: string): string {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface AttendanceRecord {
  id: number;
  meeting_date: string;
  total_participants: number;
  matched: { name: string; email: string; durationMin: number }[];
  unmatched: string[];
}

function InfoSessionTools({ jobs, onAttendanceChecked }: { jobs: JobRow[]; onAttendanceChecked?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [attendanceResult, setAttendanceResult] = useState<{
    summary: string;
    matched: { name: string; email: string; durationSec: number; stage?: string | null; date?: string }[];
    unmatched: { name: string; email: string; durationMin: number; date?: string }[];
    internal: { name: string; email: string; durationMin: number; date?: string }[];
    totalParticipants: number;
  } | null>(null);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  const [history, setHistory] = useState<AttendanceRecord[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [expandedRecord, setExpandedRecord] = useState<number | null>(null);
  const [sendingInterest, setSendingInterest] = useState(false);
  const [interestResult, setInterestResult] = useState<{ sent: number; skipped: number; errors: string[] } | null>(null);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [broadcastSubject, setBroadcastSubject] = useState("Baker Aviation — Info Session Update");
  const [sendingBroadcast, setSendingBroadcast] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<{ sent: number; total: number } | null>(null);

  // Load history on first expand
  const loadHistory = async () => {
    if (historyLoaded) { setShowHistory(!showHistory); return; }
    try {
      const res = await fetch("/api/jobs/attendance");
      const data = await res.json();
      if (data.ok) setHistory(data.records ?? []);
    } catch {}
    setHistoryLoaded(true);
    setShowHistory(true);
  };
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
    try {
      const r = await fetch("/api/jobs/settings");
      const d = await r.json();
      meetLink = d.settings?.info_session_meet_link ?? "";
    } catch {}
    if (!meetLink) {
      setAttendanceError("Enter a Google Meet link first");
      return;
    }
    setChecking(true);
    setAttendanceResult(null);
    setAttendanceError(null);
    try {
      const res = await fetch("/api/jobs/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetLink }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAttendanceError(data.error);
        return;
      }
      const parts = [];
      if (data.markedCount > 0) parts.push(`${data.markedCount} marked attended`);
      if (data.unmatched?.length > 0) parts.push(`${data.unmatched.length} unmatched`);
      if (data.totalParticipants === 0) parts.push(`No participants found (code: ${data.meetingCode ?? "?"})`);
      if (data.totalParticipants > 0 && !data.matched?.length && !data.unmatched?.length && !data.internal?.length) {
        parts.push(`${data.totalParticipants} participants (all filtered — check domains)`);
      }
      setAttendanceResult({
        summary: parts.join(", ") || `${data.totalParticipants} participants`,
        matched: data.matched ?? [],
        unmatched: data.unmatched ?? [],
        internal: data.internal ?? [],
        totalParticipants: data.totalParticipants ?? 0,
      });
      if (data.markedCount > 0) {
        setTimeout(() => onAttendanceChecked?.(), 2000);
      }
    } catch (err) {
      setAttendanceError(String(err));
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
      <MeetingLinkTool settingsKey="info_session_meet_link" placeholder="Google Meet link..." />
      <button
        onClick={handleCheckAttendance}
        disabled={checking}
        className="w-full text-[10px] font-medium px-2 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 transition-colors"
      >
        {checking ? "Checking..." : "Check Attendance"}
      </button>
      {attendanceError && (
        <div className="text-[10px] px-2 py-1 rounded bg-red-50 text-red-600">{attendanceError}</div>
      )}
      {attendanceResult && (() => {
        // Group all participants by date (most recent first)
        const dateMap = new Map<string, {
          matched: typeof attendanceResult.matched;
          unmatched: typeof attendanceResult.unmatched;
          internal: typeof attendanceResult.internal;
        }>();
        const ensureDate = (d: string) => {
          if (!dateMap.has(d)) dateMap.set(d, { matched: [], unmatched: [], internal: [] });
          return dateMap.get(d)!;
        };
        for (const m of attendanceResult.matched) ensureDate(m.date ?? "unknown").matched.push(m);
        for (const u of attendanceResult.unmatched) {
          if (typeof u === "string") { ensureDate("unknown").unmatched.push(u as any); }
          else ensureDate(u.date ?? "unknown").unmatched.push(u);
        }
        for (const s of (attendanceResult.internal ?? [])) ensureDate(s.date ?? "unknown").internal.push(s);
        const sortedDates = [...dateMap.keys()].sort((a, b) => b.localeCompare(a));

        return (
          <div className="text-[10px] rounded border border-emerald-200 bg-emerald-50 overflow-hidden">
            <div className="px-2 py-1 font-semibold text-emerald-700 border-b border-emerald-200">
              {attendanceResult.summary} ({attendanceResult.totalParticipants} total)
            </div>
            {sortedDates.map((date, dateIdx) => {
              const group = dateMap.get(date)!;
              const dateLabel = date === "unknown" ? "Unknown date" : fmtShortDate(date);
              const count = group.matched.length + group.unmatched.length + group.internal.length;
              const isLatest = dateIdx === 0;
              const [expanded, setExpanded] = [isLatest, () => {}]; // latest always open
              return (
                <CollapsibleDateGroup key={date} dateLabel={dateLabel} count={count} defaultOpen={isLatest}>
                  {group.matched.length > 0 && (
                    <div className="px-2 py-0.5 space-y-0.5">
                      <div className="font-semibold text-emerald-600">In Pipeline:</div>
                      {group.matched.map((m, i) => (
                        <div key={`${m.email}-${i}`} className="text-emerald-700 flex items-center gap-1 flex-wrap">
                          <span>{m.name}</span>
                          <span className="text-emerald-400">({Math.round(m.durationSec / 60)}m)</span>
                          {m.stage && (
                            <span className="text-[9px] px-1 rounded bg-emerald-100 text-emerald-600">{m.stage.replace(/_/g, " ")}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {group.unmatched.length > 0 && (
                    <div className="px-2 py-0.5 space-y-0.5">
                      <div className="font-semibold text-gray-500">Not in pipeline:</div>
                      {group.unmatched.map((u, i) => (
                        <div key={typeof u === "string" ? u : `${u.email}-${i}`} className="text-gray-500">
                          {typeof u === "string" ? u : <>{u.name} ({u.durationMin}m)</>}
                        </div>
                      ))}
                    </div>
                  )}
                  {group.internal.length > 0 && (
                    <div className="px-2 py-0.5 space-y-0.5">
                      <div className="font-semibold text-gray-400">Baker staff:</div>
                      {group.internal.map((s, i) => (
                        <div key={`${s.email}-${i}`} className="text-gray-400">{s.name} ({s.durationMin}m)</div>
                      ))}
                    </div>
                  )}
                </CollapsibleDateGroup>
              );
            })}
          </div>
        );
      })()}
      {/* Send Still Interested? */}
      {(() => {
        const attended = jobs.filter((j) => j.info_session_attended && j.email && !j.interest_check_sent_at);
        if (attended.length === 0 && !interestResult) return null;
        return (
          <div className="space-y-1">
            {attended.length > 0 && (
              <button
                disabled={sendingInterest}
                onClick={async () => {
                  if (!confirm(`Send "Still interested?" email to ${attended.length} candidate${attended.length !== 1 ? "s" : ""}?`)) return;
                  setSendingInterest(true);
                  setInterestResult(null);
                  try {
                    const res = await fetch("/api/jobs/send-interest-check", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ application_ids: attended.map((j) => j.application_id) }),
                    });
                    const data = await res.json();
                    if (data.ok) {
                      setInterestResult(data);
                      onAttendanceChecked?.();
                    } else {
                      setInterestResult({ sent: 0, skipped: 0, errors: [data.error] });
                    }
                  } catch (err: any) {
                    setInterestResult({ sent: 0, skipped: 0, errors: [err.message] });
                  } finally {
                    setSendingInterest(false);
                  }
                }}
                className="w-full text-[10px] font-medium px-2 py-1.5 rounded border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors disabled:opacity-50"
              >
                {sendingInterest ? "Sending..." : `Send "Still Interested?" to ${attended.length}`}
              </button>
            )}
            {interestResult && (
              <div className="text-[10px] px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700">
                Sent {interestResult.sent}, skipped {interestResult.skipped}
                {interestResult.errors.length > 0 && (
                  <div className="text-red-500 mt-0.5">{interestResult.errors.join(", ")}</div>
                )}
              </div>
            )}
          </div>
        );
      })()}
      {/* Broadcast announcement */}
      <button
        onClick={() => setShowBroadcast(!showBroadcast)}
        className="w-full text-[10px] font-medium px-2 py-1 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
      >
        {showBroadcast ? "Cancel Announcement" : "Send Announcement"}
      </button>
      {showBroadcast && (
        <div className="space-y-1.5 p-2 rounded border border-blue-200 bg-blue-50/50">
          <input
            type="text"
            value={broadcastSubject}
            onChange={(e) => setBroadcastSubject(e.target.value)}
            placeholder="Email subject..."
            className="w-full text-[10px] px-2 py-1 rounded border border-gray-200 focus:border-blue-400 focus:outline-none"
          />
          <textarea
            value={broadcastMsg}
            onChange={(e) => setBroadcastMsg(e.target.value)}
            placeholder="Type your announcement... Use {{name}} for first name."
            rows={4}
            className="w-full text-[10px] px-2 py-1 rounded border border-gray-200 focus:border-blue-400 focus:outline-none resize-y"
          />
          <button
            disabled={sendingBroadcast || !broadcastMsg.trim()}
            onClick={async () => {
              const count = jobs.filter((j) => j.email).length;
              if (!confirm(`Send this announcement to ${count} candidate${count !== 1 ? "s" : ""} in Info Session?`)) return;
              setSendingBroadcast(true);
              setBroadcastResult(null);
              try {
                const res = await fetch("/api/jobs/send-broadcast", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ stage: "info_session", subject: broadcastSubject, message: broadcastMsg }),
                });
                const data = await res.json();
                if (data.ok) {
                  setBroadcastResult({ sent: data.sent, total: data.total });
                  setBroadcastMsg("");
                  setShowBroadcast(false);
                }
              } catch {} finally {
                setSendingBroadcast(false);
              }
            }}
            className="w-full text-[10px] font-medium px-2 py-1.5 rounded border border-blue-300 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {sendingBroadcast ? "Sending..." : `Send to ${jobs.filter((j) => j.email).length} candidates`}
          </button>
        </div>
      )}
      {broadcastResult && (
        <div className="text-[10px] px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700">
          Announcement sent to {broadcastResult.sent}/{broadcastResult.total}
        </div>
      )}
      {/* History toggle */}
      <button
        onClick={loadHistory}
        className="w-full text-[10px] font-medium px-2 py-1 rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 transition-colors"
      >
        {showHistory ? "Hide History" : "Past Sessions"}
      </button>
      {showHistory && (
        <div className="space-y-1">
          {history.length === 0 && (
            <div className="text-[10px] text-gray-400 px-1">No records yet</div>
          )}
          {history.map((rec) => {
            const dayLabel = new Date(rec.meeting_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
            const isExpanded = expandedRecord === rec.id;
            return (
              <div key={rec.id} className="text-[10px] rounded border border-gray-200 overflow-hidden">
                <button
                  onClick={() => setExpandedRecord(isExpanded ? null : rec.id)}
                  className="w-full px-2 py-1 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors text-left"
                >
                  <span className="font-medium text-gray-700">{dayLabel}</span>
                  <span className="text-gray-400">
                    {rec.matched.length} attended / {rec.total_participants} total
                  </span>
                </button>
                {isExpanded && (
                  <div className="px-2 py-1 space-y-0.5 border-t border-gray-100">
                    {rec.matched.map((m) => (
                      <div key={m.email} className="text-emerald-700">
                        {m.name} <span className="text-emerald-400">({m.durationMin}m)</span>
                      </div>
                    ))}
                    {rec.unmatched.length > 0 && (
                      <div className="pt-0.5 mt-0.5 border-t border-gray-100">
                        {rec.unmatched.map((u) => (
                          <div key={u} className="text-gray-400">{u}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
        pipeline_stage: "screening",
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
        pipeline_stage: "screening",
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
  const [sentAt, setSentAt] = useState<string | null>((job as any).interview_email_sent_at ?? null);
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed");
      } else {
        setSentAt(data.sentAt ?? new Date().toISOString());
      }
    } catch {
      setError("Network error");
    } finally {
      setSending(false);
    }
  }

  if (sentAt) {
    const dateStr = new Date(sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return (
      <div className="text-[10px]">
        <span className="text-emerald-600 font-medium">Email sent {dateStr}</span>
        <button
          onClick={handleSend}
          disabled={sending}
          className="ml-1.5 text-gray-400 hover:text-violet-600 transition-colors"
        >
          {sending ? "..." : "resend"}
        </button>
      </div>
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

function EmailStatusDropdown({ job, field }: { job: JobRow; field: "interview_email_status" | "info_session_email_status" }) {
  const sentAtField = field === "interview_email_status" ? "interview_email_sent_at" : "info_session_email_sent_at";
  const sentAt = (job as any)[sentAtField];
  const propStatus = (job as any)[field] ?? (sentAt ? "sent" : "unknown");
  const [status, setStatus] = useState<string>(propStatus);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Sync when parent updates the job prop (e.g., after auto-send)
  useEffect(() => {
    setStatus(propStatus);
  }, [propStatus, sentAt]);

  // If email was auto-sent, show green badge instead of dropdown
  if (sentAt && status === "sent") {
    const dateStr = new Date(sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return (
      <div className="mt-2 text-[10px] text-emerald-600 font-medium">
        Email sent {dateStr}
      </div>
    );
  }

  async function handleChange(newStatus: string) {
    setStatus(newStatus);
    setSaving(true);
    setSaved(false);
    try {
      await fetch(`/api/jobs/${job.application_id}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: newStatus }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {} finally {
      setSaving(false);
    }
  }

  const colors: Record<string, string> = {
    unknown: "bg-gray-50 text-gray-500 border-gray-200",
    sent: "bg-emerald-50 text-emerald-700 border-emerald-200",
    not_sent: "bg-amber-50 text-amber-700 border-amber-200",
  };

  return (
    <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <select
        value={status}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className={`text-[10px] font-medium rounded border px-1.5 py-0.5 ${colors[status] ?? colors.unknown} cursor-pointer`}
      >
        <option value="unknown">Email: Unknown</option>
        <option value="sent">Email: Sent</option>
        <option value="not_sent">Email: Not Sent</option>
      </select>
      {saving && <span className="text-[9px] text-gray-400">saving...</span>}
      {saved && <span className="text-[9px] text-emerald-500">saved</span>}
    </div>
  );
}

function SendInfoSessionEmailButton({ job }: { job: JobRow }) {
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>((job as any).info_session_email_sent_at ?? null);
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
      const res = await fetch("/api/jobs/send-info-session-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ application_id: job.application_id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed");
      } else {
        setSentAt(data.sentAt ?? new Date().toISOString());
      }
    } catch {
      setError("Network error");
    } finally {
      setSending(false);
    }
  }

  if (sentAt) {
    const dateStr = new Date(sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return (
      <div className="text-[10px]">
        <span className="text-emerald-600 font-medium">Invite sent {dateStr}</span>
        <button
          onClick={handleSend}
          disabled={sending}
          className="ml-1.5 text-gray-400 hover:text-cyan-600 transition-colors"
        >
          {sending ? "..." : "resend"}
        </button>
      </div>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button
        onClick={handleSend}
        disabled={sending || !job.email}
        className="text-[10px] font-medium px-2 py-1 rounded border border-cyan-300 bg-white text-cyan-700 hover:bg-cyan-50 disabled:opacity-40 transition-colors"
      >
        {sending ? "Sending..." : "Send Info Session Invite"}
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
  hasPrd,
}: {
  job: JobRow;
  onDragStart: (e: React.DragEvent, applicationId: number) => void;
  stage: PipelineStage;
  onToggleAttendance?: (applicationId: number, attended: boolean) => void;
  hasPrd?: boolean;
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
        {/* PRD upload status for prd_faa_review stage */}
        {stage === "prd_faa_review" && (
          hasPrd
            ? <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-700 border-emerald-200">PRD ✓</span>
            : <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">No PRD</span>
        )}
        {/* Interest check response for tims_review */}
        {stage === "tims_review" && job.interest_check_response && (
          job.interest_check_response === "yes"
            ? <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-700 border-emerald-200">Interested</span>
            : <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">Not Interested</span>
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

      {/* Email status for auto-send stages */}
      {stage === "interview_scheduled" && (
        <EmailStatusDropdown job={job} field="interview_email_status" />
      )}
      {stage === "info_session" && (
        <EmailStatusDropdown job={job} field="info_session_email_status" />
      )}

      {/* Info session email button (kept for manual resend) */}

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

const CARD_LIMIT = 8; // cards shown before "Show all"

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
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [expandedColumns, setExpandedColumns] = useState<Set<PipelineStage>>(new Set());
  const [collapsedColumns, setCollapsedColumns] = useState<Set<PipelineStage>>(new Set());
  const [prdUploaded, setPrdUploaded] = useState<Set<number>>(new Set());

  // Fetch PRD file status on mount
  useEffect(() => {
    fetch("/api/jobs/prd-status")
      .then((r) => r.json())
      .then((d) => { if (d.withPrd) setPrdUploaded(new Set(d.withPrd)); })
      .catch(() => {});
  }, []);

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
    if (categoryFilter && job.category !== categoryFilter) continue;
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

  // Count all (unfiltered) for category pills
  const categoryCounts: Record<string, number> = {};
  for (const job of jobs) {
    if (!(PIPELINE_STAGES as readonly string[]).includes(job.pipeline_stage ?? "")) continue;
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
        } else {
          // Update email status if auto-send happened
          const data = await res.json().catch(() => ({}));
          if (data.emailResult?.sent) {
            const now = new Date().toISOString();
            const statusField = newStage === "info_session" ? "info_session_email_status" : "interview_email_status";
            const sentField = newStage === "info_session" ? "info_session_email_sent_at" : "interview_email_sent_at";
            setJobs((prev) =>
              prev.map((j) =>
                j.application_id === appId
                  ? { ...j, [statusField]: "sent", [sentField]: now } as any
                  : j,
              ),
            );
          }
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
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-3">
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
        {/* Category filter pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setCategoryFilter(null)}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
              !categoryFilter
                ? "bg-slate-800 text-white border-slate-800"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
            }`}
          >
            All ({jobs.filter(j => (PIPELINE_STAGES as readonly string[]).includes(j.pipeline_stage ?? "")).length})
          </button>
          {CATEGORY_OPTIONS.filter(opt => categoryCounts[opt.value]).map(opt => (
            <button
              key={opt.value}
              onClick={() => setCategoryFilter(categoryFilter === opt.value ? null : opt.value)}
              className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
                categoryFilter === opt.value
                  ? "bg-slate-800 text-white border-slate-800"
                  : `${CATEGORY_COLORS[opt.value] ?? "bg-white text-gray-600 border-gray-200"} hover:opacity-80`
              }`}
            >
              {CATEGORY_LABELS[opt.value] ?? opt.label} ({categoryCounts[opt.value]})
            </button>
          ))}
        </div>
      </div>

      {/* Columns */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {PIPELINE_STAGES.map((stage) => {
          const meta = STAGE_META[stage];
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
                  ? "border-blue-400 bg-blue-50/50 ring-2 ring-blue-200"
                  : meta.color
              }`}
            >
              {/* Column header */}
              <button
                type="button"
                onClick={() => {
                  if (isCollapsed) {
                    setCollapsedColumns(prev => { const n = new Set(prev); n.delete(stage); return n; });
                  } else {
                    setCollapsedColumns(prev => new Set(prev).add(stage));
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
                    <span className="text-[10px] font-bold opacity-60">
                      {stageJobs.length}
                    </span>
                  </>
                )}
              </button>
              {!isCollapsed && meta.subtitle && (
                <div className="px-2 py-0.5 text-[9px] text-amber-600 bg-amber-50 border-b border-amber-200 text-center font-medium">
                  {meta.subtitle}
                </div>
              )}

              {!isCollapsed && (
                <>
                  {stage === "info_session" && (
                    <InfoSessionTools
                      jobs={stageJobs}
                      onAttendanceChecked={() => window.location.reload()}
                    />
                  )}
                  {stage === "interview_scheduled" && (
                    <div className="px-3 py-2 border-t border-fuchsia-100">
                      <MeetingLinkTool settingsKey="interview_calendly_url" placeholder="Calendly or Meet link..." borderColor="fuchsia" />
                    </div>
                  )}

                  {/* Cards */}
                  <div className="flex-1 p-2 space-y-2 min-h-[120px] max-h-[calc(100vh-260px)] overflow-y-auto">
                    {visibleJobs.map((job) => (
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
                          hasPrd={stage === "prd_faa_review" ? prdUploaded.has(job.application_id) : undefined}
                        />
                      </div>
                    ))}
                    {showLimit && (
                      <button
                        type="button"
                        onClick={() => setExpandedColumns(prev => new Set(prev).add(stage))}
                        className="w-full text-[11px] font-medium text-gray-500 hover:text-gray-700 bg-white border border-gray-200 rounded-lg py-2 hover:bg-gray-50 transition-colors"
                      >
                        Show {hiddenCount} more...
                      </button>
                    )}
                    {isExpanded && stageJobs.length > CARD_LIMIT && (
                      <button
                        type="button"
                        onClick={() => setExpandedColumns(prev => { const n = new Set(prev); n.delete(stage); return n; })}
                        className="w-full text-[11px] font-medium text-gray-400 hover:text-gray-600 bg-white border border-dashed border-gray-200 rounded-lg py-1.5 hover:bg-gray-50 transition-colors"
                      >
                        Collapse
                      </button>
                    )}
                    {stageJobs.length === 0 && (
                      <div className="text-xs text-gray-300 text-center py-8">
                        No candidates
                      </div>
                    )}
                  </div>
                </>
              )}
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
