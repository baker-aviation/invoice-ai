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
  slug: string;
  title: string;
  description: string | null;
  questions: Question[];
};

const FIELD_TYPES = ["text", "textarea", "date", "number", "select", "checkbox"] as const;

const TAB_LABELS: Record<string, string> = {
  regular: "Regular Hire",
  skillbridge: "SkillBridge",
};

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 50);
}

export default function AdminFormsPage() {
  const [forms, setForms] = useState<FormConfig[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchForms = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/forms");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Support both old (single form) and new (multiple forms) response
      if (data.forms) {
        setForms(data.forms);
        if (!activeSlug && data.forms.length > 0) {
          setActiveSlug(data.forms[0].slug);
        }
      } else if (data.form) {
        setForms([data.form]);
        if (!activeSlug) setActiveSlug(data.form.slug ?? "regular");
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [activeSlug]);

  useEffect(() => {
    fetchForms();
  }, [fetchForms]);

  const activeForm = forms.find((f) => f.slug === activeSlug) ?? null;

  function updateForm(updates: Partial<FormConfig>) {
    setForms((prev) =>
      prev.map((f) => (f.slug === activeSlug ? { ...f, ...updates } : f))
    );
  }

  function updateQuestion(index: number, updates: Partial<Question>) {
    if (!activeForm) return;
    const questions = [...activeForm.questions];
    questions[index] = { ...questions[index], ...updates };
    updateForm({ questions });
  }

  function addQuestion() {
    if (!activeForm) return;
    const newQ: Question = {
      id: `question_${activeForm.questions.length + 1}`,
      label: "",
      type: "text",
      required: false,
    };
    updateForm({ questions: [...activeForm.questions, newQ] });
  }

  function removeQuestion(index: number) {
    if (!activeForm) return;
    updateForm({ questions: activeForm.questions.filter((_, i) => i !== index) });
  }

  function moveQuestion(index: number, direction: -1 | 1) {
    if (!activeForm) return;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= activeForm.questions.length) return;
    const questions = [...activeForm.questions];
    [questions[index], questions[newIndex]] = [questions[newIndex], questions[index]];
    updateForm({ questions });
  }

  async function handleSave() {
    if (!activeForm) return;
    setSaving(true);
    setSuccess(null);
    try {
      const res = await fetch("/api/admin/forms", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: activeForm.id,
          title: activeForm.title,
          description: activeForm.description,
          questions: activeForm.questions,
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

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">Loading...</div>;
  }

  if (forms.length === 0) {
    return (
      <div className="text-sm text-gray-400 py-8 text-center border border-dashed border-gray-300 rounded-lg">
        No forms configured. Run the database migration to create forms.
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Edit info session forms. Changes take effect immediately for new form links.
      </p>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {forms.map((f) => (
          <button
            key={f.slug}
            type="button"
            onClick={() => { setActiveSlug(f.slug); setError(null); setSuccess(null); }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              f.slug === activeSlug
                ? "border-slate-800 text-slate-900"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {TAB_LABELS[f.slug] ?? f.slug}
          </button>
        ))}
      </div>

      {/* Public URL hint */}
      {activeForm && (
        <div className="mb-4 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-500">
          Public URL: <code className="bg-white px-1.5 py-0.5 rounded border text-gray-700">/form/info-session?type={activeForm.slug}</code>
        </div>
      )}

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

      {activeForm && (
        <>
          {/* Form title & description */}
          <div className="mb-6 space-y-3">
            <div>
              <label className="text-sm font-medium text-gray-700">Form Title</label>
              <input
                type="text"
                value={activeForm.title}
                onChange={(e) => updateForm({ title: e.target.value })}
                className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700">Description</label>
              <textarea
                value={activeForm.description ?? ""}
                onChange={(e) => updateForm({ description: e.target.value })}
                rows={2}
                className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
            </div>
          </div>

          {/* Questions */}
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">Questions ({activeForm.questions.length})</h2>
            <button
              type="button"
              onClick={addQuestion}
              className="text-sm bg-slate-900 text-white rounded-md px-4 py-1.5 font-medium hover:bg-slate-700"
            >
              Add Question
            </button>
          </div>

          {activeForm.questions.length === 0 ? (
            <div className="text-sm text-gray-400 py-8 text-center border border-dashed border-gray-300 rounded-lg">
              No questions yet. Click &quot;Add Question&quot; to get started.
            </div>
          ) : (
            <div className="space-y-3 mb-6">
              {activeForm.questions.map((q, i) => (
                <div key={i} className="border border-gray-200 rounded-lg p-4 bg-white">
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col gap-0.5 pt-1">
                      <button
                        type="button"
                        onClick={() => moveQuestion(i, -1)}
                        disabled={i === 0}
                        className="text-gray-400 hover:text-gray-700 disabled:opacity-30 text-xs"
                      >
                        &#9650;
                      </button>
                      <button
                        type="button"
                        onClick={() => moveQuestion(i, 1)}
                        disabled={i === activeForm.questions.length - 1}
                        className="text-gray-400 hover:text-gray-700 disabled:opacity-30 text-xs"
                      >
                        &#9660;
                      </button>
                    </div>

                    <div className="flex-1 grid gap-2 sm:grid-cols-2">
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
                      <div>
                        <label className="text-xs text-gray-400">ID</label>
                        <input
                          type="text"
                          value={q.id}
                          onChange={(e) => updateQuestion(i, { id: e.target.value.replace(/[^a-z0-9_]/g, "") })}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-slate-500"
                        />
                      </div>
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
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

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
        </>
      )}
    </div>
  );
}
