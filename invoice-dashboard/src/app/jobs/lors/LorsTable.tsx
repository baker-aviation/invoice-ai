"use client";

import Link from "next/link";
import { useState } from "react";

type LorFile = {
  id: number;
  application_id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  signed_url: string | null;
  file_category: string;
  linked_parse_id: number | null;
  linked_candidate_name: string | null;
  linked_application_id: number | null;
};

type Candidate = {
  id: number;
  name: string;
  applicationId: number;
};

function fmtDate(s: any): string {
  const t = String(s ?? "").trim();
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return t.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function fmtSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export default function LorsTable({
  initialFiles,
  candidates,
}: {
  initialFiles: LorFile[];
  candidates: Candidate[];
}) {
  const [files, setFiles] = useState(initialFiles);
  const [linking, setLinking] = useState<number | null>(null); // file id being linked
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleLink(fileId: number, parseId: number | null) {
    setSaving(true);
    try {
      const res = await fetch("/api/jobs/lors", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId, linked_parse_id: parseId }),
      });
      if (res.ok) {
        const candidate = parseId ? candidates.find((c) => c.id === parseId) : null;
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId
              ? {
                  ...f,
                  linked_parse_id: parseId,
                  linked_candidate_name: candidate?.name ?? null,
                  linked_application_id: candidate?.applicationId ?? null,
                }
              : f,
          ),
        );
      }
    } catch (e) {
      console.error("Link failed:", e);
    } finally {
      setSaving(false);
      setLinking(null);
      setSearch("");
    }
  }

  async function handleReclassify(fileId: number) {
    if (!confirm("Reclassify this file as a resume? It will be removed from the LOR list.")) return;
    setSaving(true);
    try {
      const res = await fetch("/api/jobs/lors", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId, linked_parse_id: null, file_category: "resume" }),
      });
      if (res.ok) {
        setFiles((prev) => prev.filter((f) => f.id !== fileId));
      }
    } catch (e) {
      console.error("Reclassify failed:", e);
    } finally {
      setSaving(false);
    }
  }

  const filteredCandidates = search
    ? candidates.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : candidates.slice(0, 20);

  return (
    <div className="p-4 sm:p-6 space-y-3 bg-gray-50 min-h-screen">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{files.length} letter{files.length !== 1 ? "s" : ""} of recommendation</p>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50/80 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-2.5">Filename</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Size</th>
                <th className="px-4 py-2.5">Uploaded</th>
                <th className="px-4 py-2.5">Linked Candidate</th>
                <th className="px-4 py-2.5 w-40">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {files.map((f) => (
                <tr key={f.id} className="hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-gray-900 truncate max-w-[250px]">{f.filename}</div>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{f.content_type}</td>
                  <td className="px-4 py-2.5 text-gray-500">{fmtSize(f.size_bytes)}</td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs">{fmtDate(f.created_at)}</td>
                  <td className="px-4 py-2.5">
                    {linking === f.id ? (
                      <div className="relative">
                        <input
                          autoFocus
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Search candidates..."
                          className="w-full rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-400"
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              setLinking(null);
                              setSearch("");
                            }
                          }}
                        />
                        <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded border bg-white shadow-lg">
                          {f.linked_parse_id && (
                            <button
                              onClick={() => handleLink(f.id, null)}
                              disabled={saving}
                              className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 border-b"
                            >
                              Unlink
                            </button>
                          )}
                          {filteredCandidates.map((c) => (
                            <button
                              key={c.id}
                              onClick={() => handleLink(f.id, c.id)}
                              disabled={saving}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 truncate"
                            >
                              {c.name}
                            </button>
                          ))}
                          {filteredCandidates.length === 0 && (
                            <div className="px-3 py-2 text-sm text-gray-400">No candidates found</div>
                          )}
                        </div>
                      </div>
                    ) : f.linked_candidate_name ? (
                      <Link
                        href={`/jobs/${f.linked_application_id}`}
                        className="text-blue-600 hover:underline text-sm"
                      >
                        {f.linked_candidate_name}
                      </Link>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setLinking(linking === f.id ? null : f.id);
                          setSearch("");
                        }}
                        className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 font-medium"
                      >
                        {f.linked_parse_id ? "Change" : "Attach"}
                      </button>
                      {f.signed_url && (
                        <a
                          href={f.signed_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline text-xs"
                        >
                          View
                        </a>
                      )}
                      <button
                        onClick={() => handleReclassify(f.id)}
                        disabled={saving}
                        className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 font-medium"
                        title="Reclassify as resume (remove from LOR list)"
                      >
                        Not a LOR
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {files.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    No letters of recommendation found.
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
