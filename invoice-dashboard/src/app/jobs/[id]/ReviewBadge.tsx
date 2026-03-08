"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/Badge";

export default function ReviewBadge({
  applicationId,
  initialNeedsReview,
}: {
  applicationId: number;
  initialNeedsReview: boolean;
}) {
  const [needsReview, setNeedsReview] = useState(initialNeedsReview);
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function toggle() {
    setSaving(true);
    try {
      const res = await fetch(`/api/jobs/${applicationId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ needs_review: !needsReview }),
      });
      if (res.ok) {
        setNeedsReview(!needsReview);
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
      title={needsReview ? "Click to mark as reviewed" : "Click to flag for review"}
      className="disabled:opacity-50"
    >
      {needsReview ? (
        <Badge variant="warning">needs review</Badge>
      ) : (
        <Badge>reviewed</Badge>
      )}
    </button>
  );
}
