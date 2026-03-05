"use client";

import { useState } from "react";

export default function FormLinkButton({ parseId }: { parseId: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generateLink() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${parseId}/form-link`, { method: "POST" });
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
      <div className="flex items-center gap-2 mt-2">
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
    );
  }

  return (
    <div>
      <button
        onClick={generateLink}
        disabled={loading}
        className="text-xs border border-blue-300 text-blue-700 rounded-md px-3 py-1.5 font-medium hover:bg-blue-50 disabled:opacity-50"
      >
        {loading ? "Generating..." : "Generate Info Session Form Link"}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
