"use client";

import { useState } from "react";

const TYPES = [
  { key: "ground_rejection_email_hard", label: "Hard Rejection", description: "Final rejection — no re-application encouraged." },
  { key: "ground_rejection_email_soft", label: "Soft Rejection", description: "Keep in pool — use {{notes}} for personalized feedback." },
  { key: "ground_rejection_email_left", label: "Left Process", description: '"Come back if still interested" message.' },
];

export default function GroundRejectionEmailEditor({
  initialTemplates,
}: {
  initialTemplates: Record<string, string>;
}) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function handleSave(key: string) {
    setSavingKey(key);
    setError("");
    try {
      const res = await fetch("/api/jobs/ground/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: templates[key] ?? "" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to save");
      } else {
        setSavedKeys((prev) => new Set(prev).add(key));
        setTimeout(() => setSavedKeys((prev) => { const n = new Set(prev); n.delete(key); return n; }), 3000);
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900 mb-1">Rejection Email Templates</h3>
      <p className="text-xs text-gray-500 mb-4">
        Templates for ground candidate rejection emails. Use {"{{name}}"} for the candidate&apos;s first name.
      </p>

      <div className="space-y-4">
        {TYPES.map(({ key, label, description }) => (
          <div key={key} className="space-y-1.5">
            <div>
              <span className="text-xs font-semibold text-gray-700">{label}</span>
              <span className="text-xs text-gray-400 ml-2">{description}</span>
            </div>
            <textarea
              value={templates[key] ?? ""}
              onChange={(e) => {
                setTemplates((prev) => ({ ...prev, [key]: e.target.value }));
                setSavedKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
              }}
              rows={5}
              placeholder={`Dear {{name}},\n\n...`}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400 resize-y font-mono"
            />
            <div className="flex items-center justify-between">
              <div>
                {savedKeys.has(key) && <span className="text-xs text-emerald-600">Saved.</span>}
              </div>
              <button
                onClick={() => handleSave(key)}
                disabled={savingKey === key}
                className="px-3 py-1 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-600 disabled:opacity-50 transition-colors"
              >
                {savingKey === key ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
