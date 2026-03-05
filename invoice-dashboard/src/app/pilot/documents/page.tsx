"use client";

import { useEffect, useState, useCallback } from "react";

type Document = {
  id: number;
  title: string;
  description: string | null;
  category: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPdf(ct: string): boolean {
  return ct.includes("pdf");
}

function isVideo(ct: string): boolean {
  return ct.includes("video") || ct.includes("mp4") || ct.includes("mov") || ct.includes("webm");
}

function fileIcon(ct: string): string {
  if (isPdf(ct)) return "\u{1F4C4}";
  if (isVideo(ct)) return "\u{1F3AC}";
  if (ct.includes("image")) return "\u{1F5BC}";
  if (ct.includes("word") || ct.includes("doc")) return "\u{1F4DD}";
  if (ct.includes("sheet") || ct.includes("xls") || ct.includes("csv")) return "\u{1F4CA}";
  return "\u{1F4CE}";
}

export default function PilotDocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/pilot/documents");
    if (res.ok) {
      const data = await res.json();
      setDocuments(data.documents ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const categories = ["All", ...Array.from(new Set(documents.map((d) => d.category)))];
  const filtered = activeCategory === "All" ? documents : documents.filter((d) => d.category === activeCategory);

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Documents</h1>
      <p className="text-gray-500 text-sm mb-6">
        Pilot bulletins, SOPs, and reference materials.
      </p>

      {/* Category tabs */}
      {categories.length > 1 && (
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                activeCategory === cat
                  ? "text-blue-900 border-b-2 border-blue-900"
                  : "text-gray-500 hover:text-gray-800"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading documents...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-400 text-sm">
            {activeCategory === "All"
              ? "No documents available yet."
              : `No documents in "${activeCategory}".`}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((doc) => (
            <div
              key={doc.id}
              className="bg-white border border-gray-200 rounded-lg p-4 hover:border-gray-300 transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl">{fileIcon(doc.content_type)}</span>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-slate-900 truncate">{doc.title}</h3>
                  {doc.description && (
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{doc.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-2 text-xs text-gray-400">
                    <span>{doc.category}</span>
                    <span>&middot;</span>
                    <span>{formatBytes(doc.size_bytes)}</span>
                    <span>&middot;</span>
                    <span>{new Date(doc.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                {(isPdf(doc.content_type) || isVideo(doc.content_type)) && (
                  <button
                    onClick={() => setPreviewDoc(doc)}
                    className="text-xs font-medium text-blue-700 hover:text-blue-900"
                  >
                    {isPdf(doc.content_type) ? "Preview" : "Play"}
                  </button>
                )}
                <a
                  href={`/api/pilot/documents/${doc.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-blue-700 hover:text-blue-900"
                >
                  Download
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview modal */}
      {previewDoc && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-slate-900 truncate">{previewDoc.title}</h3>
              <button
                onClick={() => setPreviewDoc(null)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                &times;
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {isPdf(previewDoc.content_type) ? (
                <iframe
                  src={`/api/pilot/documents/${previewDoc.id}`}
                  className="w-full h-[70vh] border-0 rounded"
                  title={previewDoc.title}
                />
              ) : isVideo(previewDoc.content_type) ? (
                <video
                  controls
                  className="w-full max-h-[70vh] rounded"
                  src={`/api/pilot/documents/${previewDoc.id}`}
                >
                  Your browser does not support video playback.
                </video>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
