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
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  embedding_status: string | null;
  chunk_count: number;
};

type Category = {
  id: number;
  name: string;
  sort_order: number;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeLabel(ct: string): string {
  if (ct.includes("pdf")) return "PDF";
  if (ct.includes("mp4") || ct.includes("video")) return "Video";
  if (ct.includes("mov")) return "Video";
  if (ct.includes("image")) return "Image";
  if (ct.includes("word") || ct.includes("doc")) return "Word";
  if (ct.includes("sheet") || ct.includes("xls") || ct.includes("csv")) return "Spreadsheet";
  if (ct.includes("presentation") || ct.includes("ppt")) return "Slides";
  return "File";
}

function embeddingBadge(status: string | null, chunkCount: number, contentType: string): React.ReactNode {
  const isPdf = contentType.includes("pdf");
  if (!isPdf) return <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500">N/A</span>;
  if (!status) return <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500">Not indexed</span>;
  switch (status) {
    case "ready":
      return <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700">{chunkCount} chunks</span>;
    case "processing":
      return <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-yellow-100 text-yellow-700">Processing...</span>;
    case "error":
      return <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700">Error</span>;
    case "no_text":
      return <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500">No text</span>;
    default:
      return <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500">{status}</span>;
  }
}

export default function AdminDocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Upload modal state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadDesc, setUploadDesc] = useState("");
  const [uploadCategory, setUploadCategory] = useState("");
  const [uploading, setUploading] = useState(false);

  // Edit modal state
  const [editDoc, setEditDoc] = useState<Document | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editCategory, setEditCategory] = useState("");

  // Category management
  const [newCatName, setNewCatName] = useState("");
  const [showCategories, setShowCategories] = useState(false);

  // GCS import
  const [importing, setImporting] = useState(false);

  const fetchDocuments = useCallback(async () => {
    const res = await fetch("/api/admin/pilot-documents");
    if (!res.ok) {
      setError("Failed to load documents");
      return;
    }
    const data = await res.json();
    setDocuments(data.documents ?? []);
  }, []);

  const fetchCategories = useCallback(async () => {
    const res = await fetch("/api/admin/pilot-documents/categories");
    if (!res.ok) return;
    const data = await res.json();
    setCategories(data.categories ?? []);
  }, []);

  useEffect(() => {
    Promise.all([fetchDocuments(), fetchCategories()]).finally(() => setLoading(false));
  }, [fetchDocuments, fetchCategories]);

  function clearMessages() {
    setError("");
    setSuccess("");
  }

  async function handleUpload() {
    if (!uploadFile || !uploadTitle || !uploadCategory) return;
    clearMessages();
    setUploading(true);

    try {
      // Step 1: Get signed upload URL + create DB record
      const metaRes = await fetch("/api/admin/pilot-documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: uploadTitle,
          description: uploadDesc,
          category: uploadCategory,
          filename: uploadFile.name,
          contentType: uploadFile.type || "application/octet-stream",
          size: uploadFile.size,
        }),
      });

      if (!metaRes.ok) {
        const data = await metaRes.json().catch(() => ({}));
        setError(data.error || "Upload failed");
        return;
      }

      const { document: doc, uploadUrl } = await metaRes.json();

      // Step 2: Upload file directly to GCS via signed URL
      const gcsRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": uploadFile.type || "application/octet-stream" },
        body: uploadFile,
      });

      if (!gcsRes.ok) {
        setError("Failed to upload file to storage");
        return;
      }

      // Step 3: Trigger RAG processing for PDFs
      const isPdf = uploadFile.type === "application/pdf" || uploadFile.name.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        fetch(`/api/admin/pilot-documents/${doc.id}/process`, { method: "POST" }).catch(() => {});
      }

      setSuccess("Document uploaded successfully");
      setShowUpload(false);
      setUploadFile(null);
      setUploadTitle("");
      setUploadDesc("");
      setUploadCategory("");
      fetchDocuments();
    } catch {
      setError("Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleEdit() {
    if (!editDoc) return;
    clearMessages();

    const res = await fetch(`/api/admin/pilot-documents/${editDoc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: editTitle, description: editDesc, category: editCategory }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Update failed");
      return;
    }

    setSuccess("Document updated");
    setEditDoc(null);
    fetchDocuments();
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this document? This will also remove the file from storage.")) return;
    clearMessages();

    const res = await fetch(`/api/admin/pilot-documents/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Delete failed");
      return;
    }

    setSuccess("Document deleted");
    fetchDocuments();
  }

  async function handleAddCategory() {
    if (!newCatName.trim()) return;
    clearMessages();

    const res = await fetch("/api/admin/pilot-documents/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newCatName.trim() }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed to create category");
      return;
    }

    setNewCatName("");
    fetchCategories();
  }

  async function handleDeleteCategory(cat: Category) {
    if (!confirm(`Delete category "${cat.name}"? Only works if no documents are assigned.`)) return;
    clearMessages();

    const res = await fetch(`/api/admin/pilot-documents/categories?id=${cat.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed to delete category");
      return;
    }

    setSuccess("Category deleted");
    fetchCategories();
  }

  async function handleImportGCS() {
    clearMessages();
    setImporting(true);

    try {
      // Scan GCS bucket for files not in DB
      const res = await fetch("/api/admin/pilot-documents/import", { method: "POST" });
      if (!res.ok) {
        // Import endpoint not yet built — show guidance
        setError("Import from GCS: scan the bucket prefix pilot-documents/ and add untracked files. (Endpoint coming soon — for now, upload files manually.)");
      } else {
        const data = await res.json();
        setSuccess(`Imported ${data.imported ?? 0} file(s) from GCS`);
        fetchDocuments();
      }
    } catch {
      setError("Import failed");
    } finally {
      setImporting(false);
    }
  }

  async function handleReprocess(docId: number) {
    clearMessages();
    // Optimistically show processing state
    setDocuments((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, embedding_status: "processing" } : d)),
    );

    try {
      const res = await fetch(`/api/admin/pilot-documents/${docId}/process`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Re-processing failed");
      } else {
        const data = await res.json();
        setSuccess(`Re-processed: ${data.chunk_count ?? 0} chunks created`);
      }
      fetchDocuments();
    } catch {
      setError("Re-processing failed");
      fetchDocuments();
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading...</p>;

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Upload and manage pilot-facing documents (SOPs, bulletins, training videos).
      </p>

      {error && (
        <div className="px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mb-4">
          {error}
        </div>
      )}
      {success && (
        <div className="px-4 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 mb-4">
          {success}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setShowUpload(true)}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700"
        >
          Upload Document
        </button>
        <button
          onClick={() => setShowCategories(!showCategories)}
          className="border border-gray-300 rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          {showCategories ? "Hide" : "Manage"} Categories
        </button>
        <button
          onClick={handleImportGCS}
          disabled={importing}
          className="border border-gray-300 rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {importing ? "Scanning..." : "Import from GCS"}
        </button>
      </div>

      {/* Category Management */}
      {showCategories && (
        <div className="border border-gray-200 rounded-lg p-4 mb-4 bg-gray-50">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Categories</h3>
          <div className="flex gap-2 mb-3">
            <input
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="New category name"
              className="border border-gray-300 rounded-md px-3 py-2 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-slate-500"
              onKeyDown={(e) => e.key === "Enter" && handleAddCategory()}
            />
            <button
              onClick={handleAddCategory}
              className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-slate-700"
            >
              Add
            </button>
          </div>
          {categories.length === 0 ? (
            <p className="text-sm text-gray-400">No categories yet.</p>
          ) : (
            <div className="space-y-1">
              {categories.map((cat) => (
                <div key={cat.id} className="flex items-center justify-between bg-white border border-gray-200 rounded px-3 py-2 text-sm">
                  <span className="text-gray-800">{cat.name}</span>
                  <button
                    onClick={() => handleDeleteCategory(cat)}
                    className="text-red-500 hover:text-red-700 text-xs"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Upload Modal */}
      {showUpload && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Upload Document</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">File</label>
                <input
                  type="file"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setUploadFile(f);
                    if (f && !uploadTitle) setUploadTitle(f.name.replace(/\.[^.]+$/, ""));
                  }}
                  className="text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <textarea
                  value={uploadDesc}
                  onChange={(e) => setUploadDesc(e.target.value)}
                  rows={2}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={uploadCategory}
                  onChange={(e) => setUploadCategory(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                >
                  <option value="">Select category...</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.name}>{cat.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-4 justify-end">
              <button
                onClick={() => { setShowUpload(false); setUploadFile(null); }}
                className="border border-gray-300 rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={uploading || !uploadFile || !uploadTitle || !uploadCategory}
                className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
              >
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editDoc && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Edit Document</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  rows={2}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                >
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.name}>{cat.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-4 justify-end">
              <button
                onClick={() => setEditDoc(null)}
                className="border border-gray-300 rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleEdit}
                className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Documents Table */}
      {documents.length === 0 ? (
        <div className="text-sm text-gray-400 py-8 text-center border border-dashed border-gray-300 rounded-lg">
          No documents uploaded yet. Click &ldquo;Upload Document&rdquo; to get started.
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Title</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Type</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Size</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">RAG</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 text-gray-800">
                    <div className="font-medium">{doc.title}</div>
                    {doc.description && (
                      <div className="text-gray-400 text-xs mt-0.5 truncate max-w-xs">{doc.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{doc.category}</td>
                  <td className="px-4 py-3 text-gray-600">{fileTypeLabel(doc.content_type)}</td>
                  <td className="px-4 py-3 text-gray-600">{formatBytes(doc.size_bytes)}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {new Date(doc.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    {embeddingBadge(doc.embedding_status, doc.chunk_count, doc.content_type)}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    {doc.content_type.includes("pdf") && (
                      <button
                        onClick={() => handleReprocess(doc.id)}
                        className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                      >
                        Re-process
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setEditDoc(doc);
                        setEditTitle(doc.title);
                        setEditDesc(doc.description || "");
                        setEditCategory(doc.category);
                      }}
                      className="text-slate-600 hover:text-slate-900 text-xs font-medium"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(doc.id)}
                      className="text-red-500 hover:text-red-700 text-xs font-medium"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
