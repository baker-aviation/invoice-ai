"use client";

import { useState, useEffect, useCallback } from "react";

type Question = {
  id: string;
  label: string;
  type: "text" | "textarea" | "date" | "number" | "select" | "checkbox";
  required: boolean;
  options?: string[];
};

type FormConfig = {
  id: number;
  title: string;
  description: string | null;
  questions: Question[];
};

const FIELD_TYPES = ["text", "textarea", "date", "number", "select", "checkbox"] as const;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 50);
}

export default function AdminFormsPage() {
  const [form, setForm] = useState<FormConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchForm = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/forms");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setForm(data.form);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchForm();
  }, [fetchForm]);

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    setSuccess(null);
    try {
      const res = await fetch("/api/admin/forms", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: form.id,
          title: form.title,
          description: form.description,
          questions: form.questions,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setSuccess("Saved!");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function updateQuestion(index: number, updates: Partial<Question>) {
    if (!form) return;
    const questions = [...form.questions];
    questions[index] = { ...questions[index], ...updates };
    setForm({ ...form, questions });
  }

  function addQuestion() {
    if (!form) return;
    const newQ: Question = {
      id: `question_${form.questions.length + 1}`,
      label: "",
      type: "text",
      required: false,
    };
    setForm({ ...form, questions: [...form.questions, newQ] });
  }

  function removeQuestion(index: number) {
    if (!form) return;
    const questions = form.questions.filter((_, i) => i !== index);
    setForm({ ...form, questions });
  }

  function moveQuestion(index: number, direction: -1 | 1) {
    if (!form) return;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= form.questions.length) return;
    const questions = [...form.questions];
    [questions[index], questions[newIndex]] = [questions[newIndex], questions[index]];
    setForm({ ...form, questions });
  }

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">Loading...</div>;
  }

  if (!form) {
    return (
      <div className="text-sm text-gray-400 py-8 text-center border border-dashed border-gray-300 rounded-lg">
        No form configured. Run the database migration to create the default form.
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-6">
        Edit the info session form that candidates fill out after their info session.
        Changes take effect immediately for new form links.
      </p>

      {error && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      {success && (
        <div className="mb-4 px-4 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {success}
        </div>
      )}

      {/* Form title & description */}
      <div className="mb-6 space-y-3">
        <div>
          <label className="text-sm font-medium text-gray-700">Form Title</label>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-gray-700">Description</label>
          <textarea
            value={form.description ?? ""}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={2}
            className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
          />
        </div>
      </div>

      {/* Questions */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Questions ({form.questions.length})</h2>
        <button
          type="button"
          onClick={addQuestion}
          className="text-sm bg-slate-900 text-white rounded-md px-4 py-1.5 font-medium hover:bg-slate-700"
        >
          Add Question
        </button>
      </div>

      {form.questions.length === 0 ? (
        <div className="text-sm text-gray-400 py-8 text-center border border-dashed border-gray-300 rounded-lg">
          No questions yet. Click &quot;Add Question&quot; to get started.
        </div>
      ) : (
        <div className="space-y-3 mb-6">
          {form.questions.map((q, i) => (
            <div key={i} className="border border-gray-200 rounded-lg p-4 bg-white">
              <div className="flex items-start gap-3">
                {/* Reorder buttons */}
                <div className="flex flex-col gap-0.5 pt-1">
                  <button
                    type="button"
                    onClick={() => moveQuestion(i, -1)}
                    disabled={i === 0}
                    className="text-gray-400 hover:text-gray-700 disabled:opacity-30 text-xs"
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => moveQuestion(i, 1)}
                    disabled={i === form.questions.length - 1}
                    className="text-gray-400 hover:text-gray-700 disabled:opacity-30 text-xs"
                    title="Move down"
                  >
                    ▼
                  </button>
                </div>

                <div className="flex-1 grid gap-2 sm:grid-cols-2">
                  {/* Label */}
                  <div className="sm:col-span-2">
                    <input
                      type="text"
                      value={q.label}
                      onChange={(e) => {
                        const label = e.target.value;
                        const updates: Partial<Question> = { label };
                        if (q.id.startsWith("question_")) {
                          updates.id = slugify(label) || q.id;
                        }
                        updateQuestion(i, updates);
                      }}
                      placeholder="Question label"
                      className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                    />
                  </div>

                  {/* ID */}
                  <div>
                    <label className="text-xs text-gray-400">ID</label>
                    <input
                      type="text"
                      value={q.id}
                      onChange={(e) => updateQuestion(i, { id: e.target.value.replace(/[^a-z0-9_]/g, "") })}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-slate-500"
                    />
                  </div>

                  {/* Type */}
                  <div>
                    <label className="text-xs text-gray-400">Type</label>
                    <select
                      value={q.type}
                      onChange={(e) => updateQuestion(i, { type: e.target.value as Question["type"] })}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-slate-500"
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>

                  {/* Options (for select type) */}
                  {q.type === "select" && (
                    <div className="sm:col-span-2">
                      <label className="text-xs text-gray-400">Options (comma-separated)</label>
                      <input
                        type="text"
                        value={(q.options ?? []).join(", ")}
                        onChange={(e) =>
                          updateQuestion(i, {
                            options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                          })
                        }
                        placeholder="Option 1, Option 2, Option 3"
                        className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-slate-500"
                      />
                    </div>
                  )}
                </div>

                {/* Required toggle + delete */}
                <div className="flex flex-col items-center gap-2 pt-1">
                  <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={q.required}
                      onChange={(e) => updateQuestion(i, { required: e.target.checked })}
                      className="rounded"
                    />
                    Req
                  </label>
                  <button
                    type="button"
                    onClick={() => removeQuestion(i)}
                    className="text-xs text-gray-400 hover:text-red-600"
                    title="Remove question"
                  >
                    &times;
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="bg-slate-900 text-white rounded-md px-6 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
}
