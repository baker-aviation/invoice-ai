"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

function normalize(v: any) {
  return String(v ?? "").trim();
}

function triLabel(v: string) {
  if (v === "true") return "Yes";
  if (v === "false") return "No";
  return "All";
}

function asBool(v: any): boolean | null {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}

export default function JobsTable({ initialJobs }: { initialJobs: any[] }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("ALL");
  const [softGate, setSoftGate] = useState("ALL");

  // ✅ NEW filters
  const [citation, setCitation] = useState<"all" | "true" | "false">("all");
  const [challenger, setChallenger] = useState<"all" | "true" | "false">("all");

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

      // ✅ NEW: Citation filter
      if (citation !== "all") {
        const has = asBool(j.has_citation_x);
        if (citation === "true" && has !== true) return false;
        if (citation === "false" && has !== false) return false;
      }

      // ✅ NEW: Challenger filter
      if (challenger !== "all") {
        const has = asBool(j.has_challenger_300_type_rating);
        if (challenger === "true" && has !== true) return false;
        if (challenger === "false" && has !== false) return false;
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
  }, [initialJobs, q, category, softGate, citation, challenger]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, email, location, type rating…"
          className="w-full max-w-xl rounded-xl border bg-white px-4 py-2 text-sm shadow-sm outline-none"
        />

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
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
          onChange={(e) => setSoftGate(e.target.value)}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm max-w-[320px]"
        >
          {softGates.map((s) => (
            <option key={s} value={s}>
              {s === "ALL" ? "All soft-gate" : s}
            </option>
          ))}
        </select>

        {/* ✅ NEW */}
        <select
          value={citation}
          onChange={(e) => setCitation(e.target.value as any)}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm"
        >
          <option value="all">Citation: {triLabel("all")}</option>
          <option value="true">Citation: Yes</option>
          <option value="false">Citation: No</option>
        </select>

        {/* ✅ NEW */}
        <select
          value={challenger}
          onChange={(e) => setChallenger(e.target.value as any)}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm"
        >
          <option value="all">Challenger: {triLabel("all")}</option>
          <option value="true">Challenger: Yes</option>
          <option value="false">Challenger: No</option>
        </select>

        <button
          onClick={() => {
            setQ("");
            setCategory("ALL");
            setSoftGate("ALL");
            setCitation("all");
            setChallenger("all");
          }}
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
                <th className="px-4 py-3 font-medium">Soft Gate</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>

            <tbody>
              {filtered.map((j) => (
                <tr key={j.id ?? j.application_id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-3">
                    {String(j.created_at ?? "").replace("T", " ").replace("+00:00", "Z")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{j.candidate_name ?? "—"}</div>
                    <div className="text-xs text-gray-500">{j.email ?? "—"}</div>
                  </td>
                  <td className="px-4 py-3">{j.category ?? "—"}</td>
                  <td className="px-4 py-3">{j.location ?? "—"}</td>
                  <td className="px-4 py-3">{j.total_time_hours ?? "—"}</td>
                  <td className="px-4 py-3">{j.pic_time_hours ?? "—"}</td>
                  <td className="px-4 py-3">{j.soft_gate_pic_status ?? "—"}</td>

                  <td className="px-4 py-3 text-right">
                    {j.application_id ? (
                      <Link href={`/jobs/${j.application_id}`} className="text-blue-600 hover:underline">
                        View →
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                    No jobs found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}