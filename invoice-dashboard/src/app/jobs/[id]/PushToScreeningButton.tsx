"use client";

import { useState } from "react";

export default function PushToScreeningButton({
  applicationId,
  currentStage,
}: {
  applicationId: number;
  currentStage: string | null | undefined;
}) {
  const alreadyScreening =
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

  const [pushed, setPushed] = useState(alreadyScreening);
  const [loading, setLoading] = useState(false);

  if (pushed) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3.5 3.5L13 5" />
        </svg>
        In Screening
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        try {
          const res = await fetch(`/api/jobs/${applicationId}/stage`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage: "screening" }),
          });
          if (res.ok) setPushed(true);
        } catch {
          // ignore
        } finally {
          setLoading(false);
        }
      }}
      className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
    >
      {loading ? "Pushing..." : "Push to Screening"}
    </button>
  );
}
