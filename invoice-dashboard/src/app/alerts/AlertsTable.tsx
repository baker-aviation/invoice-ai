"use client";

import Link from "next/link";
import { useMemo, useState, useCallback, useEffect } from "react";
import { Badge } from "@/components/Badge";
import type { AlertRow, AlertComment, AlertEmail, AlertAssignee, AlertResolution } from "@/lib/types";
import { ALERT_RESOLUTIONS, RESOLUTION_LABELS } from "@/lib/types";

/** Vendors to hide from the alerts table (case-insensitive substring match) */
const EXCLUDED_VENDORS = ["starr indemnity", "textron aviation"];

type WorkqueueFilter = "open" | "assigned" | "resolved" | "all";

function norm(v: unknown) {
  return String(v ?? "").trim();
}

function fmtTime(s: unknown): string {
  const t = norm(s);
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return t.replace("T", " ").slice(0, 16);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function fmtCurrency(amount: number | string | null | undefined, currency?: string | null): string {
  if (amount == null) return "—";
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: currency || "USD", minimumFractionDigits: 2 });
}

function amountVariant(amount: number | string | null | undefined): "danger" | "warning" | "default" {
  if (amount == null) return "default";
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(n)) return "default";
  if (n >= 1000) return "danger";
  if (n >= 400) return "warning";
  return "default";
}

function slackBadgeVariant(status: string | null | undefined): "success" | "warning" | "danger" | "default" {
  const s = String(status ?? "").toLowerCase();
  if (s === "sent") return "success";
  if (s === "error") return "danger";
  if (s === "pending" || s === "sending") return "warning";
  return "default";
}

const RESOLUTION_SHORT: Record<AlertResolution, string> = {
  havent_started: "Not Started",
  in_progress: "In Progress",
  pending_fbo: "Pending FBO",
  needs_jawad: "Jawad",
  refund_received: "Refund",
  credit_applied: "Credit",
  disputed: "Disputed",
  no_action: "No Action",
};

const RESOLVED_SET = new Set<AlertResolution>(["refund_received", "credit_applied", "disputed", "no_action"]);

const PAGE_SIZE = 25;

// ─── Detail Panel ────────────────────────────────────────────────

function DetailPanel({
  alert,
  pdfUrl,
  assignees,
  onAssign,
  onResolve,
}: {
  alert: AlertRow;
  pdfUrl: string | null;
  assignees: AlertAssignee[];
  onAssign: (alertId: string, name: string | null) => void;
  onResolve: (alertId: string, resolution: AlertResolution, note: string | null) => void;
}) {
  const [tab, setTab] = useState<"details" | "comments" | "emails">("details");
  const [comments, setComments] = useState<AlertComment[]>([]);
  const [emails, setEmails] = useState<AlertEmail[]>([]);
  const [commentText, setCommentText] = useState("");
  const [commentLoading, setCommentLoading] = useState(false);
  const [loadingComments, setLoadingComments] = useState(false);
  const [loadingEmails, setLoadingEmails] = useState(false);

  // Email compose state
  const [showEmailCompose, setShowEmailCompose] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailCc, setEmailCc] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [emailAttachPdf, setEmailAttachPdf] = useState(true);

  // Resolution note editing
  const [resNote, setResNote] = useState(alert.resolution_note ?? "");

  // Load comments on mount
  useEffect(() => {
    setLoadingComments(true);
    fetch(`/api/alerts/comments/${alert.id}`)
      .then((r) => r.json())
      .then((d) => setComments(d.comments ?? []))
      .catch(() => {})
      .finally(() => setLoadingComments(false));
  }, [alert.id]);

  // Load emails when tab switches
  useEffect(() => {
    if (tab !== "emails") return;
    setLoadingEmails(true);
    fetch(`/api/alerts/emails/${alert.id}`)
      .then((r) => r.json())
      .then((d) => setEmails(d.emails ?? []))
      .catch(() => {})
      .finally(() => setLoadingEmails(false));
  }, [tab, alert.id]);

  const addComment = async () => {
    if (!commentText.trim()) return;
    setCommentLoading(true);
    try {
      const res = await fetch(`/api/alerts/comments/${alert.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: commentText }),
      });
      const data = await res.json();
      if (data.ok && data.comment) {
        setComments((prev) => [...prev, data.comment]);
        setCommentText("");
      }
    } finally {
      setCommentLoading(false);
    }
  };

  const sendEmail = async () => {
    if (!emailTo.trim() || !emailBody.trim()) return;
    setEmailSending(true);
    try {
      const to = emailTo.split(",").map((s) => s.trim()).filter(Boolean);
      const cc = emailCc ? emailCc.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const res = await fetch(`/api/alerts/emails/${alert.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, cc, body: emailBody, include_pdf: emailAttachPdf }),
      });
      const data = await res.json();
      if (data.ok) {
        setShowEmailCompose(false);
        setEmailTo("");
        setEmailCc("");
        setEmailBody("");
        // Refresh email list
        const listRes = await fetch(`/api/alerts/emails/${alert.id}`);
        const listData = await listRes.json();
        setEmails(listData.emails ?? []);
      } else {
        window.alert(`Send failed: ${data.error || "Unknown error"}`);
      }
    } finally {
      setEmailSending(false);
    }
  };

  const tabs = [
    { key: "details" as const, label: "Resolution" },
    { key: "comments" as const, label: `Comments${comments.length ? ` (${comments.length})` : ""}` },
    { key: "emails" as const, label: `Emails${emails.length || alert.email_count ? ` (${emails.length || alert.email_count})` : ""}` },
  ];

  return (
    <div className="border-t bg-slate-50 p-4">
      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t.key
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
        {pdfUrl && (
          <a
            href={pdfUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto px-3 py-2 text-sm text-blue-600 hover:underline"
          >
            View PDF →
          </a>
        )}
      </div>

      {/* ── Resolution Tab ── */}
      {tab === "details" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Assigned To</label>
            <select
              value={alert.assigned_to ?? ""}
              onChange={(e) => onAssign(alert.id, e.target.value || null)}
              className="h-9 rounded-lg border px-3 text-sm bg-white w-full max-w-xs"
            >
              <option value="">Unassigned</option>
              {assignees.map((a) => (
                <option key={a.id} value={a.name}>{a.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Status</label>
            <select
              value={alert.resolution ?? "havent_started"}
              onChange={(e) => onResolve(alert.id, e.target.value as AlertResolution, resNote || null)}
              className="h-9 rounded-lg border px-3 text-sm bg-white w-full max-w-xs"
            >
              {ALERT_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>{RESOLUTION_LABELS[r]}</option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="text-xs font-medium text-gray-600 block mb-1">Resolution Notes</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={resNote}
                onChange={(e) => setResNote(e.target.value)}
                placeholder="What was the outcome? e.g. $150 refund issued by Atlantic"
                className="flex-1 h-9 rounded-lg border px-3 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") onResolve(alert.id, alert.resolution ?? "havent_started", resNote || null);
                }}
              />
              <button
                onClick={() => onResolve(alert.id, alert.resolution ?? "havent_started", resNote || null)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 text-white text-sm hover:bg-slate-700"
              >
                Save
              </button>
            </div>
          </div>

          {alert.resolved_by && (
            <div className="md:col-span-2 text-xs text-gray-500">
              Resolved by {alert.resolved_by} on {fmtTime(alert.resolved_at)}
            </div>
          )}
        </div>
      )}

      {/* ── Comments Tab ── */}
      {tab === "comments" && (
        <div className="space-y-3">
          {loadingComments ? (
            <div className="text-sm text-gray-400">Loading comments…</div>
          ) : comments.length === 0 ? (
            <div className="text-sm text-gray-400">No comments yet. Start the conversation.</div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {comments.map((c) => (
                <div key={c.id} className="bg-white rounded-lg border p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-gray-700">{c.author}</span>
                    <span className="text-xs text-gray-400">{fmtTime(c.created_at)}</span>
                  </div>
                  <div className="text-sm text-gray-800 whitespace-pre-wrap">{c.body}</div>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Add a comment…"
              className="flex-1 h-9 rounded-lg border px-3 text-sm"
              onKeyDown={(e) => e.key === "Enter" && addComment()}
              disabled={commentLoading}
            />
            <button
              onClick={addComment}
              disabled={commentLoading || !commentText.trim()}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-white text-sm hover:bg-slate-700 disabled:opacity-40"
            >
              {commentLoading ? "…" : "Send"}
            </button>
          </div>
        </div>
      )}

      {/* ── Emails Tab ── */}
      {tab === "emails" && (
        <div className="space-y-3">
          {loadingEmails ? (
            <div className="text-sm text-gray-400">Loading email thread…</div>
          ) : emails.length === 0 ? (
            <div className="text-sm text-gray-400">No emails yet. Send the first one to the FBO.</div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {emails.map((e) => (
                <div
                  key={e.id}
                  className={`rounded-lg border p-3 ${
                    e.direction === "outbound" ? "bg-blue-50 border-blue-200" : "bg-white"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={e.direction === "outbound" ? "default" : "success"}>
                      {e.direction === "outbound" ? "Sent" : "Received"}
                    </Badge>
                    <span className="text-xs text-gray-600">{e.from_address}</span>
                    <span className="text-xs text-gray-400 ml-auto">{fmtTime(e.received_at || e.created_at)}</span>
                  </div>
                  <div className="text-xs text-gray-500 mb-1">
                    To: {e.to_addresses.join(", ")}
                    {e.cc_addresses.length > 0 && <> · CC: {e.cc_addresses.join(", ")}</>}
                  </div>
                  <div className="text-xs font-medium text-gray-700 mb-1">{e.subject}</div>
                  <div className="text-sm text-gray-800 whitespace-pre-wrap">
                    {e.body_text || "(HTML email — view in email client)"}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!showEmailCompose ? (
            <button
              onClick={() => setShowEmailCompose(true)}
              className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700"
            >
              Compose Email to FBO
            </button>
          ) : (
            <div className="bg-white rounded-lg border p-3 space-y-2">
              <div className="text-xs font-medium text-gray-600">From: operations@baker-aviation.com</div>
              <input
                type="text"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="To: fbo@example.com (comma-separated)"
                className="w-full h-9 rounded-lg border px-3 text-sm"
              />
              <input
                type="text"
                value={emailCc}
                onChange={(e) => setEmailCc(e.target.value)}
                placeholder="CC: (optional, comma-separated)"
                className="w-full h-9 rounded-lg border px-3 text-sm"
              />
              <textarea
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                placeholder="Email body…"
                className="w-full rounded-lg border px-3 py-2 text-sm min-h-[100px]"
              />
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-3">
                  <button
                    onClick={sendEmail}
                    disabled={emailSending || !emailTo.trim() || !emailBody.trim()}
                    className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40"
                  >
                    {emailSending ? "Sending…" : "Send Email"}
                  </button>
                  <button
                    onClick={() => setShowEmailCompose(false)}
                    className="px-3 py-1.5 rounded-lg border text-sm text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer ml-auto">
                  <input
                    type="checkbox"
                    checked={emailAttachPdf}
                    onChange={(e) => setEmailAttachPdf(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  Attach invoice PDF
                </label>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Table ──────────────────────────────────────────────────

export default function AlertsTable({
  initialAlerts,
  pdfUrls = {},
}: {
  initialAlerts: AlertRow[];
  pdfUrls?: Record<string, string>;
}) {
  const [alerts, setAlerts] = useState<AlertRow[]>(initialAlerts);
  const [assignees, setAssignees] = useState<AlertAssignee[]>([]);

  const [airport, setAirport] = useState<string>("all");
  const [vendor, setVendor] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [q, setQ] = useState<string>("");
  const [wqFilter, setWqFilter] = useState<WorkqueueFilter>("open");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [shareStates, setShareStates] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});

  // Load assignees on mount
  useEffect(() => {
    fetch("/api/alerts/assignees")
      .then((r) => r.json())
      .then((d) => setAssignees(d.assignees ?? []))
      .catch(() => {});
  }, []);

  const airports = useMemo(() => {
    const set = new Set<string>();
    for (const a of alerts) {
      const code = norm(a.airport_code).toUpperCase();
      if (code) set.add(code);
    }
    return Array.from(set).sort();
  }, [alerts]);

  const vendors = useMemo(() => {
    const set = new Set<string>();
    for (const a of alerts) {
      const v = norm(a.vendor);
      if (!v) continue;
      if (EXCLUDED_VENDORS.some((ex) => v.toLowerCase().includes(ex))) continue;
      set.add(v);
    }
    return Array.from(set).sort();
  }, [alerts]);

  const uniqueAssignees = useMemo(() => {
    const set = new Set<string>();
    for (const a of alerts) {
      if (a.assigned_to) set.add(a.assigned_to);
    }
    return Array.from(set).sort();
  }, [alerts]);

  const filtered = useMemo(() => {
    const qn = q.trim().toLowerCase();
    return alerts.filter((a) => {
      const vLower = norm(a.vendor).toLowerCase();
      if (vLower && EXCLUDED_VENDORS.some((ex) => vLower.includes(ex))) return false;

      if (airport !== "all" && norm(a.airport_code).toUpperCase() !== airport) return false;
      if (vendor !== "all" && norm(a.vendor) !== vendor) return false;
      if (assigneeFilter !== "all" && (a.assigned_to ?? "") !== assigneeFilter) return false;

      // Workqueue filter
      const res = a.resolution ?? "havent_started";
      const isResolved = RESOLVED_SET.has(res as AlertResolution);
      if (wqFilter === "open" && (isResolved || a.assigned_to)) return false;
      if (wqFilter === "assigned" && (!a.assigned_to || isResolved)) return false;
      if (wqFilter === "resolved" && !isResolved) return false;

      if (qn) {
        const hay = [a.document_id, a.rule_name, a.vendor, a.airport_code, a.tail, a.fee_name, a.status, a.slack_status, a.assigned_to, a.resolution_note]
          .map((x) => norm(x).toLowerCase())
          .join(" ");
        if (!hay.includes(qn)) return false;
      }

      return true;
    });
  }, [alerts, airport, vendor, assigneeFilter, wqFilter, q]);

  const filteredTotal = useMemo(() => {
    return filtered.reduce((sum, a) => {
      const n = typeof a.fee_amount === "string" ? parseFloat(a.fee_amount) : (a.fee_amount ?? 0);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const clear = () => {
    setAirport("all");
    setVendor("all");
    setAssigneeFilter("all");
    setWqFilter("open");
    setQ("");
    setPage(0);
  };

  // ── Actions ──

  const handleAssign = useCallback(async (alertId: string, name: string | null) => {
    const res = await fetch(`/api/alerts/assign/${alertId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigned_to: name }),
    });
    if (res.ok) {
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId
            ? { ...a, assigned_to: name, assigned_at: name ? new Date().toISOString() : null }
            : a,
        ),
      );
    }
  }, []);

  const handleResolve = useCallback(async (alertId: string, resolution: AlertResolution, note: string | null) => {
    const res = await fetch(`/api/alerts/resolve/${alertId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution, resolution_note: note }),
    });
    if (res.ok) {
      const isResolved = RESOLVED_SET.has(resolution);
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId
            ? {
                ...a,
                resolution,
                resolution_note: note,
                resolved_at: isResolved ? new Date().toISOString() : null,
                resolved_by: isResolved ? "you" : null,
              }
            : a,
        ),
      );
    }
  }, []);

  const shareOne = async (alertId: string) => {
    setShareStates((prev) => ({ ...prev, [alertId]: "loading" }));
    try {
      const res = await fetch(`/api/alerts/send-one/${alertId}`, { method: "POST" });
      if (res.ok) {
        setShareStates((prev) => ({ ...prev, [alertId]: "success" }));
      } else {
        const data = await res.json().catch(() => ({}));
        window.alert(`Send failed: ${data.error || `HTTP ${res.status}`}`);
        setShareStates((prev) => ({ ...prev, [alertId]: "error" }));
      }
    } catch {
      setShareStates((prev) => ({ ...prev, [alertId]: "error" }));
    }
  };

  // ── Workqueue filter counts ──
  const counts = useMemo(() => {
    let open = 0, assigned = 0, resolved = 0;
    for (const a of alerts) {
      const vLower = norm(a.vendor).toLowerCase();
      if (vLower && EXCLUDED_VENDORS.some((ex) => vLower.includes(ex))) continue;
      const res = a.resolution ?? "havent_started";
      const isRes = RESOLVED_SET.has(res as AlertResolution);
      if (isRes) resolved++;
      else if (a.assigned_to) assigned++;
      else open++;
    }
    return { open, assigned, resolved, all: open + assigned + resolved };
  }, [alerts]);

  return (
    <div className="p-6 space-y-4">
      {/* Workqueue tabs */}
      <div className="flex gap-1 bg-white rounded-xl border shadow-sm p-1">
        {([
          ["open", `Open (${counts.open})`],
          ["assigned", `Assigned (${counts.assigned})`],
          ["resolved", `Resolved (${counts.resolved})`],
          ["all", `All (${counts.all})`],
        ] as [WorkqueueFilter, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => { setWqFilter(key); setPage(0); }}
            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              wqFilter === key
                ? "bg-slate-900 text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-white shadow-sm p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-600">Airport</label>
              <select className="h-9 rounded-lg border px-3 text-sm bg-white" value={airport} onChange={(e) => { setAirport(e.target.value); setPage(0); }}>
                <option value="all">All</option>
                {airports.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-600">Vendor</label>
              <select className="h-9 rounded-lg border px-3 text-sm bg-white min-w-[200px]" value={vendor} onChange={(e) => { setVendor(e.target.value); setPage(0); }}>
                <option value="all">All</option>
                {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-600">Assignee</label>
              <select className="h-9 rounded-lg border px-3 text-sm bg-white min-w-[140px]" value={assigneeFilter} onChange={(e) => { setAssigneeFilter(e.target.value); setPage(0); }}>
                <option value="all">All</option>
                {uniqueAssignees.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-600">Search</label>
              <input
                className="h-9 rounded-lg border px-3 text-sm min-w-[240px]"
                placeholder="Search vendor, airport, tail, fee, notes…"
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(0); }}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={clear} className="h-9 rounded-lg border px-3 text-sm hover:bg-gray-50">Clear</button>
            <div className="text-xs text-gray-500 text-right">
              <div><span className="font-medium text-gray-900">{filtered.length}</span> alerts</div>
              <div className="font-medium text-gray-900">{fmtCurrency(filteredTotal)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100 text-left text-gray-700">
              <tr>
                <th className="px-3 py-3 font-medium">Time</th>
                <th className="px-3 py-3 font-medium">Vendor</th>
                <th className="px-3 py-3 font-medium">Airport</th>
                <th className="px-3 py-3 font-medium">Tail</th>
                <th className="px-3 py-3 font-medium">Fee</th>
                <th className="px-3 py-3 font-medium text-right">Amount</th>
                <th className="px-3 py-3 font-medium">Assignee</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium text-center">Activity</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            {paged.map((a) => {
                const variant = amountVariant(a.fee_amount);
                const isExpanded = expandedId === a.id;
                const pdfUrl = a.document_id ? pdfUrls[a.document_id] : null;
                const res = (a.resolution ?? "havent_started") as AlertResolution;
                const shareState = shareStates[a.id] ?? "idle";
                return (
                  <tbody key={a.id}>
                    <tr
                      className={`border-t cursor-pointer transition ${
                        isExpanded ? "bg-blue-50" : RESOLVED_SET.has(res) ? "bg-gray-50/60 opacity-70 hover:opacity-100" : "hover:bg-gray-50"
                      }`}
                      onClick={() => setExpandedId(isExpanded ? null : a.id)}
                    >
                      <td className="px-3 py-2.5 whitespace-nowrap text-xs text-gray-500">{fmtTime(a.created_at)}</td>
                      <td className="px-3 py-2.5 font-medium max-w-[200px] truncate">{a.vendor ?? "—"}</td>
                      <td className="px-3 py-2.5">{a.airport_code ?? "—"}</td>
                      <td className="px-3 py-2.5">{a.tail ?? "—"}</td>
                      <td className="px-3 py-2.5 text-gray-600 max-w-[180px] truncate">{a.fee_name ?? "—"}</td>
                      <td className={`px-3 py-2.5 text-right font-semibold tabular-nums whitespace-nowrap ${
                        variant === "danger" ? "text-red-700" : variant === "warning" ? "text-amber-700" : "text-gray-900"
                      }`}>
                        {fmtCurrency(a.fee_amount, a.currency)}
                      </td>
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={a.assigned_to ?? ""}
                          onChange={(e) => handleAssign(a.id, e.target.value || null)}
                          className={`h-7 rounded border px-1.5 text-xs bg-white ${
                            a.assigned_to ? "border-blue-300 text-blue-700" : "border-gray-200 text-gray-400"
                          }`}
                        >
                          <option value="">—</option>
                          {assignees.map((as) => <option key={as.id} value={as.name}>{as.name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={res}
                          onChange={(e) => handleResolve(a.id, e.target.value as AlertResolution, a.resolution_note ?? null)}
                          className={`h-7 rounded border px-1.5 text-xs bg-white ${
                            RESOLVED_SET.has(res) ? "border-green-300 text-green-700"
                            : res === "needs_jawad" ? "border-red-300 text-red-700"
                            : res === "havent_started" ? "border-gray-200 text-gray-400"
                            : "border-amber-300 text-amber-700"
                          }`}
                        >
                          {ALERT_RESOLUTIONS.map((r) => (
                            <option key={r} value={r}>{RESOLUTION_SHORT[r]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2.5 text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
                          {(a.comment_count ?? 0) > 0 && (
                            <span title={`${a.comment_count} comments`}>
                              <svg className="w-3.5 h-3.5 inline -mt-0.5 mr-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                              </svg>
                              {a.comment_count}
                            </span>
                          )}
                          {(a.email_count ?? 0) > 0 && (
                            <span title={`${a.email_count} emails`}>
                              <svg className="w-3.5 h-3.5 inline -mt-0.5 mr-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                              </svg>
                              {a.email_count}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <Badge variant={slackBadgeVariant(a.slack_status)}>
                            {String(a.slack_status ?? "pending")}
                          </Badge>
                          {shareState !== "success" && (
                            <button
                              onClick={() => shareOne(a.id)}
                              disabled={shareState === "loading"}
                              title="Send to Slack"
                              className="text-xs px-1.5 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40"
                            >
                              {shareState === "loading" ? "…" : "→ Slack"}
                            </button>
                          )}
                          <Link
                            className="text-xs text-blue-600 hover:underline"
                            href={`/invoices/${a.document_id}?from=alerts`}
                          >
                            Invoice
                          </Link>
                        </div>
                      </td>
                    </tr>

                    {/* Expanded detail panel */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={10} className="p-0">
                          <DetailPanel
                            alert={a}
                            pdfUrl={pdfUrl}
                            assignees={assignees}
                            onAssign={handleAssign}
                            onResolve={handleResolve}
                          />
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}

            {filtered.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-gray-500">
                    No alerts found.
                  </td>
                </tr>
              </tbody>
            )}
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="h-9 rounded-lg border px-4 text-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ← Previous
          </button>
          <span className="text-xs text-gray-500">Page {page + 1} of {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="h-9 rounded-lg border px-4 text-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
