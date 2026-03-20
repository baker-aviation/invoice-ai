"use client";

import { useState } from "react";

const TEMPLATES = [
  { key: "rejection_email_soft", label: "Soft Rejection", description: "Encouraged to reapply later" },
  { key: "rejection_email_hard", label: "Hard Rejection", description: "Final rejection" },
  { key: "rejection_email_left", label: "Left Process", description: "Candidate stopped responding" },
] as const;

export default function RejectionEmailEditor({
  initialTemplates,
}: {
  initialTemplates: Record<string, string>;
}) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (key: string) => {
    setSaving(key);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/jobs/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: templates[key] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to save");
      } else {
        setSaved(key);
        setTimeout(() => setSaved(null), 3000);
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Rejection Email Templates</h3>
        <p className="text-xs text-gray-500 mt-1">
          Use <code className="bg-gray-100 px-1 rounded">{"{{name}}"}</code> for the candidate&apos;s first name.
          Sent from HR@baker-aviation.com with the Baker logo.
        </p>
      </div>

      {TEMPLATES.map(({ key, label, description }) => (
        <div key={key} className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-gray-700">{label}</span>
              <span className="text-xs text-gray-400 ml-2">{description}</span>
            </div>
            <button
              onClick={() => handleSave(key)}
              disabled={saving === key}
              className="px-3 py-1 text-xs font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-700 disabled:opacity-50"
            >
              {saving === key ? "Saving..." : saved === key ? "Saved!" : "Save"}
            </button>
          </div>
          <textarea
            value={templates[key] ?? ""}
            onChange={(e) => setTemplates({ ...templates, [key]: e.target.value })}
            rows={6}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400 resize-y font-mono"
          />
        </div>
      ))}

      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}
