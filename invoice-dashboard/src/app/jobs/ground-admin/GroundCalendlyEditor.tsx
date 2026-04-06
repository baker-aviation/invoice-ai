"use client";

import { useState } from "react";

export default function GroundCalendlyEditor({
  label,
  description,
  settingsKey,
  initialUrl,
}: {
  label: string;
  description: string;
  settingsKey: string;
  initialUrl: string;
}) {
  const [url, setUrl] = useState(initialUrl);
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
        body: JSON.stringify({ key: settingsKey, value: url }),
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
      <div className="flex items-center gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setSaved(false); }}
          placeholder="https://calendly.com/..."
          className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-600 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      {saved && <div className="mt-2 text-xs text-emerald-600">Saved successfully.</div>}
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
