"use client";

import { useState } from "react";

export default function PushToScreeningButton({
  applicationId,
  currentStage,
}: {
  applicationId: number;
  currentStage: string | null | undefined;
}) {
  const alreadyInPipeline = !!(currentStage && currentStage !== "");

  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    alreadyInPipeline ? "success" : "idle",
  );
  const [message, setMessage] = useState<string | null>(
    alreadyInPipeline ? currentStage!.replace(/_/g, " ") : null,
  );

  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3.5 3.5L13 5" />
        </svg>
        In Pipeline
      </span>
    );
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={status === "loading"}
        onClick={async () => {
          setStatus("loading");
          setMessage(null);
          try {
            const res = await fetch(`/api/jobs/${applicationId}/stage`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ stage: "prd_faa_review" }),
            });
            const text = await res.text();
            if (res.ok) {
              setStatus("success");
              setMessage("Sent to pipeline");
            } else {
              setStatus("error");
              setMessage(`HTTP ${res.status}: ${text.slice(0, 300)}`);
            }
          } catch (err) {
            setStatus("error");
            setMessage(`Network error: ${String(err)}`);
          }
        }}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {status === "loading" ? "Sending..." : "Send to Pipeline"}
      </button>
      {status === "error" && message && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1 max-w-md break-all">
          {message}
        </div>
      )}
    </div>
  );
}
