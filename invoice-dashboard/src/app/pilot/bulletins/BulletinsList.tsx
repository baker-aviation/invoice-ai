"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useCallback } from "react";

type Bulletin = {
  id: number;
  title: string;
  summary: string | null;
  category: string;
  published_at: string;
  video_filename: string | null;
  created_at: string;
};

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "chief_pilot", label: "Chief Pilot" },
  { key: "operations", label: "Operations" },
  { key: "tims", label: "Tim's" },
  { key: "maintenance", label: "Maintenance" },
];

const CATEGORY_LABELS: Record<string, string> = {
  chief_pilot: "Chief Pilot",
  operations: "Operations",
  tims: "Tim's",
  maintenance: "Maintenance",
};

const CATEGORY_COLORS: Record<string, string> = {
  chief_pilot: "bg-blue-100 text-blue-800",
  operations: "bg-green-100 text-green-800",
  tims: "bg-purple-100 text-purple-800",
  maintenance: "bg-orange-100 text-orange-800",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Strip HTML tags for list preview */
function stripHtml(html: string) {
  const text = html.replace(/<[^>]*>/g, " ");
  const decoded = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#\d+;/g, "");
  return decoded.replace(/\s+/g, " ").trim();
}

export default function BulletinsList({
  bulletins,
  isAdmin,
}: {
  bulletins: Bulletin[];
  isAdmin: boolean;
}) {
  const [activeCategory, setActiveCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const filtered = bulletins.filter((b) => {
    if (activeCategory !== "all" && b.category !== activeCategory) return false;
    if (search) {
      const q = search.toLowerCase();
      const plainSummary = b.summary ? stripHtml(b.summary).toLowerCase() : "";
      return (
        b.title.toLowerCase().includes(q) || plainSummary.includes(q)
      );
    }
    return true;
  });

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <h1 className="text-xl font-bold text-gray-900">Bulletins</h1>
        {isAdmin && (
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 transition-colors"
          >
            + New Bulletin
          </button>
        )}
      </div>

      {/* Category tabs */}
      <div className="flex items-center gap-1 flex-wrap mb-4">
        {CATEGORIES.map((cat) => {
          const active = activeCategory === cat.key;
          const count =
            cat.key === "all"
              ? bulletins.length
              : bulletins.filter((b) => b.category === cat.key).length;
          return (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                active
                  ? "bg-slate-800 text-white border-slate-800"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
              }`}
            >
              {cat.label}
              {count > 0 && (
                <span
                  className={`text-[10px] font-bold ${active ? "text-white/70" : "text-gray-400"}`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search bulletins..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
        />
      </div>

      {/* Bulletin cards */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          {bulletins.length === 0
            ? "No bulletins published yet."
            : "No bulletins match your filters."}
        </div>
      ) : (
        <div className="grid gap-3">
          {filtered.map((b) => (
            <Link
              key={b.id}
              href={`/pilot/bulletins/${b.id}`}
              className="block bg-white border border-gray-200 rounded-lg px-5 py-4 hover:border-gray-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded-full ${
                        CATEGORY_COLORS[b.category] || "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {CATEGORY_LABELS[b.category] || b.category}
                    </span>
                    <span className="text-xs text-gray-400">
                      {formatDate(b.published_at)}
                    </span>
                  </div>
                  <h3 className="font-semibold text-gray-900 text-sm">{b.title}</h3>
                  {b.summary && (
                    <p className="text-sm text-gray-500 mt-1.5 line-clamp-4 leading-relaxed">
                      {stripHtml(b.summary)}
                    </p>
                  )}
                </div>
                {b.video_filename && (
                  <div className="shrink-0 mt-1">
                    <span className="text-[10px] text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
                      Video
                    </span>
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateBulletinModal onClose={() => setShowCreate(false)} />
      )}
    </div>
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
// Create Bulletin Modal
// ---------------------------------------------------------------------------

function CreateBulletinModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const editorRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

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
        category,
      };
      if (content) payload.summary = content;
      if (videoFile) payload.video_filename = videoFile.name;

      const res = await fetch("/api/pilot/bulletins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to create bulletin");
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
          setError("Bulletin created but video upload failed. Edit the bulletin to re-upload.");
          setSubmitting(false);
          router.refresh();
          return;
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
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={`bg-white rounded-xl shadow-xl p-5 flex flex-col overflow-auto resize max-w-[95vw] max-h-[95vh] ${
          expanded
            ? "w-[48rem] h-[90vh]"
            : "w-[32rem] h-auto"
        }`}
      >
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">
            New Bulletin
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
              Video (optional)
            </label>
            <input
              type="file"
              accept=".mov,.mp4,.m4v"
              onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:text-sm file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
            />
            <p className="text-[10px] text-gray-400 mt-1">.mov, .mp4, .m4v</p>
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
              {submitting ? "Publishing..." : "Publish Bulletin"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
