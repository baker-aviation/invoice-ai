"use client";

import { useState, useEffect, useCallback, useRef } from "react";

type Meeting = {
  id: number;
  title: string;
  status: string;
  transcript: string | null;
  summary: string | null;
  video_gcs_key: string | null;
  duration_sec: number | null;
  screenshot_count: number | null;
  error_message: string | null;
  created_at: string;
};

type Screenshot = {
  id: number;
  meeting_id: number;
  gcs_key: string;
  time_sec: number;
  url: string;
};

type MeetingTicket = {
  id: number;
  meeting_id: number;
  title: string;
  description: string | null;
  ticket_type: string;
  priority: string;
  assignee_hint: string | null;
  timestamp_secs: number[];
  screenshot_ids: number[];
  status: string;
  admin_ticket_id: number | null;
  linear_issue_id: string | null;
};

export default function MeetingDetail({ meetingId, onDelete }: { meetingId: number; onDelete?: () => void }) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [tickets, setTickets] = useState<MeetingTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedImg, setSelectedImg] = useState<Screenshot | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [editingTicket, setEditingTicket] = useState<number | null>(null);
  const [ticketEdits, setTicketEdits] = useState<{ title: string; description: string }>({ title: "", description: "" });
  const [addingNotes, setAddingNotes] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [meetingRes, screenshotsRes, ticketsRes] = await Promise.all([
        fetch(`/api/admin/meetings?action=get&id=${meetingId}`),
        fetch(`/api/admin/meetings/${meetingId}/screenshots`),
        fetch(`/api/admin/meetings/${meetingId}/tickets`),
      ]);

      if (meetingRes.ok) {
        const data = await meetingRes.json();
        if (data.meeting) setMeeting(data.meeting);
      }

      if (screenshotsRes.ok) {
        const data = await screenshotsRes.json();
        setScreenshots(data.screenshots || []);
      }

      if (ticketsRes.ok) {
        const data = await ticketsRes.json();
        setTickets(data.tickets || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [meetingId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Poll while status is "processing" so we auto-update when transcription finishes (or fails)
  useEffect(() => {
    if (!meeting || (meeting.status !== "processing" && meeting.status !== "generating")) return;
    const interval = setInterval(() => {
      fetchAll();
    }, 5000);
    return () => clearInterval(interval);
  }, [meeting?.status, fetchAll]);

  // ── Delete meeting ───────────────────────────────────────────────────────

  const deleteMeeting = async () => {
    if (!confirm("Delete this meeting and all its screenshots/tickets?")) return;
    const res = await fetch(`/api/admin/meetings?id=${meetingId}`, { method: "DELETE" });
    if (res.ok) onDelete?.();
    else alert("Failed to delete meeting");
  };

  // ── Title editing ────────────────────────────────────────────────────────

  const saveTitle = async () => {
    if (!titleInput.trim()) return;
    await fetch("/api/admin/meetings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: meetingId, title: titleInput.trim() }),
    });
    setEditingTitle(false);
    fetchAll();
  };

  // ── Generate tickets ─────────────────────────────────────────────────────

  const generateTickets = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/admin/meetings/${meetingId}/generate-tickets`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Failed: ${data.error || res.statusText}`);
        return;
      }
      fetchAll();
    } catch (e) {
      alert(`Error: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setGenerating(false);
    }
  };

  // ── Ticket actions (update locally, no full refetch) ──────────────────────

  const ticketAction = async (ticketId: number, action: string, extraBody?: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/meetings/${meetingId}/tickets`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket_id: ticketId, action, ...extraBody }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      setTickets((prev) =>
        prev.map((t) => {
          if (t.id !== ticketId) return t;
          const updated = { ...t, status: action === "accept" ? "accepted" : action === "reject" ? "rejected" : t.status };
          if (data.github_issue) updated.linear_issue_id = `gh${data.github_issue}`;
          return updated;
        }),
      );
    }
  };

  const acceptWithNotes = async (ticketId: number) => {
    // Append notes to description before accepting
    if (noteText.trim()) {
      await fetch(`/api/admin/meetings/${meetingId}/tickets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket_id: ticketId,
          description: (tickets.find((t) => t.id === ticketId)?.description || "") + "\n\n---\n**Notes:** " + noteText.trim(),
        }),
      });
    }
    await ticketAction(ticketId, "accept");
    setAddingNotes(null);
    setNoteText("");
  };

  const saveTicketEdit = async (ticketId: number) => {
    const res = await fetch(`/api/admin/meetings/${meetingId}/tickets`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket_id: ticketId,
        title: ticketEdits.title,
        description: ticketEdits.description,
      }),
    });
    if (res.ok) {
      setTickets((prev) =>
        prev.map((t) => (t.id === ticketId ? { ...t, title: ticketEdits.title, description: ticketEdits.description } : t)),
      );
    }
    setEditingTicket(null);
  };

  // ── Find screenshot closest to a timestamp ───────────────────────────────

  const getScreenshotForTimestamp = (ts: number): Screenshot | undefined => {
    if (screenshots.length === 0) return undefined;
    return screenshots.reduce((closest, s) =>
      Math.abs(Number(s.time_sec) - ts) < Math.abs(Number(closest.time_sec) - ts) ? s : closest,
    );
  };

  // ── Seek video to timestamp ──────────────────────────────────────────────

  const seekTo = (sec: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = sec;
      videoRef.current.play().catch(() => {});
    }
  };

  // ── Format helpers ───────────────────────────────────────────────────────

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const priorityColor = (p: string) => {
    const colors: Record<string, string> = {
      critical: "text-red-400",
      high: "text-orange-400",
      medium: "text-yellow-400",
      low: "text-zinc-400",
    };
    return colors[p] || "text-zinc-400";
  };

  const typeIcon = (t: string) => {
    const icons: Record<string, string> = {
      task: "[ ]",
      bug: "[!]",
      feature: "[+]",
      action_item: "[>]",
      follow_up: "[~]",
    };
    return icons[t] || "[ ]";
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      pending: "bg-zinc-700 text-zinc-300",
      accepted: "bg-emerald-900/40 text-emerald-300",
      rejected: "bg-red-900/40 text-red-400",
      pushed_to_linear: "bg-purple-900/40 text-purple-300",
    };
    return (
      <span className={`px-2 py-0.5 rounded text-xs ${colors[status] || "bg-zinc-700 text-zinc-300"}`}>
        {status.replace("_", " ")}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 py-8">
        <div className="animate-spin w-4 h-4 border-2 border-zinc-500 border-t-transparent rounded-full" />
        Loading meeting...
      </div>
    );
  }

  if (!meeting) {
    return <p className="text-zinc-400 py-8">Meeting not found.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          {editingTitle ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                className="px-2 py-1 bg-zinc-800 border border-zinc-600 rounded text-zinc-100 text-lg font-semibold"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
              />
              <button onClick={saveTitle} className="text-xs text-blue-400 hover:text-blue-300">Save</button>
              <button onClick={() => setEditingTitle(false)} className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
            </div>
          ) : (
            <h2
              className="text-xl font-semibold text-zinc-100 cursor-pointer hover:text-zinc-300"
              onClick={() => { setEditingTitle(true); setTitleInput(meeting.title); }}
              title="Click to edit"
            >
              {meeting.title}
            </h2>
          )}
          <p className="text-sm text-zinc-500 mt-1">
            {new Date(meeting.created_at).toLocaleString()}
            {meeting.duration_sec ? ` · ${formatTime(meeting.duration_sec)}` : ""}
            {meeting.screenshot_count ? ` · ${meeting.screenshot_count} screenshots` : ""}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Generate tickets button */}
          {(meeting.status === "transcribed" || meeting.status === "tickets_ready") && (
            <button
              onClick={generateTickets}
              disabled={generating}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                generating
                  ? "bg-zinc-700 text-zinc-400 cursor-not-allowed"
                  : "bg-purple-600 text-white hover:bg-purple-500"
              }`}
            >
              {generating ? (
                <span className="flex items-center gap-2">
                  <span className="animate-spin w-3 h-3 border-2 border-purple-300 border-t-transparent rounded-full" />
                  Generating...
                </span>
              ) : meeting.status === "tickets_ready" ? (
                "Regenerate Tickets"
              ) : (
                "Generate Tickets with AI"
              )}
            </button>
          )}
          {/* Delete button */}
          <button
            onClick={deleteMeeting}
            className="px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded-lg transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Summary */}
      {meeting.summary && (
        <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-400 mb-1">Meeting Summary</h3>
          <p className="text-sm text-zinc-200">{meeting.summary}</p>
        </div>
      )}

      {/* Video player */}
      {meeting.video_gcs_key && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-2">Video</h3>
          <p className="text-xs text-zinc-500 mb-2">
            Video playback is available after processing. Use the screenshot timeline below for quick navigation.
          </p>
        </div>
      )}

      {/* Screenshot timeline */}
      {screenshots.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-2">
            Screenshots ({screenshots.length})
          </h3>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {screenshots.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedImg(s)}
                className="flex-shrink-0 relative group rounded-lg overflow-hidden border border-zinc-700 hover:border-zinc-500 transition-colors"
              >
                <img
                  src={s.url}
                  alt={`Frame at ${formatTime(Number(s.time_sec))}`}
                  className="h-20 w-auto object-cover"
                  loading="lazy"
                />
                <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-[10px] text-zinc-300 text-center py-0.5">
                  {formatTime(Number(s.time_sec))}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Lightbox */}
      {selectedImg && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setSelectedImg(null)}
        >
          <div className="relative max-w-5xl w-full" onClick={(e) => e.stopPropagation()}>
            <img
              src={selectedImg.url}
              alt={`Frame at ${formatTime(Number(selectedImg.time_sec))}`}
              className="w-full rounded-lg"
            />
            <div className="absolute top-2 right-2 flex gap-2">
              <span className="bg-black/70 text-white text-sm px-3 py-1 rounded-full">
                {formatTime(Number(selectedImg.time_sec))}
              </span>
              <button
                onClick={() => setSelectedImg(null)}
                className="bg-black/70 text-white text-sm px-3 py-1 rounded-full hover:bg-black"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transcript */}
      {meeting.transcript ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-zinc-300">Transcript</h3>
            <button
              onClick={() => navigator.clipboard.writeText(meeting.transcript || "")}
              className="text-xs text-blue-400 hover:text-blue-300 underline"
            >
              Copy to clipboard
            </button>
          </div>
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 max-h-64 overflow-y-auto">
            <p className="text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">
              {meeting.transcript}
            </p>
          </div>
        </div>
      ) : meeting.status === "processing" ? (
        <div className="flex items-center gap-2 text-zinc-400 text-sm py-4">
          <div className="animate-spin w-4 h-4 border-2 border-zinc-500 border-t-transparent rounded-full" />
          Transcription in progress...
        </div>
      ) : meeting.status === "error" ? (
        <div className="rounded-lg bg-red-900/30 border border-red-700 p-4">
          <p className="text-red-300 font-medium text-sm">Transcription failed</p>
          {meeting.error_message && (
            <p className="text-red-400 text-xs mt-1">{meeting.error_message}</p>
          )}
          <p className="text-zinc-500 text-xs mt-2">
            You can delete this meeting and re-upload the video to try again.
          </p>
        </div>
      ) : null}

      {/* Tickets */}
      {tickets.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">
            Generated Tickets ({tickets.length})
          </h3>
          <div className="space-y-3">
            {tickets.map((ticket) => {
              const isEditing = editingTicket === ticket.id;
              // Find the screenshot closest to the first timestamp
              const relevantTimestamp = ticket.timestamp_secs?.[0];
              const relevantScreenshot = relevantTimestamp != null
                ? getScreenshotForTimestamp(relevantTimestamp)
                : undefined;

              return (
                <div
                  key={ticket.id}
                  className={`border rounded-lg p-4 transition-colors ${
                    ticket.status === "rejected"
                      ? "border-zinc-700/50 bg-zinc-900/30 opacity-60"
                      : ticket.status === "accepted"
                        ? "border-emerald-700/50 bg-emerald-900/10"
                        : "border-zinc-700 bg-zinc-800/50"
                  }`}
                >
                  <div className="flex gap-4">
                    {/* Screenshot context */}
                    {relevantScreenshot && (
                      <div className="flex-shrink-0">
                        <button
                          onClick={() => setSelectedImg(relevantScreenshot)}
                          className="rounded-lg overflow-hidden border border-zinc-700 hover:border-zinc-500 transition-colors"
                        >
                          <img
                            src={relevantScreenshot.url}
                            alt={`Context at ${formatTime(relevantTimestamp || 0)}`}
                            className="h-24 w-auto object-cover"
                          />
                        </button>
                        <p className="text-[10px] text-zinc-500 text-center mt-1">
                          {formatTime(relevantTimestamp || 0)}
                        </p>
                      </div>
                    )}

                    {/* Ticket content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            <input
                              type="text"
                              value={ticketEdits.title}
                              onChange={(e) => setTicketEdits((prev) => ({ ...prev, title: e.target.value }))}
                              className="w-full px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-sm text-zinc-100"
                            />
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono text-zinc-500">{typeIcon(ticket.ticket_type)}</span>
                              <h4 className="text-sm font-medium text-zinc-100 truncate">{ticket.title}</h4>
                            </div>
                          )}

                          <div className="flex items-center gap-2 mt-1">
                            <span className={`text-xs ${priorityColor(ticket.priority)}`}>
                              {ticket.priority}
                            </span>
                            <span className="text-xs text-zinc-600">|</span>
                            <span className="text-xs text-zinc-500">{ticket.ticket_type.replace("_", " ")}</span>
                            {ticket.assignee_hint && (
                              <>
                                <span className="text-xs text-zinc-600">|</span>
                                <span className="text-xs text-zinc-400">{ticket.assignee_hint}</span>
                              </>
                            )}
                            {statusBadge(ticket.status)}
                            {ticket.linear_issue_id?.startsWith("gh#") && (
                              <a
                                href={`https://github.com/baker-aviation/invoice-ai/issues/${ticket.linear_issue_id.replace("gh#", "")}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-400 hover:text-blue-300 underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {ticket.linear_issue_id.replace("gh", "")}
                              </a>
                            )}
                          </div>
                        </div>

                        {/* Actions */}
                        {ticket.status === "pending" && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {isEditing ? (
                              <>
                                <button
                                  onClick={() => saveTicketEdit(ticket.id)}
                                  className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingTicket(null)}
                                  className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => {
                                    setEditingTicket(ticket.id);
                                    setAddingNotes(null);
                                    setTicketEdits({ title: ticket.title, description: ticket.description || "" });
                                  }}
                                  className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 rounded hover:bg-zinc-700"
                                  title="Edit"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => ticketAction(ticket.id, "accept")}
                                  className="px-2 py-1 text-xs bg-emerald-700 text-emerald-100 rounded hover:bg-emerald-600"
                                >
                                  Accept
                                </button>
                                <button
                                  onClick={() => {
                                    setAddingNotes(addingNotes === ticket.id ? null : ticket.id);
                                    setEditingTicket(null);
                                    setNoteText("");
                                  }}
                                  className={`px-2 py-1 text-xs rounded ${
                                    addingNotes === ticket.id
                                      ? "bg-blue-600 text-white"
                                      : "bg-blue-900/40 text-blue-300 hover:bg-blue-800/40"
                                  }`}
                                >
                                  + Notes
                                </button>
                                <button
                                  onClick={() => ticketAction(ticket.id, "reject")}
                                  className="px-2 py-1 text-xs bg-red-900/50 text-red-300 rounded hover:bg-red-800/50"
                                >
                                  Reject
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Description */}
                      {isEditing ? (
                        <textarea
                          value={ticketEdits.description}
                          onChange={(e) => setTicketEdits((prev) => ({ ...prev, description: e.target.value }))}
                          className="w-full mt-2 px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-sm text-zinc-200 h-20 resize-y"
                        />
                      ) : ticket.description ? (
                        <p className="text-sm text-zinc-200 mt-2 line-clamp-3">{ticket.description}</p>
                      ) : null}

                      {/* Add notes before accepting */}
                      {addingNotes === ticket.id && (
                        <div className="mt-2 space-y-2">
                          <textarea
                            value={noteText}
                            onChange={(e) => setNoteText(e.target.value)}
                            placeholder="Add notes, context, or details before accepting..."
                            className="w-full px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-sm text-zinc-200 h-20 resize-y placeholder-zinc-500"
                            autoFocus
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => acceptWithNotes(ticket.id)}
                              className="px-3 py-1 text-xs bg-emerald-700 text-emerald-100 rounded hover:bg-emerald-600"
                            >
                              Accept with Notes
                            </button>
                            <button
                              onClick={() => { setAddingNotes(null); setNoteText(""); }}
                              className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Timestamp links */}
                      {ticket.timestamp_secs?.length > 0 && !isEditing && addingNotes !== ticket.id && (
                        <div className="flex gap-1 mt-2">
                          {ticket.timestamp_secs.map((ts, i) => (
                            <button
                              key={i}
                              onClick={() => {
                                const ss = getScreenshotForTimestamp(Number(ts));
                                if (ss) setSelectedImg(ss);
                              }}
                              className="text-[10px] text-blue-400 hover:text-blue-300 bg-blue-900/20 px-1.5 py-0.5 rounded"
                            >
                              @{formatTime(Number(ts))}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Bulk actions */}
          {tickets.some((t) => t.status === "pending") && (
            <div className="flex gap-2 mt-4 pt-4 border-t border-zinc-700">
              <button
                onClick={async () => {
                  const pending = tickets.filter((t) => t.status === "pending");
                  await Promise.all(pending.map((t) => ticketAction(t.id, "accept")));
                }}
                className="px-3 py-1.5 text-xs bg-emerald-700 text-emerald-100 rounded-lg hover:bg-emerald-600"
              >
                Accept All ({tickets.filter((t) => t.status === "pending").length})
              </button>
              <button
                onClick={async () => {
                  const pending = tickets.filter((t) => t.status === "pending");
                  await Promise.all(pending.map((t) => ticketAction(t.id, "reject")));
                }}
                className="px-3 py-1.5 text-xs bg-red-900/50 text-red-300 rounded-lg hover:bg-red-800/50"
              >
                Reject All
              </button>
            </div>
          )}
        </div>
      )}

      {/* Hidden video element */}
      <video ref={videoRef} className="hidden" />
    </div>
  );
}
