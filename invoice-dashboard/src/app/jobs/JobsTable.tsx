"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Display labels & colors
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
  sales: "bg-pink-100 text-pink-800 border-pink-200",
  hr: "bg-indigo-100 text-indigo-800 border-indigo-200",
  admin: "bg-slate-100 text-slate-700 border-slate-200",
  management: "bg-orange-100 text-orange-800 border-orange-200",
  line_service: "bg-teal-100 text-teal-800 border-teal-200",
  other: "bg-gray-100 text-gray-600 border-gray-200",
};

function categoryLabel(raw: string): string {
  return CATEGORY_LABELS[raw] ?? raw;
}

function categoryBadgeClass(raw: string): string {
  return CATEGORY_COLORS[raw] ?? "bg-gray-100 text-gray-600 border-gray-200";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(v: any) {
  return String(v ?? "").trim();
}

function fmtDate(s: any): string {
  const t = normalize(s);
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return t.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function fmtHours(v: any): string {
  if (v == null) return "—";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function hasSkillbridge(j: any): boolean {
  const haystack = [j.notes, j.category, ...(Array.isArray(j.type_ratings) ? j.type_ratings : [])]
    .join(" ")
    .toLowerCase();
  return haystack.includes("skillbridge") || haystack.includes("skill bridge");
}

function hasCitationX(j: any): boolean {
  const ratings: string[] = Array.isArray(j.type_ratings) ? j.type_ratings : [];
  const inRatings = ratings.some((r) => {
    const u = r.toLowerCase();
    return u.includes("ce-750") || u.includes("ce750") || u.includes("c750") || u.includes("citation x") || u.includes("citation-x");
  });
  // Trust the boolean only when corroborated by the ratings list (GPT sometimes mis-flags other Citation variants)
  return inRatings || (j.has_citation_x === true && ratings.length === 0);
}

function hasChallenger(j: any): boolean {
  if (j.has_challenger_300_type_rating === true) return true;
  const ratings: string[] = Array.isArray(j.type_ratings) ? j.type_ratings : [];
  return ratings.some((r) => {
    const u = r.toLowerCase();
    return u.includes("cl-300") || u.includes("cl300") || u.includes("cl-30") || u.includes("challenger 300") || u.includes("challenger-300");
  });
}

function hasPart135(j: any): boolean {
  if (j.has_part_135 === true) return true;
  if (j.has_part_135 === false) return false;
  const haystack = [j.notes, ...(Array.isArray(j.type_ratings) ? j.type_ratings : [])]
    .join(" ")
    .toLowerCase();
  return /part\s?135|far\s?135|on-demand|charter/.test(haystack);
}

function hasPart121(j: any): boolean {
  if (j.has_part_121 === true) return true;
  if (j.has_part_121 === false) return false;
  const haystack = [j.notes, ...(Array.isArray(j.type_ratings) ? j.type_ratings : [])]
    .join(" ")
    .toLowerCase();
  return /part\s?121|far\s?121|airline|air carrier/.test(haystack);
}

function picGateShort(status: string | null, met: boolean | null | undefined): { label: string; cls: string } | null {
  if (status) {
    const s = status.toLowerCase();
    if (s === "pass" || s.startsWith("meets")) return { label: "Met", cls: "text-emerald-700 bg-emerald-50 border-emerald-200" };
    if (s.startsWith("close") || s.includes("near")) return { label: "Close", cls: "text-amber-700 bg-amber-50 border-amber-200" };
    if (s === "missing_time") return null; // no hours data — show nothing
    return { label: "Not met", cls: "text-gray-500 bg-gray-50 border-gray-200" };
  }
  // Fallback: use the boolean soft_gate_pic_met for older rows without a status string
  if (met === true) return { label: "Met", cls: "text-emerald-700 bg-emerald-50 border-emerald-200" };
  if (met === false) return { label: "Not met", cls: "text-gray-500 bg-gray-50 border-gray-200" };
  return null;
}

// ---------------------------------------------------------------------------
// Filter pill component
// ---------------------------------------------------------------------------

type FilterOption = { key: string; label: string; count?: number };

function FilterPills({ options, value, onChange }: { options: FilterOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {options.map((opt) => {
        const active = value === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
              active
                ? "bg-slate-800 text-white border-slate-800"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
            }`}
          >
            {opt.label}
            {opt.count !== undefined && opt.count > 0 && (
              <span className={`text-[10px] font-bold ${active ? "text-white/70" : "text-gray-400"}`}>
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-select dropdown with checkboxes
// ---------------------------------------------------------------------------

function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  mode,
  onModeChange,
}: {
  label: string;
  options: { key: string; label: string }[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  mode?: "AND" | "OR";
  onModeChange?: (m: "AND" | "OR") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const showModeToggle = mode !== undefined && onModeChange !== undefined;

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
            ? "bg-slate-800 text-white border-slate-800"
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
          {showModeToggle && selected.size > 1 && (
            <div className="px-3 py-1.5 border-b border-gray-100 flex items-center gap-1.5">
              <span className="text-[10px] text-gray-400">Match:</span>
              <button
                type="button"
                onClick={() => onModeChange("AND")}
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-colors ${
                  mode === "AND"
                    ? "bg-slate-800 text-white border-slate-800"
                    : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => onModeChange("OR")}
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-colors ${
                  mode === "OR"
                    ? "bg-slate-800 text-white border-slate-800"
                    : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
                }`}
              >
                Any
              </button>
            </div>
          )}
          {options.map((opt) => (
            <label
              key={opt.key}
              className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.has(opt.key)}
                onChange={() => toggle(opt.key)}
                className="rounded border-gray-300 text-slate-800 focus:ring-slate-500"
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
// Quick reject button (inline on table row)
// ---------------------------------------------------------------------------

function QuickRejectButton({
  applicationId,
  candidateName,
  candidateEmail,
  onRejected,
}: {
  applicationId: number;
  candidateName: string;
  candidateEmail: string | null;
  onRejected: () => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [sendEmail, setSendEmail] = useState(true);
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
        body: JSON.stringify({
          rejection_type: "hard",
          rejection_reason: null,
          send_email: sendEmail,
        }),
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
          className="absolute right-0 top-8 z-30 w-64 bg-white rounded-xl border border-gray-200 shadow-xl p-3 space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-sm font-medium text-gray-900">
            Reject {candidateName.split(/\s+/)[0]}?
          </div>
          {candidateEmail && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
                className="rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <span className="text-xs text-gray-600">Send rejection email</span>
            </label>
          )}
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
              onClick={handleReject}
              disabled={loading}
              className="flex-1 text-xs py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 font-medium disabled:opacity-50"
            >
              {loading ? "..." : "Reject"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main table
// ---------------------------------------------------------------------------

export default function JobsTable({ initialJobs }: { initialJobs: any[] }) {
  const [q, setQ] = useState("");
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [softGate, setSoftGate] = useState("ALL");
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [tagMode, setTagMode] = useState<"AND" | "OR">("OR");
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [showRejected, setShowRejected] = useState(false);
  const [showInPipeline, setShowInPipeline] = useState(false);
  const [recentlyRejected, setRecentlyRejected] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);

  // Build a set of emails that have been rejected (for "Prev. Rejected" badge)
  const rejectedEmails = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const j of initialJobs) {
      if (j.rejected_at && j.email) {
        const e = j.email.toLowerCase();
        if (!map.has(e)) map.set(e, []);
        map.get(e)!.push(j.id);
      }
    }
    return map;
  }, [initialJobs]);

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

  const TAG_OPTIONS: { key: string; label: string; test: (j: any) => boolean }[] = [
    { key: "CE-750", label: "CE-750", test: hasCitationX },
    { key: "CL-300", label: "CL-300", test: hasChallenger },
    { key: "SkillBridge", label: "SkillBridge", test: hasSkillbridge },
    { key: "Part 135", label: "Part 135", test: hasPart135 },
    { key: "Airline", label: "Airline", test: hasPart121 },
  ];

  const filtered = useMemo(() => {
    const query = q.toLowerCase().trim();

    return initialJobs.filter((j) => {
      // Hide rejected by default unless toggled
      if (!showRejected && j.rejected_at) return false;
      if (recentlyRejected.has(j.application_id)) return false;

      // Hide candidates already in the pipeline unless toggled
      const inPipeline = j.pipeline_stage && j.pipeline_stage !== "";
      if (!showInPipeline && inPipeline) return false;

      // Source filter
      if (sources.size > 0) {
        const jobSource = j.model === "google-form-intake" ? "google-form-intake" : j.model === "manual" ? "manual" : "email";
        if (!sources.has(jobSource)) return false;
      }

      const jCategory = normalize(j.category);
      const jSoft = normalize(j.soft_gate_pic_status);

      if (categories.size > 0 && !categories.has(jCategory)) return false;
      const softLower = jSoft.toLowerCase();
      const isMet = softLower === "pass" || softLower.startsWith("meets");
      if (softGate === "MET" && !isMet) return false;
      if (softGate === "NOT_MET" && isMet) return false;

      // Tags filter: AND = must match ALL, OR = must match at least ONE
      if (tags.size > 0) {
        if (tagMode === "AND") {
          for (const t of tags) {
            const opt = TAG_OPTIONS.find((o) => o.key === t);
            if (opt && !opt.test(j)) return false;
          }
        } else {
          let matchedAny = false;
          for (const t of tags) {
            const opt = TAG_OPTIONS.find((o) => o.key === t);
            if (opt && opt.test(j)) { matchedAny = true; break; }
          }
          if (!matchedAny) return false;
        }
      }

      if (!query) return true;

      const haystack = [
        j.application_id,
        j.candidate_name,
        j.email,
        j.phone,
        j.location,
        j.category,
        j.employment_type,
        j.soft_gate_pic_status,
        j.notes,
        ...(Array.isArray(j.type_ratings) ? j.type_ratings : []),
      ]
        .map((v) => String(v ?? "").toLowerCase())
        .join(" ");

      return haystack.includes(query);
    });
  }, [initialJobs, q, categories, softGate, tags, tagMode, showRejected, showInPipeline, sources, recentlyRejected]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const hasActiveFilters = categories.size > 0 || softGate !== "ALL" || tags.size > 0 || sources.size > 0 || showRejected || showInPipeline || q !== "";

  const clear = () => {
    setQ("");
    setCategories(new Set());
    setSoftGate("ALL");
    setTags(new Set());
    setTagMode("AND");
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
            placeholder="Search name, email, location, rating..."
            className="flex-1 max-w-md rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none focus:border-gray-400 focus:bg-white transition-colors"
          />
          <span className="text-xs text-gray-400 tabular-nums">{filtered.length} results</span>
          {hasActiveFilters && (
            <button onClick={clear} className="text-xs text-gray-500 hover:text-gray-800 underline">
              Reset
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <MultiSelectDropdown
            label="Job Type"
            options={categoryOptions}
            selected={categories}
            onChange={(s) => { setCategories(s); setPage(0); }}
          />
          {categories.size > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {Array.from(categories).map((k) => (
                <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                  {categoryLabel(k)}
                  <button type="button" onClick={() => { const s = new Set(categories); s.delete(k); setCategories(s); setPage(0); }} className="text-slate-400 hover:text-slate-600">&times;</button>
                </span>
              ))}
            </div>
          )}
          <div className="w-px h-5 bg-gray-200" />
          <FilterPills
            options={[
              { key: "ALL", label: "PIC Gate" },
              { key: "MET", label: "Met" },
              { key: "NOT_MET", label: "Not met" },
            ]}
            value={softGate}
            onChange={(v) => { setSoftGate(v); setPage(0); }}
          />
          <div className="w-px h-5 bg-gray-200" />
          <MultiSelectDropdown
            label="Tags"
            options={TAG_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
            selected={tags}
            onChange={(s) => { setTags(s); setPage(0); }}
            mode={tagMode}
            onModeChange={(m) => { setTagMode(m); setPage(0); }}
          />
          {tags.size > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {tags.size > 1 && (
                <button
                  type="button"
                  onClick={() => { setTagMode(tagMode === "AND" ? "OR" : "AND"); setPage(0); }}
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-gray-300 bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors"
                  title={tagMode === "AND" ? "Showing candidates with ALL tags — click for ANY" : "Showing candidates with ANY tag — click for ALL"}
                >
                  {tagMode === "AND" ? "ALL" : "ANY"}
                </button>
              )}
              {Array.from(tags).map((k) => (
                <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                  {k}
                  <button type="button" onClick={() => { const s = new Set(tags); s.delete(k); setTags(s); setPage(0); }} className="text-slate-400 hover:text-slate-600">&times;</button>
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
          {sources.size > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {Array.from(sources).map((k) => (
                <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                  {SOURCE_OPTIONS.find(o => o.key === k)?.label ?? k}
                  <button type="button" onClick={() => { const s = new Set(sources); s.delete(k); setSources(s); setPage(0); }} className="text-slate-400 hover:text-slate-600">&times;</button>
                </span>
              ))}
            </div>
          )}
          <div className="w-px h-5 bg-gray-200" />
          <button
            type="button"
            onClick={() => { setShowInPipeline(!showInPipeline); setPage(0); }}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
              showInPipeline
                ? "bg-blue-50 text-blue-600 border-blue-200"
                : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
            }`}
          >
            Show in pipeline
          </button>
          <button
            type="button"
            onClick={() => { setShowRejected(!showRejected); setPage(0); }}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
              showRejected
                ? "bg-red-50 text-red-600 border-red-200"
                : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
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
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5">Location</th>
                <th className="px-4 py-2.5 text-right">TT</th>
                <th className="px-4 py-2.5 text-right">PIC</th>
                <th className="px-4 py-2.5">PIC Gate</th>
                <th className="px-4 py-2.5">Ratings</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="px-4 py-2.5 text-right">Date</th>
                <th className="px-4 py-2.5 w-20"></th>
              </tr>
            </thead>

            <tbody className="divide-y divide-gray-100">
              {paged.map((j) => {
                const isPilot = j.category === "pilot_pic" || j.category === "pilot_sic";
                const gate = isPilot ? picGateShort(j.soft_gate_pic_status, j.soft_gate_pic_met) : null;
                return (
                  <tr key={j.id ?? j.application_id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-gray-900 truncate max-w-[200px]">{j.candidate_name ?? "—"}</span>
                        {j.rejected_at && (
                          <span className="inline-block rounded-full border border-red-200 bg-red-50 text-red-600 px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap">
                            Rejected
                          </span>
                        )}
                        {!j.rejected_at && j.email && rejectedEmails.has(j.email.toLowerCase()) && (
                          <span className="inline-block rounded-full border border-amber-200 bg-amber-50 text-amber-700 px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap">
                            Prev. Rejected
                          </span>
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
                        <span className="text-gray-300">—</span>
                      )}
                    </td>

                    <td className="px-4 py-2.5 text-gray-600 truncate max-w-[160px]">
                      {j.location ?? <span className="text-gray-300">—</span>}
                    </td>

                    <td className="px-4 py-2.5 text-right font-mono text-gray-700 tabular-nums">
                      {fmtHours(j.total_time_hours)}
                    </td>

                    <td className="px-4 py-2.5 text-right font-mono text-gray-700 tabular-nums">
                      {fmtHours(j.pic_time_hours)}
                    </td>

                    <td className="px-4 py-2.5">
                      {gate ? (
                        <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${gate.cls}`}
                          title={j.soft_gate_pic_status ?? ""}
                        >
                          {gate.label}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>

                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {hasCitationX(j) && (
                          <span className="inline-block rounded border border-emerald-200 bg-emerald-50 text-emerald-700 px-1.5 py-0.5 text-[10px] font-semibold">
                            CE-750
                          </span>
                        )}
                        {hasChallenger(j) && (
                          <span className="inline-block rounded border border-blue-200 bg-blue-50 text-blue-700 px-1.5 py-0.5 text-[10px] font-semibold">
                            CL-300
                          </span>
                        )}
                        {hasSkillbridge(j) && (
                          <span className="inline-block rounded border border-purple-200 bg-purple-50 text-purple-700 px-1.5 py-0.5 text-[10px] font-semibold">
                            SB
                          </span>
                        )}
                        {hasPart135(j) && (
                          <span className="inline-block rounded border border-orange-200 bg-orange-50 text-orange-700 px-1.5 py-0.5 text-[10px] font-semibold">
                            135
                          </span>
                        )}
                        {hasPart121(j) && (
                          <span className="inline-block rounded border border-indigo-200 bg-indigo-50 text-indigo-700 px-1.5 py-0.5 text-[10px] font-semibold">
                            121
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-2.5">
                      {j.model === "google-form-intake" ? (
                        <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border-red-200">Google</span>
                      ) : j.model === "manual" ? (
                        <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-gray-50 text-gray-500 border-gray-200">Manual</span>
                      ) : j.model ? (
                        <span className="inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-600 border-indigo-200">Hiring@</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>

                    <td className="px-4 py-2.5 text-right text-xs text-gray-400 whitespace-nowrap">
                      {fmtDate(j.created_at)}
                    </td>

                    <td className="px-2 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {!j.rejected_at && (
                          <QuickRejectButton
                            applicationId={j.application_id}
                            candidateName={j.candidate_name ?? "Unknown"}
                            candidateEmail={j.email ?? null}
                            onRejected={() => {
                              setRecentlyRejected((prev) => new Set(prev).add(j.application_id));
                            }}
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
                );
              })}

              {paged.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                    No candidates match the current filters.
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
