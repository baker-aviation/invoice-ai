"use client";

import { useEffect, useState, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

type TicketSection = "general" | "crew-swap" | "international" | "current-ops" | "duty" | "notams" | "hiring" | "invoices" | "push-to-others";

type Ticket = {
  id: number;
  title: string;
  body: string | null;
  priority: number;
  status: "open" | "in_progress" | "done" | "wont_fix";
  section: TicketSection;
  claude_prompt: string | null;
  github_issue: number | null;
  labels: string[];
  created_at: string;
  updated_at: string;
};

type StatusFilter = "all" | "open" | "in_progress" | "done" | "wont_fix";
type KindFilter = "all" | "task" | "checklist";
type SectionFilter = "all" | TicketSection;

const SECTION_LABELS: Record<TicketSection, { label: string; color: string }> = {
  general:       { label: "General",       color: "bg-gray-100 text-gray-600" },
  "crew-swap":   { label: "Crew Swap",     color: "bg-indigo-100 text-indigo-700" },
  international: { label: "International", color: "bg-sky-100 text-sky-700" },
  "current-ops": { label: "Current Ops",   color: "bg-amber-100 text-amber-700" },
  duty:          { label: "Duty",          color: "bg-orange-100 text-orange-700" },
  notams:        { label: "NOTAMs",        color: "bg-rose-100 text-rose-700" },
  hiring:        { label: "Hiring",        color: "bg-emerald-100 text-emerald-700" },
  invoices:          { label: "Invoices",          color: "bg-violet-100 text-violet-700" },
  "push-to-others":  { label: "Push to Others",    color: "bg-teal-100 text-teal-700" },
};

/** Derive ticket kind from its data — no DB column needed */
function ticketKind(t: Ticket): "task" | "checklist" {
  if (t.claude_prompt) return "task";
  if (t.body && /- \[[ x]\]/i.test(t.body)) return "checklist";
  return "task"; // default
}

const KIND_LABELS: Record<KindFilter, { label: string; icon: string }> = {
  all:       { label: "All",        icon: "" },
  task:      { label: "Tasks",      icon: ">" },
  checklist: { label: "Checklists", icon: "\u2611" },
};

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
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [sectionFilter, setSectionFilter] = useState<SectionFilter>("all");
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
  const [formSection, setFormSection] = useState<TicketSection>("general");
  const [formStatus, setFormStatus] = useState<Ticket["status"]>("open");
  const [formKind, setFormKind] = useState<"task" | "checklist">("task");
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
    setFormSection("general");
    setFormStatus("open");
    setFormKind("task");
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
    setFormSection(t.section || "general");
    setFormStatus(t.status);
    setFormKind(ticketKind(t));
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
      section: formSection,
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

  const handleBodyUpdate = async (id: number, body: string) => {
    // Optimistic update
    setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, body } : t)));
    await fetch("/api/admin/tickets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, body }),
    });
  };

  // ── Filtered + grouped tickets ────────────────────────────────────────────

  const filtered = tickets
    .filter((t) => filter === "all" || t.status === filter)
    .filter((t) => kindFilter === "all" || ticketKind(t) === kindFilter)
    .filter((t) => sectionFilter === "all" || (t.section ?? "general") === sectionFilter);
  const openTickets = filtered.filter((t) => t.status === "open" || t.status === "in_progress");
  const closedTickets = filtered.filter((t) => t.status === "done" || t.status === "wont_fix");
  const taskCount = tickets.filter((t) => ticketKind(t) === "task" && (t.status === "open" || t.status === "in_progress")).length;
  const checklistCount = tickets.filter((t) => ticketKind(t) === "checklist" && (t.status === "open" || t.status === "in_progress")).length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="px-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-zinc-100">Tickets</h2>
          {/* Kind filter */}
          <div className="flex gap-0.5 bg-zinc-800 rounded-lg p-0.5">
            {(["all", "task", "checklist"] as KindFilter[]).map((k) => (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  kindFilter === k
                    ? k === "task" ? "bg-purple-600 text-white"
                    : k === "checklist" ? "bg-teal-600 text-white"
                    : "bg-zinc-600 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {KIND_LABELS[k].icon ? `${KIND_LABELS[k].icon} ` : ""}{KIND_LABELS[k].label}
                {k === "task" && taskCount > 0 && <span className="ml-1 text-[10px] opacity-70">({taskCount})</span>}
                {k === "checklist" && checklistCount > 0 && <span className="ml-1 text-[10px] opacity-70">({checklistCount})</span>}
              </button>
            ))}
          </div>
          {/* Section filter */}
          <select
            value={sectionFilter}
            onChange={(e) => setSectionFilter(e.target.value as SectionFilter)}
            className="bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 outline-none"
          >
            <option value="all">All Sections</option>
            {(Object.entries(SECTION_LABELS) as [TicketSection, { label: string }][]).map(([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          {/* Status filter */}
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
        <div className="flex gap-2">
          <button
            onClick={() => { resetForm(); setFormKind("checklist"); setShowForm(true); }}
            className="px-3 py-2 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-500"
          >
            + Checklist
          </button>
          <button
            onClick={() => { resetForm(); setFormKind("task"); setShowForm(true); }}
            className="px-3 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500"
          >
            + Task
          </button>
        </div>
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <div className={`border rounded-lg p-5 space-y-4 ${formKind === "checklist" ? "bg-teal-900/20 border-teal-800" : "bg-purple-900/20 border-purple-800"}`}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-200">
              {editingId ? "Edit" : "New"} {formKind === "checklist" ? "Checklist" : "Task"}
            </h3>
            <div className="flex gap-1 bg-zinc-800 rounded-lg p-0.5">
              <button onClick={() => setFormKind("task")}
                className={`px-3 py-1 text-xs rounded-md ${formKind === "task" ? "bg-purple-600 text-white" : "text-zinc-400"}`}>
                Task
              </button>
              <button onClick={() => setFormKind("checklist")}
                className={`px-3 py-1 text-xs rounded-md ${formKind === "checklist" ? "bg-teal-600 text-white" : "text-zinc-400"}`}>
                Checklist
              </button>
            </div>
          </div>

          {/* Title */}
          <input
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            placeholder={formKind === "checklist" ? "Checklist title (e.g. QA: #199 departure buffer)" : "Task title"}
            className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500"
          />

          {/* Body / Checklist */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              {formKind === "checklist" ? "Checklist items (use - [ ] for each item)" : "Description (optional, markdown supported)"}
            </label>
            <textarea
              value={formBody}
              onChange={(e) => setFormBody(e.target.value)}
              placeholder={formKind === "checklist"
                ? "### Section\n\n- [ ] First check item\n- [ ] Second check item\n- [ ] Third check item"
                : "Description (optional)"}
              rows={formKind === "checklist" ? 6 : 3}
              className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 resize-y font-mono"
            />
          </div>

          {/* Priority + Status + Section + GitHub issue row */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
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
              <label className="block text-xs text-zinc-400 mb-1">Section</label>
              <select
                value={formSection}
                onChange={(e) => setFormSection(e.target.value as TicketSection)}
                className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
              >
                {(Object.entries(SECTION_LABELS) as [TicketSection, { label: string }][]).map(([key, { label }]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
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

          {/* Claude Prompt — only for tasks */}
          {formKind === "task" && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Claude Prompt — paste into Claude Code to work on this task
              </label>
              <textarea
                value={formPrompt}
                onChange={(e) => setFormPrompt(e.target.value)}
                placeholder="e.g. Fix the crew swap optimizer to flag commercial flights that depart less than 90 minutes after the last leg lands. See issue #199. The relevant code is in..."
                rows={4}
                className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 resize-y font-mono"
              />
            </div>
          )}

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
              onBodyUpdate={(body) => handleBodyUpdate(t.id, body)}
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
                onBodyUpdate={(body) => handleBodyUpdate(t.id, body)}
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
  onBodyUpdate,
}: {
  ticket: Ticket;
  expanded: boolean;
  copiedId: number | null;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatusChange: (s: Ticket["status"]) => void;
  onCopyPrompt: () => void;
  onBodyUpdate: (body: string) => void;
}) {
  const pBucket = priorityBucket(t.priority);
  const pInfo = PRIORITY_LABELS[pBucket];
  const sInfo = STATUS_LABELS[t.status];
  const kind = ticketKind(t);

  return (
    <div className={`border rounded-lg overflow-hidden ${sInfo.bg} ${kind === "checklist" ? "border-l-2 border-l-teal-500" : "border-l-2 border-l-purple-500"}`}>
      {/* Header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
      >
        {/* Kind icon */}
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${kind === "checklist" ? "bg-teal-900/50 text-teal-400" : "bg-purple-900/50 text-purple-400"}`}>
          {kind === "checklist" ? "\u2611" : ">_"}
        </span>

        {/* Priority dot */}
        <span className={`text-xs font-mono ${pInfo.color}`}>
          {pBucket === "critical" ? "!!!" : pBucket === "high" ? "!!" : pBucket === "medium" ? "!" : "·"}
        </span>

        {/* Title */}
        <span className="flex-1 text-sm font-medium text-zinc-100 truncate">
          {t.title}
        </span>

        {/* Section badge */}
        {t.section && t.section !== "general" && (
          <span className={`hidden sm:inline text-[10px] px-2 py-0.5 rounded-full font-medium ${SECTION_LABELS[t.section]?.color ?? "bg-zinc-700 text-zinc-300"}`}>
            {SECTION_LABELS[t.section]?.label ?? t.section}
          </span>
        )}

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

        {/* Checklist progress */}
        {t.body && t.body.includes("- [") && (() => {
          const total = (t.body.match(/- \[[ x]\]/gi) ?? []).length;
          const checked = (t.body.match(/- \[x\]/gi) ?? []).length;
          if (total === 0) return null;
          const pct = Math.round((checked / total) * 100);
          return (
            <div className="hidden sm:flex items-center gap-1.5 text-[10px]">
              <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${pct === 100 ? "bg-emerald-500" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
              </div>
              <span className={pct === 100 ? "text-emerald-400" : "text-zinc-400"}>{checked}/{total}</span>
            </div>
          );
        })()}

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
          {/* Body with interactive checklists */}
          {t.body && (
            <div className="text-sm text-zinc-300 space-y-1">
              {t.body.split("\n").map((line, li) => {
                const unchecked = line.match(/^(\s*)-\s*\[ \]\s*(.+)$/);
                const checked = line.match(/^(\s*)-\s*\[x\]\s*(.+)$/i);
                if (unchecked || checked) {
                  const isChecked = !!checked;
                  const text = (unchecked?.[2] ?? checked?.[2] ?? "").trim();
                  return (
                    <label key={li} className="flex items-start gap-2 cursor-pointer group hover:bg-white/5 rounded px-1 py-0.5 -mx-1">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          // Toggle this checkbox in the body text
                          const lines = t.body!.split("\n");
                          if (isChecked) {
                            lines[li] = lines[li].replace(/\[x\]/i, "[ ]");
                          } else {
                            lines[li] = lines[li].replace(/\[ \]/, "[x]");
                          }
                          // Persist via PATCH
                          onBodyUpdate(lines.join("\n"));
                        }}
                        className="mt-0.5 accent-emerald-500 w-4 h-4 shrink-0"
                      />
                      <span className={isChecked ? "line-through text-zinc-500" : "text-zinc-300"}>{text}</span>
                    </label>
                  );
                }
                // Regular text line
                if (line.trim() === "") return <div key={li} className="h-2" />;
                if (line.startsWith("### ")) return <h4 key={li} className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mt-3 mb-1">{line.slice(4)}</h4>;
                if (line.startsWith("## ")) return <h3 key={li} className="text-sm font-semibold text-zinc-200 mt-3 mb-1">{line.slice(3)}</h3>;
                return <p key={li} className="whitespace-pre-wrap">{line}</p>;
              })}
            </div>
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
