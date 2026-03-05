"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function BulletinDetail({
  bulletinId,
  showDelete,
}: {
  bulletinId: number;
  showDelete?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!showDelete) return null;

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
        setConfirming(false);
      }
    } catch {
      alert("Network error");
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (confirming) {
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
          onClick={() => setConfirming(false)}
          className="text-xs px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-50 font-medium text-gray-600"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="text-xs px-2.5 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 font-medium transition-colors"
    >
      Delete
    </button>
  );
}
