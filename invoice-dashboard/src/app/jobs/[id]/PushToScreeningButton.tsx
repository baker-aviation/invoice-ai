"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const STAGE_LABELS: Record<string, string> = {
  prd_faa_review: "Pending PRD Upload",
  chief_pilot_review: "Chief Pilot Review",
  screening: "Screening",
  info_session: "Info Session",
  tims_review: "Tim's Review",
  interview_pre: "Need to Schedule",
  interview_scheduled: "Interview Scheduled",
  interview_post: "Interview Complete",
  pending_offer: "Pending Offer",
  offer: "Offer",
  hired: "Hired",
};

export default function PushToScreeningButton({
  applicationId,
  currentStage,
}: {
  applicationId: number;
  currentStage: string | null | undefined;
}) {
  const router = useRouter();
  const inPipeline = !!(currentStage && currentStage !== "");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function callStageApi(stage: string | null) {
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/jobs/${applicationId}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: stage ?? "remove" }),
      });
      const text = await res.text();
      if (res.ok) {
        router.refresh();
      } else {
        setStatus("error");
        setMessage(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      setStatus("error");
      setMessage(String(err));
    }
  }

  if (inPipeline) {
    return (
      <div className="inline-flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8.5l3.5 3.5L13 5" />
          </svg>
          {STAGE_LABELS[currentStage!] ?? currentStage!.replace(/_/g, " ")}
        </span>
        <button
          type="button"
          disabled={status === "loading"}
          onClick={() => callStageApi(null)}
          className="text-xs text-gray-400 hover:text-red-500 transition-colors"
          title="Remove from pipeline (back to table)"
        >
          {status === "loading" ? "..." : "x"}
        </button>
        {status === "error" && message && (
          <span className="text-xs text-red-600">{message}</span>
        )}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={status === "loading"}
        onClick={() => callStageApi("prd_faa_review")}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {status === "loading" ? "Sending..." : "Send to Pipeline"}
      </button>
      {status === "error" && message && (
        <span className="text-xs text-red-600 max-w-xs break-all">{message}</span>
      )}
    </div>
  );
}
