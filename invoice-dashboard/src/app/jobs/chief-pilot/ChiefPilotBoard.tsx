"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Candidate {
  id: number;
  application_id: number;
  candidate_name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  category: string | null;
  employment_type: string | null;
  total_time_hours: number | null;
  turbine_time_hours: number | null;
  pic_time_hours: number | null;
  sic_time_hours: number | null;
  has_citation_x: boolean | null;
  has_challenger_300_type_rating: boolean | null;
  type_ratings: string[] | null;
  has_part_135: boolean | null;
  has_part_121: boolean | null;
  pipeline_stage: string | null;
  structured_notes: {
    hr_notes?: string;
    prd_review_notes?: string;
    tims_notes?: string;
    chief_pilot_notes?: string;
  } | null;
  prd_flags: Record<string, any> | null;
  prd_summary: string | null;
  prd_type_ratings: string[] | null;
  prd_certificate_type: string | null;
  prd_medical_class: string | null;
  created_at: string | null;
  notes: string | null;
  interview_email_sent_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
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

const CATEGORY_COLORS: Record<string, string> = {
  pilot_pic: "bg-emerald-100 text-emerald-800 border-emerald-200",
  pilot_sic: "bg-sky-100 text-sky-800 border-sky-200",
  skillbridge: "bg-cyan-100 text-cyan-800 border-cyan-200",
  dispatcher: "bg-violet-100 text-violet-800 border-violet-200",
  maintenance: "bg-amber-100 text-amber-800 border-amber-200",
};

function fmtHours(v: number | null): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ---------------------------------------------------------------------------
// File viewer (inline PDF/DOCX)
// ---------------------------------------------------------------------------

function isDocx(f: any): boolean {
  const ct = (f.content_type ?? "").toLowerCase();
  const fn = (f.filename ?? "").toLowerCase();
  return ct.includes("wordprocessingml") || ct.includes("msword") || fn.endsWith(".docx") || fn.endsWith(".doc");
}

function isPdf(f: any): boolean {
  const ct = (f.content_type ?? "").toLowerCase();
  const fn = (f.filename ?? "").toLowerCase();
  return ct.includes("pdf") || fn.endsWith(".pdf");
}

function FileItem({ file }: { file: any }) {
  const [open, setOpen] = useState(false);
  const url = file.signed_url;
  const canViewInline = !!url && (isPdf(file) || (isDocx(file) && !!file.signed_url));
  const viewerSrc = isPdf(file) && url
    ? url
    : isDocx(file) && file.signed_url
    ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(file.signed_url)}`
    : null;

  const categoryLabel: Record<string, string> = {
    resume: "Resume",
    prd: "PRD",
    lor: "LOR",
    cover_letter: "Cover Letter",
  };

  return (
    <div className="border rounded-lg overflow-hidden bg-white">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-xs truncate">{file.filename ?? "file"}</div>
          <div className="text-[10px] text-gray-400">
            {categoryLabel[file.file_category] ?? file.file_category ?? "Document"}
            {typeof file.size_bytes === "number" ? ` · ${(file.size_bytes / 1024).toFixed(0)} KB` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canViewInline && (
            <button
              onClick={() => setOpen(!open)}
              className="text-[10px] px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 font-medium text-gray-600"
            >
              {open ? "Hide" : "View"}
            </button>
          )}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-blue-600 hover:underline whitespace-nowrap font-medium"
            >
              Open →
            </a>
          )}
        </div>
      </div>
      {open && viewerSrc && (
        <div className="border-t bg-gray-50">
          <iframe
            src={viewerSrc}
            className="w-full"
            style={{ height: "600px" }}
            title={file.filename ?? "file"}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Candidate Detail Panel
// ---------------------------------------------------------------------------

function CandidateDetail({
  candidate,
  onClose,
  onNoteSaved,
  onMarkedComplete,
}: {
  candidate: Candidate;
  onClose: () => void;
  onNoteSaved: (appId: number, notes: string) => void;
  onMarkedComplete: (appId: number) => void;
}) {
  const [notes, setNotes] = useState(candidate.structured_notes?.chief_pilot_notes ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [marking, setMarking] = useState(false);
  const [files, setFiles] = useState<any[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const savedTimeout = useRef<NodeJS.Timeout | null>(null);
  const isPilot = candidate.category === "pilot_pic" || candidate.category === "pilot_sic";

  // Fetch files when modal opens
  useEffect(() => {
    async function loadFiles() {
      try {
        const res = await fetch(`/api/jobs/chief-pilot/files?application_id=${candidate.application_id}`);
        if (res.ok) {
          const data = await res.json();
          setFiles(data.files ?? []);
        }
      } catch {
        // silent
      } finally {
        setFilesLoading(false);
      }
    }
    loadFiles();
  }, [candidate.application_id]);

  async function handleSaveNotes() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/jobs/chief-pilot", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          application_id: candidate.application_id,
          chief_pilot_notes: notes,
        }),
      });
      if (res.ok) {
        setSaved(true);
        onNoteSaved(candidate.application_id, notes);
        if (savedTimeout.current) clearTimeout(savedTimeout.current);
        savedTimeout.current = setTimeout(() => setSaved(false), 3000);
      }
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkComplete() {
    if (!confirm(`Mark ${candidate.candidate_name}'s interview as complete?`)) return;
    setMarking(true);
    try {
      const res = await fetch("/api/jobs/chief-pilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ application_id: candidate.application_id }),
      });
      if (res.ok) {
        onMarkedComplete(candidate.application_id);
      }
    } catch {
      // silent
    } finally {
      setMarking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-12 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 mb-12"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {candidate.candidate_name ?? "Unknown Candidate"}
            </h2>
            <div className="text-sm text-gray-500">
              {candidate.email ?? "—"}
              {candidate.phone ? ` · ${candidate.phone}` : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2"
          >
            &times;
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Basic info */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-gray-400">Category:</span>{" "}
              <span className="font-medium">
                {CATEGORY_LABELS[candidate.category ?? ""] ?? candidate.category ?? "—"}
              </span>
            </div>
            <div>
              <span className="text-gray-400">Location:</span>{" "}
              <span className="font-medium">{candidate.location ?? "—"}</span>
            </div>
            {candidate.employment_type && (
              <div>
                <span className="text-gray-400">Employment:</span>{" "}
                <span className="font-medium">{candidate.employment_type}</span>
              </div>
            )}
          </div>

          {/* Pilot hours */}
          {isPilot && (
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Flight Hours</div>
              <div className="grid grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-gray-400 text-xs">Total Time</div>
                  <div className="font-mono font-medium">{fmtHours(candidate.total_time_hours)}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">PIC</div>
                  <div className="font-mono font-medium">{fmtHours(candidate.pic_time_hours)}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">SIC</div>
                  <div className="font-mono font-medium">{fmtHours(candidate.sic_time_hours)}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">Turbine</div>
                  <div className="font-mono font-medium">{fmtHours(candidate.turbine_time_hours)}</div>
                </div>
              </div>

              {/* Type ratings */}
              {candidate.type_ratings && candidate.type_ratings.length > 0 && (
                <div className="mt-3">
                  <div className="text-xs text-gray-400 mb-1">Type Ratings</div>
                  <div className="flex flex-wrap gap-1">
                    {candidate.type_ratings.map((tr) => (
                      <span key={tr} className="inline-block rounded border px-1.5 py-0.5 text-[10px] font-mono bg-blue-50 text-blue-700 border-blue-200">
                        {tr}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Part 135/121 */}
              <div className="mt-2 flex gap-2">
                {candidate.has_part_135 && (
                  <span className="inline-block rounded-full border border-orange-200 bg-orange-50 text-orange-700 px-2 py-0.5 text-xs font-semibold">Part 135</span>
                )}
                {candidate.has_part_121 && (
                  <span className="inline-block rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 px-2 py-0.5 text-xs font-semibold">Part 121</span>
                )}
              </div>
            </div>
          )}

          {/* PRD Summary */}
          {candidate.prd_summary && (
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">PRD Summary</div>
              {candidate.prd_flags && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {Object.entries(candidate.prd_flags).some(([k, v]) => k !== "flag_details" && k !== "notices_of_disapproval_count" && k !== "accidents_count" && v === true) ? (
                    <>
                      {candidate.prd_flags.failed_checkrides && <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-100 text-red-700 border-red-300">Failed Checkrides</span>}
                      {candidate.prd_flags.accidents && <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-100 text-red-700 border-red-300">Accidents</span>}
                      {candidate.prd_flags.incidents && <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-100 text-red-700 border-red-300">Incidents</span>}
                      {candidate.prd_flags.enforcements && <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-100 text-red-700 border-red-300">Enforcements</span>}
                      {candidate.prd_flags.terminations_for_cause && <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-100 text-red-700 border-red-300">Terminated</span>}
                      {candidate.prd_flags.short_tenures && <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700 border-amber-300">Short Tenures</span>}
                    </>
                  ) : (
                    <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-700 border-emerald-200">PRD Clean</span>
                  )}
                </div>
              )}
              <div className="text-sm text-gray-700">{candidate.prd_summary}</div>
              {candidate.prd_certificate_type && (
                <div className="mt-1 text-xs text-gray-500">
                  Certificate: {candidate.prd_certificate_type}
                  {candidate.prd_medical_class ? ` · Medical: ${candidate.prd_medical_class} Class` : ""}
                </div>
              )}
            </div>
          )}

          {/* Candidate notes (read-only) */}
          {candidate.notes && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
              <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide mb-1">Application Notes</div>
              <div className="text-sm text-gray-700 whitespace-pre-wrap">{candidate.notes}</div>
            </div>
          )}

          {/* Documents */}
          <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Documents
              {!filesLoading && files.length > 0 && (
                <span className="font-normal text-gray-400 ml-1">({files.length})</span>
              )}
            </div>
            {filesLoading ? (
              <div className="text-xs text-gray-400">Loading documents...</div>
            ) : files.length === 0 ? (
              <div className="text-xs text-gray-400">No documents uploaded.</div>
            ) : (
              <div className="space-y-2">
                {files.map((f) => (
                  <FileItem key={f.id} file={f} />
                ))}
              </div>
            )}
          </div>

          {/* Chief Pilot Notes (editable) */}
          <div className="rounded-lg border-2 border-red-200 bg-white p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-red-700 uppercase tracking-wide">Chief Pilot Notes</div>
              <div className="flex items-center gap-2">
                {saving && <span className="text-[10px] text-gray-400">saving...</span>}
                {saved && <span className="text-[10px] text-emerald-500 font-medium">saved</span>}
              </div>
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={handleSaveNotes}
              placeholder="Write your interview notes here..."
              rows={5}
              className="w-full text-sm border border-gray-200 rounded-lg p-2 resize-y focus:border-red-300 focus:outline-none focus:ring-1 focus:ring-red-200"
            />
            <button
              onClick={handleSaveNotes}
              disabled={saving}
              className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : "Save Notes"}
            </button>
          </div>

          {/* Mark Complete */}
          <div className="flex justify-end pt-2 border-t border-gray-100">
            <button
              onClick={handleMarkComplete}
              disabled={marking}
              className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {marking ? "Updating..." : "Mark Interview Complete"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Candidate Card (list item)
// ---------------------------------------------------------------------------

function CandidateCard({
  candidate,
  onClick,
}: {
  candidate: Candidate;
  onClick: () => void;
}) {
  const isPilot = candidate.category === "pilot_pic" || candidate.category === "pilot_sic";
  const catLabel = CATEGORY_LABELS[candidate.category ?? ""] ?? candidate.category;
  const catColor = CATEGORY_COLORS[candidate.category ?? ""] ?? "bg-gray-100 text-gray-600 border-gray-200";
  const hasNotes = !!(candidate.structured_notes?.chief_pilot_notes);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-xl border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md hover:border-gray-300 transition-all"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-gray-900">
            {candidate.candidate_name ?? "Unknown"}
          </div>
          <div className="text-sm text-gray-500 mt-0.5">
            {candidate.email ?? "—"}
            {candidate.location ? ` · ${candidate.location}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {candidate.category && (
            <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${catColor}`}>
              {catLabel}
            </span>
          )}
          {hasNotes && (
            <span className="inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">
              Notes
            </span>
          )}
        </div>
      </div>

      {isPilot && (candidate.total_time_hours || candidate.pic_time_hours) && (
        <div className="flex gap-4 mt-2 text-xs text-gray-500 font-mono">
          {candidate.total_time_hours != null && <span>TT {fmtHours(candidate.total_time_hours)}</span>}
          {candidate.pic_time_hours != null && <span>PIC {fmtHours(candidate.pic_time_hours)}</span>}
          {candidate.turbine_time_hours != null && <span>Turb {fmtHours(candidate.turbine_time_hours)}</span>}
        </div>
      )}

      {/* PRD flags preview */}
      {candidate.prd_flags && Object.entries(candidate.prd_flags).some(([k, v]) => k !== "flag_details" && k !== "notices_of_disapproval_count" && k !== "accidents_count" && v === true) && (
        <div className="flex flex-wrap gap-1 mt-2">
          <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">
            PRD Flags
          </span>
        </div>
      )}

      <div className="flex items-center justify-between mt-2">
        <span className="text-[10px] text-gray-300">
          {candidate.created_at ? new Date(candidate.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}
        </span>
        <span className="text-xs text-fuchsia-600 font-medium">
          View Profile →
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main Board
// ---------------------------------------------------------------------------

export default function ChiefPilotBoard() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/jobs/chief-pilot");
        if (!res.ok) {
          setError("Failed to load candidates");
          return;
        }
        const data = await res.json();
        setCandidates(data.candidates ?? []);
      } catch {
        setError("Network error");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleNoteSaved = useCallback((appId: number, notes: string) => {
    setCandidates((prev) =>
      prev.map((c) =>
        c.application_id === appId
          ? { ...c, structured_notes: { ...c.structured_notes, chief_pilot_notes: notes } }
          : c,
      ),
    );
  }, []);

  const handleMarkedComplete = useCallback((appId: number) => {
    setCandidates((prev) => prev.filter((c) => c.application_id !== appId));
    setSelectedId(null);
  }, []);

  const selected = candidates.find((c) => c.application_id === selectedId) ?? null;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-gray-400 text-sm">Loading candidates...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Scheduled for Interview</h1>
        <p className="text-sm text-gray-500 mt-1">
          {candidates.length} candidate{candidates.length !== 1 ? "s" : ""} awaiting interview.
          Click a candidate to view their profile, write notes, and mark interview complete.
        </p>
      </div>

      {candidates.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-12 text-center">
          <div className="text-gray-400 text-sm">No candidates scheduled for interview right now.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {candidates.map((c) => (
            <CandidateCard
              key={c.application_id}
              candidate={c}
              onClick={() => setSelectedId(c.application_id)}
            />
          ))}
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <CandidateDetail
          candidate={selected}
          onClose={() => setSelectedId(null)}
          onNoteSaved={handleNoteSaved}
          onMarkedComplete={handleMarkedComplete}
        />
      )}
    </div>
  );
}
