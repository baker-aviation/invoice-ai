"use client";

import { useState, useEffect, useCallback } from "react";
import MeetingUpload from "./MeetingUpload";
import MeetingDetail from "./MeetingDetail";

export type Meeting = {
  id: number;
  title: string;
  status: string;
  duration_sec: number | null;
  screenshot_count: number | null;
  error_message: string | null;
  ticket_count: number;
  created_at: string;
  updated_at: string;
};

type View = "list" | "upload" | "detail";

export default function MeetingsTab() {
  const [view, setView] = useState<View>("list");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const fetchMeetings = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/meetings");
      if (res.ok) {
        const data = await res.json();
        setMeetings(data.meetings || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMeetings();
  }, [fetchMeetings]);

  const openMeeting = (id: number) => {
    setSelectedId(id);
    setView("detail");
  };

  const handleUploadComplete = (meetingId: number) => {
    fetchMeetings();
    setSelectedId(meetingId);
    setView("detail");
  };

  const formatDuration = (sec: number | null) => {
    if (!sec) return "—";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      processing: "bg-yellow-900/40 text-yellow-300 border-yellow-700",
      transcribed: "bg-blue-900/40 text-blue-300 border-blue-700",
      generating: "bg-purple-900/40 text-purple-300 border-purple-700",
      tickets_ready: "bg-emerald-900/40 text-emerald-300 border-emerald-700",
      error: "bg-red-900/40 text-red-300 border-red-700",
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs border ${colors[status] || "bg-zinc-800 text-zinc-400 border-zinc-600"}`}>
        {status.replace("_", " ")}
      </span>
    );
  };

  // ── Detail view ──────────────────────────────────────────────────────────
  if (view === "detail" && selectedId) {
    return (
      <div className="px-6">
        <button
          onClick={() => { setView("list"); fetchMeetings(); }}
          className="text-sm text-zinc-400 hover:text-zinc-200 mb-4 flex items-center gap-1"
        >
          <span>&larr;</span> Back to Meetings
        </button>
        <MeetingDetail meetingId={selectedId} onDelete={() => { setView("list"); fetchMeetings(); }} />
      </div>
    );
  }

  // ── Upload view ──────────────────────────────────────────────────────────
  if (view === "upload") {
    return (
      <div className="px-6">
        <button
          onClick={() => setView("list")}
          className="text-sm text-zinc-400 hover:text-zinc-200 mb-4 flex items-center gap-1"
        >
          <span>&larr;</span> Back to Meetings
        </button>
        <MeetingUpload onComplete={handleUploadComplete} />
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────
  return (
    <div className="px-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">Meetings</h2>
        <button
          onClick={() => setView("upload")}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 transition-colors"
        >
          + New Meeting
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400 py-8">
          <div className="animate-spin w-4 h-4 border-2 border-zinc-500 border-t-transparent rounded-full" />
          Loading...
        </div>
      ) : meetings.length === 0 ? (
        <div className="text-center py-16 text-zinc-500">
          <p className="text-lg mb-2">No meetings yet</p>
          <p className="text-sm">Upload a meeting recording to get started.</p>
        </div>
      ) : (
        <div className="border border-zinc-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-800/50 text-zinc-400 text-left">
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Screenshots</th>
                <th className="px-4 py-3 font-medium">Tickets</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {meetings.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => openMeeting(m.id)}
                  className="border-t border-zinc-700/50 hover:bg-zinc-800/50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3 text-zinc-200 font-medium">{m.title}</td>
                  <td className="px-4 py-3">{statusBadge(m.status)}</td>
                  <td className="px-4 py-3 text-zinc-400">{formatDuration(m.duration_sec)}</td>
                  <td className="px-4 py-3 text-zinc-400">{m.screenshot_count || 0}</td>
                  <td className="px-4 py-3 text-zinc-400">{m.ticket_count}</td>
                  <td className="px-4 py-3 text-zinc-500">
                    {new Date(m.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!confirm(`Delete "${m.title}"?`)) return;
                        fetch(`/api/admin/meetings?id=${m.id}`, { method: "DELETE" }).then((res) => {
                          if (res.ok) fetchMeetings();
                        });
                      }}
                      className="text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30 px-2 py-1 rounded transition-colors"
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
