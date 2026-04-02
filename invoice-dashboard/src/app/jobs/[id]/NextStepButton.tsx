"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PIPELINE_STAGES, type PipelineStage } from "@/lib/types";

const STAGE_LABELS: Record<string, string> = {
  chief_pilot_review: "Chief Pilot Review",
  screening: "Screening",
  info_session: "Info Session",
  tims_review: "Tim's Review",
  prd_faa_review: "PRD / FAA Review",
  interview_scheduled: "Scheduled for Interview",
  interview_post: "Interview Completed",
  pending_offer: "Pending Offer",
  offer: "Offer",
  hired: "Hired",
};

async function fetchNextInStage(stage: string, exclude: number): Promise<number | null> {
  try {
    const res = await fetch(`/api/jobs/next-in-stage?stage=${stage}&exclude=${exclude}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.application_id ?? null;
  } catch {
    return null;
  }
}

export default function NextStepButton({
  applicationId,
  currentStage,
}: {
  applicationId: number;
  currentStage: string | null;
}) {
  const router = useRouter();
  const [moving, setMoving] = useState(false);

  if (!currentStage) return null;

  const idx = PIPELINE_STAGES.indexOf(currentStage as PipelineStage);
  if (idx < 0 || idx >= PIPELINE_STAGES.length - 1) return null;

  const nextStage = PIPELINE_STAGES[idx + 1];
  const nextLabel = STAGE_LABELS[nextStage] ?? nextStage.replace(/_/g, " ");

  async function handleMove() {
    setMoving(true);
    try {
      await fetch(`/api/jobs/${applicationId}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: nextStage }),
      });

      // Auto-advance to the next candidate in the same stage
      const nextAppId = await fetchNextInStage(currentStage!, applicationId);
      if (nextAppId) {
        router.push(`/jobs/${nextAppId}`);
      } else {
        router.push("/jobs/pipeline");
      }
    } catch {
      router.refresh();
    } finally {
      setMoving(false);
    }
  }

  return (
    <button
      onClick={handleMove}
      disabled={moving}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-300 bg-blue-50 text-blue-700 text-xs font-medium hover:bg-blue-100 disabled:opacity-50 transition-colors"
    >
      {moving ? "Moving..." : `Move to ${nextLabel}`}
      {!moving && <span>→</span>}
    </button>
  );
}
