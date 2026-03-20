"use client";

import { useState } from "react";

const DEFAULT_TEMPLATE = `Dear {{name}},

Thank you for your interest in Baker Aviation. We'd like to invite you to schedule an interview with our team.

Please use the link below to select a time that works best for you:

{{calendly_url}}

If you have any questions or need to reschedule, please reply to this email.

We look forward to speaking with you!

Sincerely,
Baker Aviation Hiring Team`;

export default function InterviewEmailEditor({
  initialTemplate,
}: {
  initialTemplate: string;
}) {
  const [template, setTemplate] = useState(initialTemplate || DEFAULT_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch("/api/jobs/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "interview_email_template", value: template }),
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
    <div className="rounded-xl border bg-white p-4 shadow-sm space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Interview Scheduling Email</h3>
        <p className="text-xs text-gray-500 mt-1">
          Use <code className="bg-gray-100 px-1 rounded">{"{{name}}"}</code> for the candidate&apos;s first name
          and <code className="bg-gray-100 px-1 rounded">{"{{calendly_url}}"}</code> for the Calendly link.
          Sent from HR@baker-aviation.com with the Baker logo.
        </p>
      </div>
      <textarea
        value={template}
        onChange={(e) => { setTemplate(e.target.value); setSaved(false); }}
        rows={10}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400 resize-y font-mono"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !template.trim()}
          className="px-4 py-1.5 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {saved && <span className="text-xs text-emerald-600">Saved successfully.</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
