"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function PushToScreeningButton({
  applicationId,
  currentStage,
}: {
  applicationId: number;
  currentStage: string | null | undefined;
}) {
  const router = useRouter();
  const alreadyInPipeline =
    currentStage === "screening" ||
    currentStage === "info_session" ||
    currentStage === "prd_faa_review" ||
    currentStage === "chief_pilot_review" ||
    currentStage === "tims_review" ||
    currentStage === "interview_pre" ||
    currentStage === "interview_post" ||
    currentStage === "pending_offer" ||
    currentStage === "offer" ||
    currentStage === "hired";

  const [pushed, setPushed] = useState(alreadyInPipeline);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugMsg, setDebugMsg] = useState<string | null>(null);

  if (pushed) {
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
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={loading}
        onClick={async () => {
          setLoading(true);
          setError(null);
          setDebugMsg(`Calling PATCH /api/jobs/${applicationId}/stage ...`);
          try {
            const res = await fetch(`/api/jobs/${applicationId}/stage`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ stage: "prd_faa_review" }),
            });
            const text = await res.text();
            setDebugMsg(`Response: HTTP ${res.status} — ${text.slice(0, 300)}`);
            let data: Record<string, unknown> = {};
            try { data = JSON.parse(text); } catch {}
            if (res.ok) {
              setPushed(true);
              router.refresh();
            } else {
              const msg = (data.error as string) ?? `Failed (HTTP ${res.status}): ${text.slice(0, 200)}`;
              setError(msg);
            }
          } catch (err) {
            setError(String(err));
            setDebugMsg(`Exception: ${String(err)}`);
          } finally {
            setLoading(false);
          }
        }}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {loading ? "Sending..." : "Send to Pipeline"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
      {debugMsg && <span className="text-xs text-gray-400">{debugMsg}</span>}
    </div>
  );
}
