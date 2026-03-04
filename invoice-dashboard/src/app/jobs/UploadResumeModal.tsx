"use client";

import { useState, useRef } from "react";

const ROLE_OPTIONS = [
  { value: "other", label: "Auto-detect" },
  { value: "First Officer", label: "First Officer" },
  { value: "Captain", label: "Captain" },
  { value: "Maintenance", label: "Maintenance" },
  { value: "Dispatcher", label: "Dispatcher" },
  { value: "Sales", label: "Sales" },
  { value: "Line Service", label: "Line Service" },
];

const CATEGORY_OPTIONS = [
  { value: "resume", label: "Resume" },
  { value: "lor", label: "Letter of Recommendation" },
  { value: "cover_letter", label: "Cover Letter" },
  { value: "other", label: "Other" },
];

export default function UploadResumeModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [candidateName, setCandidateName] = useState("");
  const [roleBucket, setRoleBucket] = useState("other");
  const [fileCategory, setFileCategory] = useState("resume");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (candidateName) formData.append("candidate_name", candidateName);
      formData.append("role_bucket", roleBucket);
      formData.append("file_category", fileCategory);

      const res = await fetch("/api/jobs/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        setResult({
          ok: true,
          message: data.parsed
            ? `Uploaded and parsed! Application #${data.application_id}`
            : `Uploaded successfully! Application #${data.application_id}. Parsing will happen on next scheduled run.`,
        });
        // Reset form
        setFile(null);
        setCandidateName("");
        if (inputRef.current) inputRef.current.value = "";
      } else {
        setResult({ ok: false, message: data.error || "Upload failed" });
      }
    } catch (e) {
      setResult({ ok: false, message: "Network error" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Upload Resume</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* File input */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">File (PDF, DOCX, TXT)</label>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.doc,.txt"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:text-sm file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
          />
        </div>

        {/* File category */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Document Type</label>
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

        {/* Candidate name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Candidate Name (optional)</label>
          <input
            value={candidateName}
            onChange={(e) => setCandidateName(e.target.value)}
            placeholder="e.g. John Smith"
            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-blue-400"
          />
        </div>

        {/* Role bucket */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
          <select
            value={roleBucket}
            onChange={(e) => setRoleBucket(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-blue-400"
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Result message */}
        {result && (
          <div className={`rounded-lg p-3 text-sm ${result.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
            {result.message}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
          >
            {result?.ok ? "Done" : "Cancel"}
          </button>
          <button
            onClick={handleUpload}
            disabled={!file || uploading}
            className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {uploading ? "Uploading..." : "Upload & Parse"}
          </button>
        </div>
      </div>
    </div>
  );
}
