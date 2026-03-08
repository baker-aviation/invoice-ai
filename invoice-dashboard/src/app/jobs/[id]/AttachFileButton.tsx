"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

const CATEGORY_OPTIONS = [
  { value: "resume", label: "Resume" },
  { value: "lor", label: "Letter of Recommendation" },
  { value: "cover_letter", label: "Cover Letter" },
  { value: "other", label: "Other" },
];

export default function AttachFileButton({
  applicationId,
  parseId,
}: {
  applicationId: number;
  parseId: number;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileCategory, setFileCategory] = useState("resume");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("file_category", fileCategory);
      formData.append("parse_id", String(parseId));

      const res = await fetch(`/api/jobs/${applicationId}/attach`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        setResult({ ok: true, message: "File attached successfully!" });
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
        // Refresh the page to show the new file
        router.refresh();
      } else {
        setResult({ ok: false, message: data.error || "Upload failed" });
      }
    } catch {
      setResult({ ok: false, message: "Network error" });
    } finally {
      setUploading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-sm text-blue-600 hover:text-blue-800 font-medium"
      >
        + Attach File
      </button>
    );
  }

  return (
    <div className="mt-3 border border-gray-200 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Attach File</span>
        <button
          onClick={() => {
            setOpen(false);
            setResult(null);
            setFile(null);
          }}
          className="text-gray-400 hover:text-gray-600 text-lg leading-none"
        >
          &times;
        </button>
      </div>

      <div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,.doc,.txt"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:text-sm file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
        />
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Document Type</label>
        <select
          value={fileCategory}
          onChange={(e) => setFileCategory(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-blue-400"
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {result && (
        <div className={`rounded-lg p-2 text-sm ${result.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
          {result.message}
        </div>
      )}

      <button
        onClick={handleUpload}
        disabled={!file || uploading}
        className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {uploading ? "Uploading..." : "Upload"}
      </button>
    </div>
  );
}
