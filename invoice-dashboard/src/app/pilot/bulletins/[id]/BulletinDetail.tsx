"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function BulletinDetail({
  bulletinId,
  slackTs,
}: {
  bulletinId: number;
  slackTs: string | null;
}) {
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(!!slackTs);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/pilot/bulletins/${bulletinId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        router.push("/pilot/bulletins");
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to delete bulletin");
        setDeleting(false);
        setConfirmingDelete(false);
      }
    } catch {
      alert("Network error");
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  async function handleShare() {
    setSharing(true);
    try {
      const res = await fetch(`/api/pilot/bulletins/${bulletinId}/share`, {
        method: "POST",
      });
      if (res.ok) {
        setShared(true);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to share to Slack");
      }
    } catch {
      alert("Network error");
    }
    setSharing(false);
  }

  if (confirmingDelete) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-red-600">Delete this bulletin?</span>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-xs px-2.5 py-1 rounded border border-red-300 bg-red-50 text-red-700 hover:bg-red-100 font-medium disabled:opacity-50"
        >
          {deleting ? "Deleting..." : "Confirm"}
        </button>
        <button
          onClick={() => setConfirmingDelete(false)}
          className="text-xs px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-50 font-medium text-gray-600"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {shared ? (
        <span className="text-xs px-2.5 py-1 rounded border border-green-200 bg-green-50 text-green-700 font-medium">
          Shared to Slack
        </span>
      ) : (
        <button
          onClick={handleShare}
          disabled={sharing}
          className="text-xs px-2.5 py-1 rounded border border-blue-200 text-blue-600 hover:bg-blue-50 font-medium transition-colors disabled:opacity-50"
        >
          {sharing ? "Sharing..." : "Share to #pilots"}
        </button>
      )}
      <button
        onClick={() => setConfirmingDelete(true)}
        className="text-xs px-2.5 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 font-medium transition-colors"
      >
        Delete
      </button>
    </div>
  );
}
