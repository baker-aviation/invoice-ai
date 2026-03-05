"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type SlackChannel = { id: string; name: string; is_private: boolean };

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

  // Slack share state
  const [showSharePicker, setShowSharePicker] = useState(false);
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState("");
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(!!slackTs);

  useEffect(() => {
    if (!showSharePicker || channels.length > 0) return;
    setLoadingChannels(true);
    fetch(`/api/pilot/bulletins/${bulletinId}/share`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setChannels(data.channels);
      })
      .catch(() => {})
      .finally(() => setLoadingChannels(false));
  }, [showSharePicker, bulletinId, channels.length]);

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
    if (!selectedChannel) return;
    setSharing(true);
    try {
      const res = await fetch(`/api/pilot/bulletins/${bulletinId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: selectedChannel }),
      });
      if (res.ok) {
        setShared(true);
        setShowSharePicker(false);
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
    <div className="flex items-center gap-2 relative">
      {shared ? (
        <span className="text-xs px-2.5 py-1 rounded border border-green-200 bg-green-50 text-green-700 font-medium">
          Shared to Slack
        </span>
      ) : (
        <div className="relative">
          <button
            onClick={() => setShowSharePicker((v) => !v)}
            className="text-xs px-2.5 py-1 rounded border border-blue-200 text-blue-600 hover:bg-blue-50 font-medium transition-colors"
          >
            Share to Slack
          </button>

          {showSharePicker && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 z-10 w-64">
              <div className="text-xs font-medium text-gray-700 mb-2">
                Select channel
              </div>
              {loadingChannels ? (
                <div className="text-xs text-gray-400 py-2">Loading channels...</div>
              ) : channels.length === 0 ? (
                <div className="text-xs text-gray-400 py-2">No channels available</div>
              ) : (
                <>
                  <select
                    value={selectedChannel}
                    onChange={(e) => setSelectedChannel(e.target.value)}
                    className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-gray-400 bg-white mb-2"
                  >
                    <option value="">Select...</option>
                    {channels.map((ch) => (
                      <option key={ch.id} value={ch.id}>
                        {ch.is_private ? "🔒 " : "#"} {ch.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleShare}
                    disabled={!selectedChannel || sharing}
                    className="w-full text-xs px-2.5 py-1.5 rounded bg-blue-900 text-white font-medium hover:bg-blue-800 disabled:opacity-50 transition-colors"
                  >
                    {sharing ? "Sharing..." : "Share"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
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
