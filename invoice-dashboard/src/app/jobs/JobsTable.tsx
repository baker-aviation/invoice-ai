"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Display labels & colors
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
    return u.includes("cl-300") || u.includes("cl300") || u.includes("challenger 300") || u.includes("challenger-300");
  });
}

function picGateShort(status: string | null, met: boolean | null | undefined): { label: string; cls: string } | null {
  if (status) {
    const s = status.toLowerCase();
    if (s.startsWith("meets")) return { label: "Met", cls: "text-emerald-700 bg-emerald-50 border-emerald-200" };
    if (s.startsWith("close") || s.includes("near")) return { label: "Close", cls: "text-amber-700 bg-amber-50 border-amber-200" };
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
// Toggle pill (Yes/No filter)
// ---------------------------------------------------------------------------

function TogglePill({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(value === "ALL" ? "YES" : value === "YES" ? "NO" : "ALL")}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
        value === "YES"
          ? "bg-emerald-50 text-emerald-700 border-emerald-300"
          : value === "NO"
            ? "bg-red-50 text-red-600 border-red-200"
            : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
      }`}
    >
      {label}
      {value !== "ALL" && (
        <span className="font-bold">{value === "YES" ? "Y" : "N"}</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main table
// ---------------------------------------------------------------------------

export default function JobsTable({ initialJobs }: { initialJobs: any[] }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("ALL");
  const [softGate, setSoftGate] = useState("ALL");
  const [citation, setCitation] = useState("ALL");
  const [challenger, setChallenger] = useState("ALL");
  const [skillbridge, setSkillbridge] = useState("ALL");
  const [page, setPage] = useState(0);

  const categoryOptions: FilterOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const j of initialJobs) {
      const c = normalize(j.category);
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [
      { key: "ALL", label: "All", count: initialJobs.length },
      ...Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ key: k, label: categoryLabel(k), count: v })),
    ];
  }, [initialJobs]);

  const filtered = useMemo(() => {
    const query = q.toLowerCase().trim();

    return initialJobs.filter((j) => {
      const jCategory = normalize(j.category);
      const jSoft = normalize(j.soft_gate_pic_status);

      if (category !== "ALL" && jCategory !== category) return false;
      if (softGate === "MET" && !jSoft.toLowerCase().startsWith("meets")) return false;
      if (softGate === "NOT_MET" && jSoft.toLowerCase().startsWith("meets")) return false;

      if (citation === "YES" && !hasCitationX(j)) return false;
      if (citation === "NO" && hasCitationX(j)) return false;

      if (challenger === "YES" && !hasChallenger(j)) return false;
      if (challenger === "NO" && hasChallenger(j)) return false;

      if (skillbridge === "YES" && !hasSkillbridge(j)) return false;
      if (skillbridge === "NO" && hasSkillbridge(j)) return false;

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
  }, [initialJobs, q, category, softGate, citation, challenger, skillbridge]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const hasActiveFilters = category !== "ALL" || softGate !== "ALL" || citation !== "ALL" || challenger !== "ALL" || skillbridge !== "ALL" || q !== "";

  const clear = () => {
    setQ("");
    setCategory("ALL");
    setSoftGate("ALL");
    setCitation("ALL");
    setChallenger("ALL");
    setSkillbridge("ALL");
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
          <FilterPills
            options={categoryOptions}
            value={category}
            onChange={(v) => { setCategory(v); setPage(0); }}
          />
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
          <TogglePill label="CE-750" value={citation} onChange={(v) => { setCitation(v); setPage(0); }} />
          <TogglePill label="CL-300" value={challenger} onChange={(v) => { setChallenger(v); setPage(0); }} />
          <TogglePill label="SkillBridge" value={skillbridge} onChange={(v) => { setSkillbridge(v); setPage(0); }} />
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
                <th className="px-4 py-2.5 text-right">Date</th>
                <th className="px-4 py-2.5 w-10"></th>
              </tr>
            </thead>

            <tbody className="divide-y divide-gray-100">
              {paged.map((j) => {
                const isPilot = j.category === "pilot_pic" || j.category === "pilot_sic";
                const gate = isPilot ? picGateShort(j.soft_gate_pic_status, j.soft_gate_pic_met) : null;
                return (
                  <tr key={j.id ?? j.application_id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-900 truncate max-w-[200px]">{j.candidate_name ?? "—"}</div>
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
                      </div>
                    </td>

                    <td className="px-4 py-2.5 text-right text-xs text-gray-400 whitespace-nowrap">
                      {fmtDate(j.created_at)}
                    </td>

                    <td className="px-2 py-2.5 text-right">
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
                    </td>
                  </tr>
                );
              })}

              {paged.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
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
