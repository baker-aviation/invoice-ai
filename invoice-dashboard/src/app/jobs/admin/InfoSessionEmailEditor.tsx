"use client";

import { useState } from "react";

const DEFAULT_TEMPLATE = `Dear {{name}},

Thank you for your interest in Baker Aviation! We'd like to invite you to attend an upcoming information session where you'll learn more about the company, the role, and have the opportunity to ask questions.

Please join using the link below:

{{meet_link}}

If you have any questions beforehand, feel free to reply to this email.

We look forward to seeing you there!

Sincerely,
Baker Aviation Hiring Team`;

export default function InfoSessionEmailEditor({
  initialTemplate,
  initialMeetLink,
}: {
  initialTemplate: string;
  initialMeetLink: string;
}) {
  const [template, setTemplate] = useState(initialTemplate || DEFAULT_TEMPLATE);
  const [meetLink, setMeetLink] = useState(initialMeetLink);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function saveSetting(key: string, value: string) {
    const res = await fetch("/api/jobs/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? "Failed to save");
    }
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await Promise.all([
        saveSetting("info_session_email_template", template),
        ...(meetLink.trim() ? [saveSetting("info_session_meet_link", meetLink.trim())] : []),
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err.message ?? "Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Info Session Email</h3>
        <p className="text-xs text-gray-500 mt-1">
          Use <code className="bg-gray-100 px-1 rounded">{"{{name}}"}</code> for the candidate&apos;s first name
          and <code className="bg-gray-100 px-1 rounded">{"{{meet_link}}"}</code> for the Google Meet link.
          Sent from HR@baker-aviation.com with the Baker logo.
        </p>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Google Meet Link</label>
        <input
          type="url"
          value={meetLink}
          onChange={(e) => { setMeetLink(e.target.value); setSaved(false); }}
          placeholder="https://meet.google.com/..."
          className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Email Template</label>
        <textarea
          value={template}
          onChange={(e) => { setTemplate(e.target.value); setSaved(false); }}
          rows={10}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400 resize-y font-mono"
        />
      </div>
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
