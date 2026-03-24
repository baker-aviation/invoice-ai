"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const PAGE_SIZE = 25;

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

function fmtDate(s: any): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s).slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

export default function RejectedTable({ initialJobs }: { initialJobs: any[] }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!q.trim()) return initialJobs;
    const query = q.toLowerCase().trim();
    return initialJobs.filter((j) => {
      const haystack = [j.candidate_name, j.email, j.location, j.category, j.rejection_reason]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [initialJobs, q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="p-4 sm:p-6 space-y-3 bg-gray-50 min-h-screen">
      <div className="rounded-xl border bg-white shadow-sm p-3">
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search rejected candidates..."
            className="flex-1 max-w-md rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none focus:border-gray-400 focus:bg-white transition-colors"
          />
          <span className="text-xs text-gray-400 tabular-nums">{filtered.length} rejected</span>
        </div>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50/80 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-2.5">Candidate</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5">Location</th>
                <th className="px-4 py-2.5">Rejection Reason</th>
                <th className="px-4 py-2.5 text-right">Applied</th>
                <th className="px-4 py-2.5 text-right">Rejected</th>
                <th className="px-4 py-2.5 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {paged.map((j) => (
                <tr key={j.id} className="hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-gray-900 truncate max-w-[200px]">{j.candidate_name ?? "—"}</div>
                    {j.email && <div className="text-xs text-gray-400 truncate max-w-[200px]">{j.email}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    {j.category ? (
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${CATEGORY_COLORS[j.category] ?? "bg-gray-100 text-gray-600 border-gray-200"}`}>
                        {CATEGORY_LABELS[j.category] ?? j.category}
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-gray-600 truncate max-w-[160px]">
                    {j.location ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-gray-600 max-w-[300px]">
                    <div className="flex items-center gap-1.5">
                      {j.rejection_type && (
                        <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold border ${
                          j.rejection_type === "hard" ? "bg-red-50 text-red-600 border-red-200"
                            : j.rejection_type === "soft" ? "bg-amber-50 text-amber-600 border-amber-200"
                            : "bg-gray-50 text-gray-500 border-gray-200"
                        }`}>
                          {j.rejection_type === "hard" ? "Hard" : j.rejection_type === "soft" ? "Soft" : "Left"}
                        </span>
                      )}
                      {j.rejection_reason ? (
                        <span className="truncate block" title={j.rejection_reason}>{j.rejection_reason}</span>
                      ) : (
                        <span className="text-gray-300 italic">No reason given</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-gray-400 whitespace-nowrap">
                    {fmtDate(j.created_at)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-red-400 whitespace-nowrap">
                    {fmtDate(j.rejected_at)}
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
              ))}
              {paged.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    No rejected candidates found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

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
