"use client";

import { useState, useRef } from "react";

const NOTE_FIELDS = [
  { key: "hr_notes", label: "HR Notes", color: "border-l-blue-300" },
  { key: "prd_review_notes", label: "PRD Review Notes", color: "border-l-orange-300" },
  { key: "tims_notes", label: "Tim's Notes", color: "border-l-teal-300" },
  { key: "chief_pilot_notes", label: "Chief Pilot Notes", color: "border-l-red-300" },
] as const;

type NoteKey = (typeof NOTE_FIELDS)[number]["key"];

export default function InlineNotes({
  applicationId,
  initialNotes,
}: {
  applicationId: number;
  initialNotes: Record<string, string | undefined> | null;
}) {
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    const n: Record<string, string> = {};
    for (const f of NOTE_FIELDS) {
      n[f.key] = initialNotes?.[f.key] ?? "";
    }
    return n;
  });
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const timeoutRef = useRef<Record<string, NodeJS.Timeout>>({});

  async function saveNote(key: NoteKey) {
    setSaving(key);
    setSaved(null);
    try {
      const structured_notes: Record<string, string | null> = {};
      for (const f of NOTE_FIELDS) {
        structured_notes[f.key] = notes[f.key] || null;
      }
      await fetch(`/api/jobs/${applicationId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ structured_notes }),
      });
      setSaved(key);
      if (timeoutRef.current[key]) clearTimeout(timeoutRef.current[key]);
      timeoutRef.current[key] = setTimeout(() => setSaved((prev) => prev === key ? null : prev), 2000);
    } catch {} finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-gray-700">Review Notes</div>
      <div className="grid gap-2 md:grid-cols-2">
        {NOTE_FIELDS.map((field) => (
          <div
            key={field.key}
            className={`rounded border border-gray-200 bg-white border-l-4 ${field.color} p-2`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-gray-500">{field.label}</span>
              <div className="flex items-center gap-1">
                {saving === field.key && (
                  <span className="text-[9px] text-gray-400">saving...</span>
                )}
                {saved === field.key && (
                  <span className="text-[9px] text-emerald-500">saved</span>
                )}
                <button
                  onClick={() => saveNote(field.key)}
                  disabled={saving === field.key}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-40 transition-colors"
                  title="Save"
                >
                  ✓
                </button>
              </div>
            </div>
            <textarea
              value={notes[field.key]}
              onChange={(e) => setNotes((prev) => ({ ...prev, [field.key]: e.target.value }))}
              onBlur={() => saveNote(field.key)}
              placeholder={`${field.label}...`}
              rows={3}
              className="w-full text-sm border-0 bg-transparent resize-y focus:ring-0 p-0 placeholder-gray-300"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
