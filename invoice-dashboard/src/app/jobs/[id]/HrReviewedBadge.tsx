"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function HrReviewedBadge({
  applicationId,
  initialHrReviewed,
}: {
  applicationId: number;
  initialHrReviewed: boolean;
}) {
  const [hrReviewed, setHrReviewed] = useState(initialHrReviewed);
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function toggle() {
    setSaving(true);
    try {
      const res = await fetch(`/api/jobs/${applicationId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hr_reviewed: !hrReviewed }),
      });
      if (res.ok) {
        setHrReviewed(!hrReviewed);
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={saving}
      title={hrReviewed ? "HR has reviewed — click to unmark" : "Click to mark as HR reviewed"}
      className="disabled:opacity-50"
    >
      {hrReviewed ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
          HR Reviewed
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-semibold text-gray-500">
          HR Not Reviewed
        </span>
      )}
    </button>
  );
}
