"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useEffect } from "react";
import {
  GROUND_CATEGORY_LABELS,
  GROUND_CATEGORY_COLORS,
  GROUND_STAGE_META,
} from "@/lib/groundPipeline";

const PAGE_SIZE = 25;

function normalize(v: any) {
  return String(v ?? "").trim();
}

function fmtDate(s: any): string {
  const t = normalize(s);
  if (!t) return "\u2014";
  const d = new Date(t);
  if (isNaN(d.getTime())) return t.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function categoryLabel(raw: string): string {
  return GROUND_CATEGORY_LABELS[raw] ?? raw;
}

function categoryBadgeClass(raw: string): string {
  return GROUND_CATEGORY_COLORS[raw] ?? "bg-gray-100 text-gray-600 border-gray-200";
}

function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "\u2014";
  return GROUND_STAGE_META[stage]?.label ?? stage.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Multi-select dropdown
// ---------------------------------------------------------------------------

function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { key: string; label: string }[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
          selected.size > 0
            ? "bg-teal-700 text-white border-teal-700"
            : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
        }`}
      >
        {label}
        {selected.size > 0 && (
          <span className="text-[10px] font-bold text-white/70">{selected.size}</span>
        )}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 left-0 w-48 bg-white rounded-lg border border-gray-200 shadow-lg py-1">
          {options.map((opt) => (
            <label
              key={opt.key}
              className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.has(opt.key)}
                onChange={() => toggle(opt.key)}
                className="rounded border-gray-300 text-teal-700 focus:ring-teal-500"
              />
              {opt.label}
            </label>
          ))}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="w-full text-left px-3 py-1.5 text-[10px] text-gray-400 hover:text-gray-600 border-t border-gray-100 mt-1"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reassign button — move candidate to pilot pipeline
// ---------------------------------------------------------------------------

function ReassignButton({
  candidateId,
  candidateName,
  onReassigned,
}: {
  candidateId: number;
  candidateName: string;
  onReassigned: () => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [targetCategory, setTargetCategory] = useState("pilot_sic");
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowConfirm(false);
    }
    if (showConfirm) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [showConfirm]);

  async function handleReassign() {
    setLoading(true);
    try {
      const res = await fetch("/api/jobs/reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: candidateId, newCategory: targetCategory }),
      });
      if (res.ok) {
        setShowConfirm(false);
        onReassigned();
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setShowConfirm(true); }}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-300 hover:text-blue-600 hover:bg-blue-50 transition-colors"
        title="Move to pilot table"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3v10M3 8l5-5 5 5" />
        </svg>
      </button>
      {showConfirm && (
        <div
          className="absolute right-0 top-8 z-30 w-64 bg-white rounded-xl border border-gray-200 shadow-xl p-3 space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-sm font-medium text-gray-900">
            Move {candidateName.split(/\s+/)[0]} to pilot table?
          </div>
          <select
            value={targetCategory}
            onChange={(e) => setTargetCategory(e.target.value)}
            className="w-full text-xs rounded-lg border border-gray-200 px-2 py-1.5"
          >
            <option value="pilot_pic">PIC</option>
            <option value="pilot_sic">SIC</option>
            <option value="skillbridge">SkillBridge</option>
            <option value="dispatcher">Dispatcher</option>
          </select>
          <p className="text-[10px] text-gray-400">Pipeline stage will be reset</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowConfirm(false)}
              className="flex-1 text-xs py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleReassign}
              disabled={loading}
              className="flex-1 text-xs py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-50"
            >
              {loading ? "..." : "Move"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick reject button
// ---------------------------------------------------------------------------

function QuickRejectButton({
  applicationId,
  candidateName,
  onRejected,
}: {
  applicationId: number;
  candidateName: string;
  onRejected: () => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowConfirm(false);
    }
    if (showConfirm) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [showConfirm]);

  async function handleReject() {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${applicationId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rejection_type: "hard", rejection_reason: null, send_email: false }),
      });
      if (res.ok) {
        setShowConfirm(false);
        onRejected();
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setShowConfirm(true); }}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
        title="Quick reject"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
      {showConfirm && (
        <div
          className="absolute right-0 top-8 z-30 w-56 bg-white rounded-xl border border-gray-200 shadow-xl p-3 space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-sm font-medium text-gray-900">Reject {candidateName.split(/\s+/)[0]}?</div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowConfirm(false)} className="flex-1 text-xs py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={handleReject} disabled={loading} className="flex-1 text-xs py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 font-medium disabled:opacity-50">
              {loading ? "..." : "Reject"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Ground Table
// ---------------------------------------------------------------------------

export default function GroundTable({ initialJobs }: { initialJobs: any[] }) {
  const [q, setQ] = useState("");
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [showRejected, setShowRejected] = useState(false);
  const [showInPipeline, setShowInPipeline] = useState(false);
  const [recentlyRemoved, setRecentlyRemoved] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const j of initialJobs) {
      const c = normalize(j.category);
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => ({ key: k, label: categoryLabel(k) }));
  }, [initialJobs]);

  const SOURCE_OPTIONS = [
    { key: "google-form-intake", label: "Google Form" },
    { key: "manual", label: "Manual" },
    { key: "email", label: "Hiring@ Email" },
  ];

  const [sources, setSources] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const query = q.toLowerCase().trim();

    return initialJobs.filter((j) => {
      if (!showRejected && j.rejected_at) return false;
      if (recentlyRemoved.has(j.id)) return false;

      const inPipeline = j.pipeline_stage && j.pipeline_stage !== "";
      if (!showInPipeline && inPipeline) return false;

      if (sources.size > 0) {
        const jobSource = j.model === "google-form-intake" ? "google-form-intake" : j.model === "manual" ? "manual" : "email";
        if (!sources.has(jobSource)) return false;
      }

      const jCategory = normalize(j.category);
      if (categories.size > 0 && !categories.has(jCategory)) return false;

      if (!query) return true;

      const haystack = [
        j.application_id,
        j.candidate_name,
        j.email,
        j.phone,
        j.location,
        j.category,
        j.notes,
      ]
        .map((v) => String(v ?? "").toLowerCase())
        .join(" ");

      return haystack.includes(query);
    });
  }, [initialJobs, q, categories, showRejected, showInPipeline, sources, recentlyRemoved]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const hasActiveFilters = categories.size > 0 || sources.size > 0 || showRejected || showInPipeline || q !== "";

  const clear = () => {
    setQ("");
    setCategories(new Set());
    setSources(new Set());
    setShowRejected(false);
    setShowInPipeline(false);
    setPage(0);
  };

  return (
    <div className="p-4 sm:p-6 space-y-3 bg-gray-50 min-h-screen">
      {/* Filters */}
      <div className="rounded-xl border bg-white shadow-sm p-3 space-y-2.5">
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search name, email, location..."
            className="flex-1 max-w-md rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none focus:border-gray-400 focus:bg-white transition-colors"
          />
          <span className="text-xs text-gray-400 tabular-nums">{filtered.length} results</span>
          {hasActiveFilters && (
            <button onClick={clear} className="text-xs text-gray-500 hover:text-gray-800 underline">Reset</button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <MultiSelectDropdown
            label="Role"
            options={categoryOptions}
            selected={categories}
            onChange={(s) => { setCategories(s); setPage(0); }}
          />
          {categories.size > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {Array.from(categories).map((k) => (
                <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full bg-teal-50 text-teal-700 border border-teal-200">
                  {categoryLabel(k)}
                  <button type="button" onClick={() => { const s = new Set(categories); s.delete(k); setCategories(s); setPage(0); }} className="text-teal-400 hover:text-teal-600">&times;</button>
                </span>
              ))}
            </div>
          )}
          <div className="w-px h-5 bg-gray-200" />
          <MultiSelectDropdown
            label="Source"
            options={SOURCE_OPTIONS}
            selected={sources}
            onChange={(s) => { setSources(s); setPage(0); }}
          />
          <div className="w-px h-5 bg-gray-200" />
          <button
            type="button"
            onClick={() => { setShowInPipeline(!showInPipeline); setPage(0); }}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
              showInPipeline ? "bg-teal-50 text-teal-600 border-teal-200" : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
            }`}
          >
            Show in pipeline
          </button>
          <button
            type="button"
            onClick={() => { setShowRejected(!showRejected); setPage(0); }}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
              showRejected ? "bg-red-50 text-red-600 border-red-200" : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
            }`}
          >
            Show rejected
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50/80 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-2.5">Candidate</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Location</th>
                <th className="px-4 py-2.5">Stage</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="px-4 py-2.5 text-right">Date</th>
                <th className="px-4 py-2.5 w-24"></th>
              </tr>
            </thead>

            <tbody className="divide-y divide-gray-100">
              {paged.map((j) => (
                <tr key={j.id ?? j.application_id} className="hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-gray-900 truncate max-w-[200px]">{j.candidate_name ?? "\u2014"}</span>
                      {j.rejected_at && (
                        <span className="inline-block rounded-full border border-red-200 bg-red-50 text-red-600 px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap">Rejected</span>
                      )}
                    </div>
                    {j.email && <div className="text-xs text-gray-400 truncate max-w-[200px]">{j.email}</div>}
                  </td>

                  <td className="px-4 py-2.5">
                    {j.category ? (
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${categoryBadgeClass(j.category)}`}>
                        {categoryLabel(j.category)}
                      </span>
                    ) : (
                      <span className="text-gray-300">{"\u2014"}</span>
                    )}
                  </td>

                  <td className="px-4 py-2.5 text-gray-600 truncate max-w-[160px]">
                    {j.location ?? <span className="text-gray-300">{"\u2014"}</span>}
                  </td>

                  <td className="px-4 py-2.5">
                    {j.pipeline_stage ? (
                      <span className="inline-block rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                        {stageLabel(j.pipeline_stage)}
                      </span>
                    ) : (
                      <span className="text-gray-300">{"\u2014"}</span>
                    )}
                  </td>

                  <td className="px-4 py-2.5">
                    {j.model === "google-form-intake" ? (
                      <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">Google</span>
                    ) : j.model === "manual" ? (
                      <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-gray-50 text-gray-500 border-gray-200">Manual</span>
                    ) : j.model ? (
                      <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-600 border-indigo-200">Hiring@</span>
                    ) : (
                      <span className="text-gray-300">{"\u2014"}</span>
                    )}
                  </td>

                  <td className="px-4 py-2.5 text-right text-xs text-gray-400 whitespace-nowrap">
                    {fmtDate(j.created_at)}
                  </td>

                  <td className="px-2 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <ReassignButton
                        candidateId={j.id}
                        candidateName={j.candidate_name ?? "Unknown"}
                        onReassigned={() => setRecentlyRemoved((prev) => new Set(prev).add(j.id))}
                      />
                      {!j.rejected_at && (
                        <QuickRejectButton
                          applicationId={j.application_id}
                          candidateName={j.candidate_name ?? "Unknown"}
                          onRejected={() => setRecentlyRemoved((prev) => new Set(prev).add(j.id))}
                        />
                      )}
                      {j.application_id ? (
                        <Link
                          href={`/jobs/${j.application_id}`}
                          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 3l5 5-5 5" />
                          </svg>
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}

              {paged.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    No ground candidates match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="h-8 rounded-lg border bg-white px-3 text-xs font-medium hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <span className="text-xs text-gray-400 tabular-nums px-2">
            {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="h-8 rounded-lg border bg-white px-3 text-xs font-medium hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
