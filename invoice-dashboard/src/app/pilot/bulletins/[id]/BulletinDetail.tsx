"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type SlackChannel = { id: string; name: string; is_private: boolean };

export default function BulletinDetail({
  bulletinId,
  slackTs,
  title: initialTitle,
  summary: initialSummary,
  category: initialCategory,
  videoFilename: initialVideoFilename,
}: {
  bulletinId: number;
  slackTs: string | null;
  title: string;
  summary: string;
  category: string;
  videoFilename: string | null;
}) {
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

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
    <>
      <div className="flex items-center gap-2 relative">
        {shared && (
          <span className="text-xs px-2 py-0.5 rounded-full border border-green-200 bg-green-50 text-green-700 font-medium inline-flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            Shared
          </span>
        )}
        <button
          onClick={() => setShowEdit(true)}
          className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium transition-colors"
        >
          Edit
        </button>
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
        <button
          onClick={() => setConfirmingDelete(true)}
          className="text-xs px-2.5 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 font-medium transition-colors"
        >
          Delete
        </button>
      </div>

      {showEdit && (
        <EditBulletinModal
          bulletinId={bulletinId}
          initialTitle={initialTitle}
          initialSummary={initialSummary}
          initialCategory={initialCategory}
          initialVideoFilename={initialVideoFilename}
          onClose={() => setShowEdit(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Rich Text Toolbar Button
// ---------------------------------------------------------------------------

function ToolbarBtn({
  label,
  command,
  value,
}: {
  label: string;
  command: string;
  value?: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        document.execCommand(command, false, value);
      }}
      className="px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200 rounded transition-colors"
      title={label}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Edit Bulletin Modal
// ---------------------------------------------------------------------------

function EditBulletinModal({
  bulletinId,
  initialTitle,
  initialSummary,
  initialCategory,
  initialVideoFilename,
  onClose,
}: {
  bulletinId: number;
  initialTitle: string;
  initialSummary: string;
  initialCategory: string;
  initialVideoFilename: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const editorRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(initialTitle);
  const [category, setCategory] = useState(initialCategory);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  // Pre-populate the rich text editor with existing content
  useEffect(() => {
    if (editorRef.current && initialSummary) {
      editorRef.current.innerHTML = initialSummary;
    }
  }, [initialSummary]);

  const getContent = useCallback(() => {
    return editorRef.current?.innerHTML?.trim() || "";
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    if (!category) {
      setError("Category is required");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const content = getContent();
      const payload: Record<string, string> = {
        title: title.trim(),
        summary: content,
        category,
      };
      if (videoFile) payload.video_filename = videoFile.name;

      const res = await fetch(`/api/pilot/bulletins/${bulletinId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to update bulletin");
        setSubmitting(false);
        return;
      }

      const { upload_url } = await res.json();

      // Upload video directly to GCS via presigned URL
      if (videoFile && upload_url) {
        const ext = videoFile.name.split(".").pop()?.toLowerCase();
        const contentType =
          ext === "mp4" ? "video/mp4"
          : ext === "m4v" ? "video/x-m4v"
          : "video/quicktime";

        const uploadRes = await fetch(upload_url, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: videoFile,
        });

        if (!uploadRes.ok) {
          console.error("Video upload failed:", uploadRes.status);
        }
      }

      onClose();
      router.refresh();
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className={`bg-white rounded-xl shadow-xl p-5 flex flex-col overflow-auto resize max-w-[95vw] max-h-[95vh] ${
          expanded
            ? "w-[48rem] h-[90vh]"
            : "w-[32rem] h-auto"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">
            Edit Bulletin
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-gray-400 hover:text-gray-600 text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50"
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 gap-3">
          <div className="shrink-0">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Title *
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
              autoFocus
            />
          </div>

          <div className="shrink-0">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Category *
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400 bg-white"
            >
              <option value="">Select...</option>
              <option value="chief_pilot">Chief Pilot</option>
              <option value="operations">Operations</option>
              <option value="tims">Tim&apos;s</option>
              <option value="maintenance">Maintenance</option>
            </select>
          </div>

          {/* Rich text editor */}
          <div className="flex flex-col flex-1 min-h-0">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Content
            </label>
            <div className="border border-gray-200 rounded-lg flex flex-col flex-1 min-h-0 overflow-hidden focus-within:border-gray-400">
              {/* Toolbar */}
              <div className="flex items-center gap-0.5 px-2 py-1 border-b border-gray-100 bg-gray-50 shrink-0 flex-wrap">
                <ToolbarBtn label="B" command="bold" />
                <ToolbarBtn label="I" command="italic" />
                <ToolbarBtn label="U" command="underline" />
                <span className="w-px h-4 bg-gray-200 mx-1" />
                <ToolbarBtn label="H1" command="formatBlock" value="h1" />
                <ToolbarBtn label="H2" command="formatBlock" value="h2" />
                <ToolbarBtn label="H3" command="formatBlock" value="h3" />
                <span className="w-px h-4 bg-gray-200 mx-1" />
                <ToolbarBtn label="List" command="insertUnorderedList" />
                <ToolbarBtn label="1." command="insertOrderedList" />
              </div>
              {/* Editable area */}
              <div
                ref={editorRef}
                contentEditable
                className={`px-3 py-2 text-sm outline-none overflow-y-auto prose prose-sm max-w-none ${
                  expanded ? "flex-1" : "min-h-[200px] max-h-[400px]"
                }`}
                data-placeholder="Bulletin content..."
                suppressContentEditableWarning
              />
            </div>
          </div>

          <div className="shrink-0">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Video {initialVideoFilename ? `(current: ${initialVideoFilename})` : "(optional)"}
            </label>
            <input
              type="file"
              accept=".mov,.mp4,.m4v"
              onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:text-sm file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
            />
            <p className="text-[10px] text-gray-400 mt-1">.mov, .mp4, .m4v — leave empty to keep current video</p>
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 shrink-0">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
