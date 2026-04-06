"use client";

import { useState } from "react";

export default function GroundEmailTemplateEditor({
  label,
  description,
  settingsKey,
  initialTemplate,
}: {
  label: string;
  description: string;
  settingsKey: string;
  initialTemplate: string;
}) {
  const [template, setTemplate] = useState(initialTemplate);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch("/api/jobs/ground/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: settingsKey, value: template }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to save");
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900 mb-1">{label}</h3>
      <p className="text-xs text-gray-500 mb-3">{description}</p>
      <textarea
        value={template}
        onChange={(e) => { setTemplate(e.target.value); setSaved(false); }}
        rows={8}
        placeholder="Dear {{name}},&#10;&#10;..."
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400 resize-y font-mono"
      />
      <div className="flex items-center justify-between mt-2">
        <div>
          {saved && <span className="text-xs text-emerald-600">Saved successfully.</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-600 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving..." : "Save Template"}
        </button>
      </div>
    </div>
  );
}
