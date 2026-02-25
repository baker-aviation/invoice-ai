"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const PAGE_SIZE = 25;

function normalize(v: any) {
  return String(v ?? "").trim();
}

function fmtTime(s: any): string {
  const t = normalize(s);
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return t.replace("T", " ").slice(0, 16);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function hasSkillbridge(j: any): boolean {
  const haystack = [j.notes, j.category, ...(Array.isArray(j.type_ratings) ? j.type_ratings : [])]
    .join(" ")
    .toLowerCase();
  return haystack.includes("skillbridge") || haystack.includes("skill bridge");
}

export default function JobsTable({ initialJobs }: { initialJobs: any[] }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("ALL");
  const [softGate, setSoftGate] = useState("ALL");
  const [citation, setCitation] = useState("ALL");
  const [challenger, setChallenger] = useState("ALL");
  const [skillbridge, setSkillbridge] = useState("ALL");
  const [page, setPage] = useState(0);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const j of initialJobs) {
      const c = normalize(j.category);
      if (c) set.add(c);
    }
    return ["ALL", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [initialJobs]);

  const softGates = useMemo(() => {
    const set = new Set<string>();
    for (const j of initialJobs) {
      const s = normalize(j.soft_gate_pic_status);
      if (s) set.add(s);
    }
    return ["ALL", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [initialJobs]);

  const filtered = useMemo(() => {
    const query = q.toLowerCase().trim();

    return initialJobs.filter((j) => {
      const jCategory = normalize(j.category);
      const jSoft = normalize(j.soft_gate_pic_status);

      if (category !== "ALL" && jCategory !== category) return false;
      if (softGate !== "ALL" && jSoft !== softGate) return false;

      if (citation === "YES" && j.has_citation_x !== true) return false;
      if (citation === "NO" && j.has_citation_x === true) return false;

      if (challenger === "YES" && j.has_challenger_300_type_rating !== true) return false;
      if (challenger === "NO" && j.has_challenger_300_type_rating === true) return false;

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
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
          placeholder="Search name, email, location, type rating…"
          className="w-full max-w-xl rounded-xl border bg-white px-4 py-2 text-sm shadow-sm outline-none"
        />

        <select
          value={category}
          onChange={(e) => { setCategory(e.target.value); setPage(0); }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c === "ALL" ? "All categories" : c}
            </option>
          ))}
        </select>

        <select
          value={softGate}
          onChange={(e) => { setSoftGate(e.target.value); setPage(0); }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm max-w-[240px]"
        >
          {softGates.map((s) => (
            <option key={s} value={s}>
              {s === "ALL" ? "All PIC gates" : s}
            </option>
          ))}
        </select>

        <select
          value={citation}
          onChange={(e) => { setCitation(e.target.value); setPage(0); }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm"
        >
          <option value="ALL">Citation X: all</option>
          <option value="YES">Citation X: yes</option>
          <option value="NO">Citation X: no</option>
        </select>

        <select
          value={challenger}
          onChange={(e) => { setChallenger(e.target.value); setPage(0); }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm"
        >
          <option value="ALL">CL-300: all</option>
          <option value="YES">CL-300: yes</option>
          <option value="NO">CL-300: no</option>
        </select>

        <select
          value={skillbridge}
          onChange={(e) => { setSkillbridge(e.target.value); setPage(0); }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm"
        >
          <option value="ALL">SkillBridge: all</option>
          <option value="YES">SkillBridge: yes</option>
          <option value="NO">SkillBridge: no</option>
        </select>

        <button
          onClick={clear}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
        >
          Clear
        </button>

        <div className="text-xs text-gray-500">{filtered.length} shown</div>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100 text-left text-gray-700">
              <tr>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Candidate</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">TT</th>
                <th className="px-4 py-3 font-medium">PIC</th>
                <th className="px-4 py-3 font-medium">PIC Gate</th>
                <th className="px-4 py-3 font-medium">Ratings</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>

            <tbody>
              {paged.map((j) => (
                <tr key={j.id ?? j.application_id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-3 whitespace-nowrap">{fmtTime(j.created_at)}</td>

                  <td className="px-4 py-3">
                    <div className="font-medium">{j.candidate_name ?? "—"}</div>
                    <div className="text-xs text-gray-500">{j.email ?? "—"}</div>
                  </td>

                  <td className="px-4 py-3">{j.category ?? "—"}</td>
                  <td className="px-4 py-3">{j.location ?? "—"}</td>
                  <td className="px-4 py-3">{j.total_time_hours ?? "—"}</td>
                  <td className="px-4 py-3">{j.pic_time_hours ?? "—"}</td>
                  <td className="px-4 py-3">{j.soft_gate_pic_status ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {j.has_citation_x ? <span className="mr-1">CE-750</span> : null}
                    {j.has_challenger_300_type_rating ? <span className="mr-1">CL-300</span> : null}
                    {hasSkillbridge(j) ? <span className="mr-1 text-blue-600">SB</span> : null}
                  </td>

                  <td className="px-4 py-3 text-right">
                    {j.application_id ? (
                      <Link href={`/jobs/${j.application_id}`} className="text-blue-600 hover:underline">
                        View →
                      </Link>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}

              {paged.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-gray-500">
                    No jobs found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="h-9 rounded-lg border px-4 text-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ← Previous
          </button>
          <span className="text-xs text-gray-500">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="h-9 rounded-lg border px-4 text-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next →
          </button>
        </div>
      )}

      <div className="text-xs text-gray-500">
        Showing {filtered.length} job{filtered.length === 1 ? "" : "s"} across {totalPages} page{totalPages === 1 ? "" : "s"}.
      </div>
    </div>
  );
}
