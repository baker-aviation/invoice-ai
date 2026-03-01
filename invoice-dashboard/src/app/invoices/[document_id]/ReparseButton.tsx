"use client";

import { useState } from "react";

export default function ReparseButton({ documentId }: { documentId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function handleReparse() {
    if (!confirm("Re-parse this invoice? This will re-extract all fields from the PDF.")) {
      return;
    }

    setState("loading");
    setMsg("");

    try {
      const res = await fetch(`/api/invoices/${documentId}/reparse`, {
        method: "POST",
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMsg(body.error || `Failed (${res.status})`);
        setState("error");
        return;
      }

      setState("done");
      setMsg("Re-parsed successfully. Refreshing...");
      setTimeout(() => window.location.reload(), 1500);
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Network error");
      setState("error");
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleReparse}
        disabled={state === "loading"}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {state === "loading" ? "Re-parsing..." : "Re-parse"}
      </button>
      {msg && (
        <span className={`text-xs ${state === "error" ? "text-red-600" : "text-green-600"}`}>
          {msg}
        </span>
      )}
    </div>
  );
}
