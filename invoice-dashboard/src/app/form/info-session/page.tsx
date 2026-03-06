"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

type Question = {
  id: string;
  label: string;
  type: "text" | "textarea" | "date" | "number" | "select" | "checkbox";
  required: boolean;
  options?: string[];
};

type FormConfig = {
  title: string;
  description: string | null;
  questions: Question[];
};

export default function InfoSessionFormPage() {
  return (
    <Suspense fallback={<div className="text-center py-16 text-gray-400 text-sm">Loading form...</div>}>
      <InfoSessionFormInner />
    </Suspense>
  );
}

function InfoSessionFormInner() {
  const searchParams = useSearchParams();
  const formType = searchParams.get("type") ?? "regular";

  const [form, setForm] = useState<FormConfig | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadForm() {
      try {
        const res = await fetch(`/api/public/info-session?type=${encodeURIComponent(formType)}`);
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Failed to load form");
          return;
        }
        setForm(data.form);
        const initial: Record<string, string | boolean> = {};
        for (const q of data.form.questions) {
          initial[q.id] = q.type === "checkbox" ? false : "";
        }
        setAnswers(initial);
      } catch {
        setError("Failed to load form.");
      } finally {
        setLoading(false);
      }
    }
    loadForm();
  }, [formType]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form || submitting) return;

    if (!name.trim()) { setError("Please enter your name"); return; }
    if (!email.trim()) { setError("Please enter your email"); return; }

    for (const q of form.questions) {
      if (q.required) {
        const val = answers[q.id];
        if (val === undefined || val === "" || val === false) {
          setError(`Please fill in "${q.label}"`);
          return;
        }
      }
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/public/info-session?type=${encodeURIComponent(formType)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), answers }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Submission failed");
      }

      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  function updateAnswer(id: string, value: string | boolean) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  if (loading) {
    return <div className="text-center py-16 text-gray-400 text-sm">Loading form...</div>;
  }

  if (submitted) {
    return (
      <div className="rounded-xl border bg-white p-8 shadow-sm text-center">
        <div className="text-3xl mb-3">&#10003;</div>
        <h2 className="text-xl font-semibold text-slate-900 mb-2">Thank You!</h2>
        <p className="text-gray-500 text-sm">
          Your responses have been recorded. We&apos;ll be in touch soon.
        </p>
      </div>
    );
  }

  if (error && !form) {
    return (
      <div className="rounded-xl border bg-white p-8 shadow-sm text-center">
        <h2 className="text-lg font-semibold text-red-600 mb-2">Unable to Load Form</h2>
        <p className="text-gray-500 text-sm">{error}</p>
      </div>
    );
  }

  if (!form) return null;

  return (
    <div>
      <div className="rounded-xl border bg-white p-6 shadow-sm mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mb-1">{form.title}</h1>
        {form.description && (
          <p className="text-gray-500 text-sm">{form.description}</p>
        )}
      </div>

      {error && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* Name and email for matching */}
        <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Full Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
          />
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Email <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Dynamic questions */}
        <div className="space-y-4">
          {form.questions.map((q) => (
            <div key={q.id} className="rounded-xl border bg-white p-4 shadow-sm">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {q.label}
                {q.required && <span className="text-red-500 ml-0.5">*</span>}
              </label>

              {q.type === "text" && (
                <input
                  type="text"
                  value={answers[q.id] as string}
                  onChange={(e) => updateAnswer(q.id, e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}

              {q.type === "textarea" && (
                <textarea
                  value={answers[q.id] as string}
                  onChange={(e) => updateAnswer(q.id, e.target.value)}
                  rows={3}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}

              {q.type === "date" && (
                <input
                  type="date"
                  value={answers[q.id] as string}
                  onChange={(e) => updateAnswer(q.id, e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}

              {q.type === "number" && (
                <input
                  type="number"
                  value={answers[q.id] as string}
                  onChange={(e) => updateAnswer(q.id, e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}

              {q.type === "select" && (
                <select
                  value={answers[q.id] as string}
                  onChange={(e) => updateAnswer(q.id, e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select...</option>
                  {(q.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              )}

              {q.type === "checkbox" && (
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={answers[q.id] as boolean}
                    onChange={(e) => updateAnswer(q.id, e.target.checked)}
                    className="rounded"
                  />
                  Yes
                </label>
              )}
            </div>
          ))}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="mt-6 w-full bg-slate-900 text-white rounded-md px-6 py-3 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
        >
          {submitting ? "Submitting..." : "Submit"}
        </button>
      </form>
    </div>
  );
}
