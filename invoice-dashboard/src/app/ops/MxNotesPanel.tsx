"use client";

import { useState, useCallback, useRef } from "react";
import type { MxNote } from "@/lib/opsApi";
import { BAKER_FLEET } from "@/lib/maintenanceData";

type Attachment = {
  id: number;
  filename: string;
  content_type: string;
  url: string;
};

type MxNoteWithAttachments = MxNote & {
  attachment_count?: number;
  attachments?: Attachment[];
};

export default function MxNotesPanel({ mxNotes: initialNotes = [] }: { mxNotes?: MxNote[] }) {
  const [notes, setNotes] = useState<MxNoteWithAttachments[]>(initialNotes);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");

  // Create form state
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newTail, setNewTail] = useState("");
  const [newAirport, setNewAirport] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Refresh notes from API
  const refreshNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/mx-notes");
      if (res.ok) {
        const data = await res.json();
        setNotes(data.notes ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  // Toggle expand + load attachments
  async function toggleExpand(noteId: string) {
    if (expandedId === noteId) {
      setExpandedId(null);
      setEditingId(null);
      return;
    }
    setExpandedId(noteId);
    setEditingId(null);

    // Load attachments
    const note = notes.find((n) => n.id === noteId);
    if (note && !note.attachments) {
      try {
        const res = await fetch(`/api/ops/mx-notes/${noteId}/attachments`);
        if (res.ok) {
          const data = await res.json();
          setNotes((prev) =>
            prev.map((n) =>
              n.id === noteId ? { ...n, attachments: data.attachments ?? [] } : n,
            ),
          );
        }
      } catch { /* ignore */ }
    }
  }

  // Create note
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newSubject.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/ops/mx-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: newSubject,
          body: newBody || undefined,
          tail_number: newTail || undefined,
          airport_icao: newAirport || undefined,
        }),
      });
      if (res.ok) {
        setNewSubject("");
        setNewBody("");
        setNewTail("");
        setNewAirport("");
        setShowCreate(false);
        await refreshNotes();
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  // Edit note
  function startEdit(note: MxNoteWithAttachments) {
    setEditingId(note.id);
    setEditSubject(note.subject ?? "");
    setEditBody(note.body ?? note.description ?? "");
  }

  async function saveEdit() {
    if (!editingId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/ops/mx-notes/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: editSubject, body: editBody }),
      });
      if (res.ok) {
        setEditingId(null);
        await refreshNotes();
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  // Acknowledge (dismiss)
  async function handleAcknowledge(noteId: string) {
    try {
      const res = await fetch(`/api/ops/mx-notes/${noteId}`, { method: "DELETE" });
      if (res.ok) {
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
        if (expandedId === noteId) setExpandedId(null);
      }
    } catch { /* ignore */ }
  }

  // Upload attachment
  async function handleUpload(noteId: string, file: File) {
    try {
      // 1. Get presigned URL
      const presignRes = await fetch(`/api/ops/mx-notes/${noteId}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name }),
      });
      if (!presignRes.ok) return;
      const { attachment, upload_url } = await presignRes.json();

      // 2. Upload file to GCS
      await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": attachment.content_type },
        body: file,
      });

      // 3. Refresh attachments
      const listRes = await fetch(`/api/ops/mx-notes/${noteId}/attachments`);
      if (listRes.ok) {
        const data = await listRes.json();
        setNotes((prev) =>
          prev.map((n) =>
            n.id === noteId
              ? { ...n, attachments: data.attachments ?? [], attachment_count: (data.attachments ?? []).length }
              : n,
          ),
        );
      }
    } catch { /* ignore */ }
  }

  // Delete attachment
  async function handleDeleteAttachment(noteId: string, attachmentId: number) {
    try {
      const res = await fetch(`/api/ops/mx-notes/${noteId}/attachments?attachment_id=${attachmentId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setNotes((prev) =>
          prev.map((n) =>
            n.id === noteId
              ? {
                  ...n,
                  attachments: (n.attachments ?? []).filter((a) => a.id !== attachmentId),
                  attachment_count: Math.max(0, (n.attachment_count ?? 1) - 1),
                }
              : n,
          ),
        );
      }
    } catch { /* ignore */ }
  }

  // Group notes by tail number
  const grouped = new Map<string, MxNoteWithAttachments[]>();
  for (const note of notes) {
    const key = note.tail_number ?? "Unassigned";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(note);
  }

  function fmtDate(iso: string | null) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">
          Active MX Notes <span className="text-gray-400 font-normal">({notes.length})</span>
        </h3>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
        >
          {showCreate ? "Cancel" : "+ New Note"}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <form onSubmit={handleCreate} className="border border-blue-200 bg-blue-50 rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Subject *</label>
              <input
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
                placeholder="e.g. Oil change due"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Tail #</label>
                <select
                  value={newTail}
                  onChange={(e) => setNewTail(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  <option value="">—</option>
                  {BAKER_FLEET.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Airport</label>
                <input
                  value={newAirport}
                  onChange={(e) => setNewAirport(e.target.value.toUpperCase())}
                  className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  placeholder="KTEB"
                  maxLength={4}
                />
              </div>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Details</label>
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              rows={3}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              placeholder="Additional details..."
            />
          </div>
          <button
            type="submit"
            disabled={loading || !newSubject.trim()}
            className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? "Creating…" : "Create Note"}
          </button>
        </form>
      )}

      {/* Notes grouped by tail */}
      {notes.length === 0 ? (
        <div className="text-sm text-gray-400 py-8 text-center">No active MX notes</div>
      ) : (
        Array.from(grouped.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tail, tailNotes]) => (
            <div key={tail} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{tail}</span>
                <span className="text-xs text-gray-400">({tailNotes.length})</span>
              </div>
              {tailNotes.map((note) => {
                const isExpanded = expandedId === note.id;
                const isEditing = editingId === note.id;
                return (
                  <div key={note.id} className="border border-gray-200 rounded-xl bg-white overflow-hidden">
                    {/* Card header — click to expand */}
                    <button
                      onClick={() => toggleExpand(note.id)}
                      className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-gray-800 truncate">
                            {note.subject || note.description || "MX Note"}
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5 truncate">
                            {note.body || note.description || ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {note.airport_icao && (
                            <span className="text-xs text-gray-400">{note.airport_icao}</span>
                          )}
                          {(note.attachment_count ?? 0) > 0 && (
                            <span className="text-xs text-blue-500">
                              {note.attachment_count} file{note.attachment_count !== 1 ? "s" : ""}
                            </span>
                          )}
                          <span className="text-xs text-gray-400">
                            {fmtDate(note.start_time ?? note.created_at)}
                          </span>
                          <span className="text-gray-300">{isExpanded ? "▲" : "▼"}</span>
                        </div>
                      </div>
                    </button>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
                        {isEditing ? (
                          <div className="space-y-2">
                            <input
                              value={editSubject}
                              onChange={(e) => setEditSubject(e.target.value)}
                              className="w-full text-sm font-semibold border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
                            />
                            <textarea
                              value={editBody}
                              onChange={(e) => setEditBody(e.target.value)}
                              rows={4}
                              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={saveEdit}
                                disabled={loading}
                                className="px-3 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:opacity-50"
                              >
                                {loading ? "Saving…" : "Save"}
                              </button>
                              <button
                                onClick={() => setEditingId(null)}
                                className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {/* Full body */}
                            {(note.body || note.description) && (
                              <div className="text-sm text-gray-700 whitespace-pre-wrap">
                                {note.body || note.description}
                              </div>
                            )}
                            {note.start_time && (
                              <div className="text-xs text-gray-400">
                                {fmtDate(note.start_time)}
                                {note.end_time ? ` — ${fmtDate(note.end_time)}` : ""}
                              </div>
                            )}
                          </>
                        )}

                        {/* Attachments */}
                        {note.attachments && note.attachments.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="text-xs font-medium text-gray-500">Attachments</div>
                            <div className="flex flex-wrap gap-2">
                              {note.attachments.map((att) => (
                                <div key={att.id} className="group flex items-center gap-1.5 border border-gray-200 rounded-lg px-2.5 py-1.5 bg-gray-50">
                                  {att.content_type.startsWith("image/") ? (
                                    <a href={att.url} target="_blank" rel="noopener noreferrer">
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={att.url}
                                        alt={att.filename}
                                        className="w-10 h-10 object-cover rounded"
                                      />
                                    </a>
                                  ) : (
                                    <a
                                      href={att.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-xs text-blue-600 hover:text-blue-800 truncate max-w-[200px]"
                                    >
                                      {att.filename}
                                    </a>
                                  )}
                                  <button
                                    onClick={() => handleDeleteAttachment(note.id, att.id)}
                                    className="text-gray-300 hover:text-red-500 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="Remove"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Action buttons */}
                        {!isEditing && (
                          <div className="flex items-center gap-2 pt-1">
                            <button
                              onClick={() => startEdit(note)}
                              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => {
                                fileInputRef.current?.setAttribute("data-note-id", note.id);
                                fileInputRef.current?.click();
                              }}
                              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                            >
                              Attach File
                            </button>
                            <button
                              onClick={() => handleAcknowledge(note.id)}
                              className="text-xs text-red-500 hover:text-red-700 font-medium ml-auto"
                            >
                              Dismiss
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
      )}

      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const noteId = fileInputRef.current?.getAttribute("data-note-id");
          if (file && noteId) handleUpload(noteId, file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
