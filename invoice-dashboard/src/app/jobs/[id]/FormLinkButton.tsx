"use client";

import { useState } from "react";

const FORM_TYPES = [
  { slug: "regular", label: "Regular Hire" },
  { slug: "skillbridge", label: "SkillBridge" },
];

export default function FormLinkButton({ parseId }: { parseId: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState("regular");

  async function generateLink() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${parseId}/form-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form_type: selectedType }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setUrl(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate link");
    } finally {
      setLoading(false);
    }
  }

  async function copyToClipboard() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (url) {
    return (
      <div className="space-y-2 mt-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={url}
            className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs font-mono bg-gray-50 focus:outline-none"
          />
          <button
            onClick={copyToClipboard}
            className="text-xs bg-slate-900 text-white rounded px-3 py-1 font-medium hover:bg-slate-700"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <button
          onClick={() => setUrl(null)}
          className="text-xs text-gray-500 hover:text-gray-700 underline"
        >
          Generate another link
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={selectedType}
        onChange={(e) => setSelectedType(e.target.value)}
        className="text-xs border border-gray-200 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:border-blue-400"
      >
        {FORM_TYPES.map((t) => (
          <option key={t.slug} value={t.slug}>{t.label}</option>
        ))}
      </select>
      <button
        onClick={generateLink}
        disabled={loading}
        className="text-xs border border-blue-300 text-blue-700 rounded-md px-3 py-1.5 font-medium hover:bg-blue-50 disabled:opacity-50"
      >
        {loading ? "Generating..." : "Generate Form Link"}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
