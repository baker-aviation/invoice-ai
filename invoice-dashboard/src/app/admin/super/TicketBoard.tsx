"use client";

import { useEffect, useState, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

type Ticket = {
  id: number;
  title: string;
  body: string | null;
  priority: number;
  status: "open" | "in_progress" | "done" | "wont_fix";
  claude_prompt: string | null;
  github_issue: number | null;
  labels: string[];
  created_at: string;
  updated_at: string;
};

type StatusFilter = "all" | "open" | "in_progress" | "done" | "wont_fix";

const STATUS_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  open:        { label: "Open",        color: "text-blue-300",   bg: "bg-blue-900/40 border-blue-700" },
  in_progress: { label: "In Progress", color: "text-yellow-300", bg: "bg-yellow-900/40 border-yellow-700" },
  done:        { label: "Done",        color: "text-emerald-300",bg: "bg-emerald-900/40 border-emerald-700" },
  wont_fix:    { label: "Won't Fix",   color: "text-zinc-400",   bg: "bg-zinc-800 border-zinc-600" },
};

const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
  critical: { label: "P0 — Critical", color: "text-red-400" },
  high:     { label: "P1 — High",     color: "text-orange-400" },
  medium:   { label: "P2 — Medium",   color: "text-yellow-400" },
  low:      { label: "P3 — Low",      color: "text-zinc-400" },
};

function priorityBucket(p: number): string {
  if (p <= 10) return "critical";
  if (p <= 30) return "high";
  if (p <= 60) return "medium";
  return "low";
}

function priorityFromBucket(bucket: string): number {
  switch (bucket) {
    case "critical": return 5;
    case "high": return 20;
    case "medium": return 50;
    case "low": return 80;
    default: return 50;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function TicketBoard() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formBody, setFormBody] = useState("");
  const [formPriority, setFormPriority] = useState("medium");
  const [formPrompt, setFormPrompt] = useState("");
  const [formGithub, setFormGithub] = useState("");
  const [formLabels, setFormLabels] = useState("");
  const [formStatus, setFormStatus] = useState<Ticket["status"]>("open");
  const [saving, setSaving] = useState(false);

  // ── Fetch tickets ─────────────────────────────────────────────────────────

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const url = filter === "all"
        ? "/api/admin/tickets"
        : `/api/admin/tickets?status=${filter}`;
      const res = await fetch(url);
      const data = await res.json();
      setTickets(data.tickets || []);
    } catch {
      console.error("Failed to fetch tickets");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  // ── Form helpers ──────────────────────────────────────────────────────────

  const resetForm = () => {
    setFormTitle("");
    setFormBody("");
    setFormPriority("medium");
    setFormPrompt("");
    setFormGithub("");
    setFormLabels("");
    setFormStatus("open");
    setEditingId(null);
    setShowForm(false);
  };

  const openEdit = (t: Ticket) => {
    setFormTitle(t.title);
    setFormBody(t.body || "");
    setFormPriority(priorityBucket(t.priority));
    setFormPrompt(t.claude_prompt || "");
    setFormGithub(t.github_issue?.toString() || "");
    setFormLabels(t.labels.join(", "));
    setFormStatus(t.status);
    setEditingId(t.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!formTitle.trim()) return;
    setSaving(true);

    const payload = {
      title: formTitle.trim(),
      body: formBody.trim() || null,
      priority: priorityFromBucket(formPriority),
      claude_prompt: formPrompt.trim() || null,
      github_issue: formGithub ? parseInt(formGithub) : null,
      labels: formLabels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
      status: formStatus,
    };

    try {
      if (editingId) {
        await fetch("/api/admin/tickets", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingId, ...payload }),
        });
      } else {
        await fetch("/api/admin/tickets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      resetForm();
      fetchTickets();
    } catch {
      console.error("Failed to save ticket");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this ticket?")) return;
    await fetch(`/api/admin/tickets?id=${id}`, { method: "DELETE" });
    fetchTickets();
  };

  const handleStatusChange = async (id: number, status: Ticket["status"]) => {
    await fetch("/api/admin/tickets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    fetchTickets();
  };

  const copyPrompt = (id: number, prompt: string) => {
    navigator.clipboard.writeText(prompt);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // ── Filtered + grouped tickets ────────────────────────────────────────────

  const filtered = filter === "all" ? tickets : tickets.filter((t) => t.status === filter);
  const openTickets = filtered.filter((t) => t.status === "open" || t.status === "in_progress");
  const closedTickets = filtered.filter((t) => t.status === "done" || t.status === "wont_fix");

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="px-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-zinc-100">Tickets</h2>
          <div className="flex gap-1">
            {(["all", "open", "in_progress", "done"] as StatusFilter[]).map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  filter === s
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {s === "all" ? "All" : STATUS_LABELS[s]?.label || s}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
          className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-500"
        >
          + New Ticket
        </button>
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-5 space-y-4">
          <h3 className="text-sm font-medium text-zinc-200">
            {editingId ? "Edit Ticket" : "New Ticket"}
          </h3>

          {/* Title */}
          <input
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            placeholder="Ticket title"
            className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500"
          />

          {/* Body */}
          <textarea
            value={formBody}
            onChange={(e) => setFormBody(e.target.value)}
            placeholder="Description (optional, markdown supported)"
            rows={3}
            className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 resize-y"
          />

          {/* Priority + Status + GitHub issue row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Priority</label>
              <select
                value={formPriority}
                onChange={(e) => setFormPriority(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
              >
                <option value="critical">P0 — Critical</option>
                <option value="high">P1 — High</option>
                <option value="medium">P2 — Medium</option>
                <option value="low">P3 — Low</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Status</label>
              <select
                value={formStatus}
                onChange={(e) => setFormStatus(e.target.value as Ticket["status"])}
                className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
              >
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="done">Done</option>
                <option value="wont_fix">Won&apos;t Fix</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">GitHub Issue #</label>
              <input
                value={formGithub}
                onChange={(e) => setFormGithub(e.target.value.replace(/\D/g, ""))}
                placeholder="e.g. 199"
                className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none"
              />
            </div>
          </div>

          {/* Labels */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Labels (comma-separated)</label>
            <input
              value={formLabels}
              onChange={(e) => setFormLabels(e.target.value)}
              placeholder="e.g. bug, crew-swap, frontend"
              className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none"
            />
          </div>

          {/* Claude Prompt */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Claude Prompt — paste into Claude Code to work on this ticket
            </label>
            <textarea
              value={formPrompt}
              onChange={(e) => setFormPrompt(e.target.value)}
              placeholder="e.g. Fix the crew swap optimizer to flag commercial flights that depart less than 90 minutes after the last leg lands. See issue #199. The relevant code is in..."
              rows={4}
              className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 resize-y font-mono"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={resetForm}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!formTitle.trim() || saving}
              className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-40"
            >
              {saving ? "Saving..." : editingId ? "Update" : "Create"}
            </button>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-zinc-400 text-sm py-8 justify-center">
          <div className="animate-spin w-4 h-4 border-2 border-zinc-500 border-t-transparent rounded-full" />
          Loading tickets...
        </div>
      )}

      {/* Ticket list — active */}
      {!loading && openTickets.length > 0 && (
        <div className="space-y-2">
          {openTickets.map((t) => (
            <TicketRow
              key={t.id}
              ticket={t}
              expanded={expandedId === t.id}
              copiedId={copiedId}
              onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
              onEdit={() => openEdit(t)}
              onDelete={() => handleDelete(t.id)}
              onStatusChange={(s) => handleStatusChange(t.id, s)}
              onCopyPrompt={() => t.claude_prompt && copyPrompt(t.id, t.claude_prompt)}
            />
          ))}
        </div>
      )}

      {/* Closed tickets */}
      {!loading && closedTickets.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
            Closed ({closedTickets.length})
          </h3>
          <div className="space-y-2 opacity-60">
            {closedTickets.map((t) => (
              <TicketRow
                key={t.id}
                ticket={t}
                expanded={expandedId === t.id}
                copiedId={copiedId}
                onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
                onEdit={() => openEdit(t)}
                onDelete={() => handleDelete(t.id)}
                onStatusChange={(s) => handleStatusChange(t.id, s)}
                onCopyPrompt={() => t.claude_prompt && copyPrompt(t.id, t.claude_prompt)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="text-center py-12 text-zinc-500">
          <p className="text-lg mb-1">No tickets yet</p>
          <p className="text-sm">Click &quot;+ New Ticket&quot; to create one</p>
        </div>
      )}
    </div>
  );
}

// ─── Ticket Row ─────────────────────────────────────────────────────────────

function TicketRow({
  ticket: t,
  expanded,
  copiedId,
  onToggle,
  onEdit,
  onDelete,
  onStatusChange,
  onCopyPrompt,
}: {
  ticket: Ticket;
  expanded: boolean;
  copiedId: number | null;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatusChange: (s: Ticket["status"]) => void;
  onCopyPrompt: () => void;
}) {
  const pBucket = priorityBucket(t.priority);
  const pInfo = PRIORITY_LABELS[pBucket];
  const sInfo = STATUS_LABELS[t.status];

  return (
    <div className={`border rounded-lg overflow-hidden ${sInfo.bg}`}>
      {/* Header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
      >
        {/* Priority dot */}
        <span className={`text-xs font-mono ${pInfo.color}`}>
          {pBucket === "critical" ? "!!!" : pBucket === "high" ? "!!" : pBucket === "medium" ? "!" : "·"}
        </span>

        {/* Title */}
        <span className="flex-1 text-sm font-medium text-zinc-100 truncate">
          {t.title}
        </span>

        {/* Labels */}
        <div className="hidden sm:flex gap-1">
          {t.labels.map((l) => (
            <span
              key={l}
              className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-300"
            >
              {l}
            </span>
          ))}
        </div>

        {/* GitHub link */}
        {t.github_issue && (
          <a
            href={`https://github.com/baker-aviation/invoice-ai/issues/${t.github_issue}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            #{t.github_issue}
          </a>
        )}

        {/* Status badge */}
        <span className={`text-xs px-2 py-0.5 rounded-full ${sInfo.color} bg-black/20`}>
          {sInfo.label}
        </span>

        {/* Chevron */}
        <span className={`text-zinc-500 transition-transform ${expanded ? "rotate-90" : ""}`}>
          ▸
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-white/10 pt-3">
          {/* Body */}
          {t.body && (
            <p className="text-sm text-zinc-300 whitespace-pre-wrap">{t.body}</p>
          )}

          {/* Claude prompt */}
          {t.claude_prompt && (
            <div className="bg-zinc-900/80 border border-zinc-600 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-zinc-400">Claude Prompt</span>
                <button
                  onClick={onCopyPrompt}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  {copiedId === t.id ? "Copied!" : "Copy"}
                </button>
              </div>
              <pre className="text-xs text-zinc-200 whitespace-pre-wrap font-mono leading-relaxed">
                {t.claude_prompt}
              </pre>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <select
              value={t.status}
              onChange={(e) => onStatusChange(e.target.value as Ticket["status"])}
              className="bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 outline-none"
            >
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="done">Done</option>
              <option value="wont_fix">Won&apos;t Fix</option>
            </select>
            <button
              onClick={onEdit}
              className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1"
            >
              Edit
            </button>
            <button
              onClick={onDelete}
              className="text-xs text-red-400 hover:text-red-300 px-2 py-1"
            >
              Delete
            </button>
            <span className="flex-1" />
            <span className="text-[10px] text-zinc-600">
              {new Date(t.created_at).toLocaleDateString()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
