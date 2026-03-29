"use client";

import Link from "next/link";
import { useMemo, useState, useCallback } from "react";
import { Badge } from "@/components/Badge";

/** Vendors to hide from the alerts table (case-insensitive substring match) */
const EXCLUDED_VENDORS = [
  "starr indemnity",
  "textron aviation",
];

type AlertRow = {
  id: string;
  created_at?: string | null;
  document_id?: string | null;
  status?: string | null;
  slack_status?: string | null;
  rule_name?: string | null;
  vendor?: string | null;
  airport_code?: string | null;
  tail?: string | null;
  fee_name?: string | null;
  fee_amount?: number | string | null;
  currency?: string | null;
  pinned?: boolean;
  pin_note?: string | null;
  pin_resolved?: boolean;
  acknowledged?: boolean;
  acknowledged_by?: string | null;
  acknowledged_at?: string | null;
};

type PinLocal = { pinned: boolean; pin_note: string | null; pin_resolved: boolean };

function norm(v: any) {
  return String(v ?? "").trim();
}

function fmtTime(s: any): string {
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

type ShareState = "idle" | "loading" | "success" | "error";
type SentFilter = "all" | "unsent" | "sent";
type AckFilter = "all" | "unack" | "ack";

const PAGE_SIZE = 25;

const BookmarkIcon = ({ filled, className }: { filled?: boolean; className?: string }) => (
  <svg className={className ?? "w-3.5 h-3.5"} fill={filled ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

export default function AlertsTable({ initialAlerts, pdfUrls = {} }: { initialAlerts: AlertRow[]; pdfUrls?: Record<string, string> }) {
  const [alerts] = useState<AlertRow[]>(initialAlerts);

  const [airport, setAirport] = useState<string>("all");
  const [vendor, setVendor] = useState<string>("all");
  const [q, setQ] = useState<string>("");
  const [sentFilter, setSentFilter] = useState<SentFilter>("all");
  const [page, setPage] = useState(0);
  const [shareStates, setShareStates] = useState<Record<string, ShareState>>({});
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [ackFilter, setAckFilter] = useState<AckFilter>("unack");

  // Acknowledge state tracked by alert id
  const [ackOverrides, setAckOverrides] = useState<Record<string, boolean>>({});
  const [ackLoading, setAckLoading] = useState<Record<string, boolean>>({});

  const isAcked = useCallback((a: AlertRow): boolean => {
    if (a.id in ackOverrides) return ackOverrides[a.id];
    return a.acknowledged ?? false;
  }, [ackOverrides]);

  // Pin state tracked by document_id (multiple alerts can share a document)
  const [pinOverrides, setPinOverrides] = useState<Record<string, PinLocal>>({});
  const [pinFormId, setPinFormId] = useState<string | null>(null);
  const [pinNote, setPinNote] = useState("");
  const [pinLoading, setPinLoading] = useState(false);

  const getPinState = useCallback((a: AlertRow): PinLocal => {
    const docId = a.document_id;
    if (docId && pinOverrides[docId]) return pinOverrides[docId];
    return {
      pinned: a.pinned ?? false,
      pin_note: a.pin_note ?? null,
      pin_resolved: a.pin_resolved ?? false,
    };
  }, [pinOverrides]);

  const airports = useMemo(() => {
    const set = new Set<string>();
    for (const a of alerts) {
      const code = norm(a.airport_code).toUpperCase();
      if (code) set.add(code);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [alerts]);

  const vendors = useMemo(() => {
    const set = new Set<string>();
    for (const a of alerts) {
      const v = norm(a.vendor);
      if (!v) continue;
      const lower = v.toLowerCase();
      if (EXCLUDED_VENDORS.some((ex) => lower.includes(ex))) continue;
      set.add(v);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [alerts]);

  const filtered = useMemo(() => {
    const qn = q.trim().toLowerCase();

    return alerts.filter((a) => {
      // Exclude non-FBO vendors (insurance, OEMs, etc.)
      const vLower = norm(a.vendor).toLowerCase();
      if (vLower && EXCLUDED_VENDORS.some((ex) => vLower.includes(ex))) return false;

      if (airport !== "all") {
        const ac = norm(a.airport_code).toUpperCase();
        if (ac !== airport) return false;
      }

      if (vendor !== "all") {
        const v = norm(a.vendor);
        if (v !== vendor) return false;
      }

      if (sentFilter !== "all") {
        const ss = String(a.slack_status ?? "").toLowerCase();
        const isSent = ss === "sent";
        if (sentFilter === "sent" && !isSent) return false;
        if (sentFilter === "unsent" && isSent) return false;
      }

      if (ackFilter !== "all") {
        const acked = isAcked(a);
        if (ackFilter === "ack" && !acked) return false;
        if (ackFilter === "unack" && acked) return false;
      }

      if (qn) {
        const hay = [
          a.document_id,
          a.rule_name,
          a.vendor,
          a.airport_code,
          a.tail,
          a.fee_name,
          a.status,
          a.slack_status,
        ]
          .map((x) => norm(x).toLowerCase())
          .join(" ");

        if (!hay.includes(qn)) return false;
      }

      return true;
    });
  }, [alerts, airport, vendor, sentFilter, ackFilter, isAcked, q]);

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
    setSentFilter("all");
    setAckFilter("unack");
    setQ("");
    setPage(0);
  };

  const shareOne = async (alertId: string) => {
    setShareStates((prev) => ({ ...prev, [alertId]: "loading" }));
    try {
      const res = await fetch(`/api/alerts/send-one/${alertId}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setShareStates((prev) => ({ ...prev, [alertId]: "success" }));
      } else {
        const msg = data?.error || data?.detail || `HTTP ${res.status}`;
        console.error("share error", msg, data);
        alert(`Send failed: ${msg}`);
        setShareStates((prev) => ({ ...prev, [alertId]: "error" }));
      }
    } catch (e: any) {
      console.error("share error", e);
      alert(`Send failed: ${e?.message || "Network error"}`);
      setShareStates((prev) => ({ ...prev, [alertId]: "error" }));
    }
  };

  // Pin an invoice from the alerts table
  const handlePin = async (docId: string) => {
    setPinLoading(true);
    try {
      const res = await fetch(`/api/invoices/${docId}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: pinNote }),
      });
      if (res.ok) {
        setPinOverrides((prev) => ({
          ...prev,
          [docId]: { pinned: true, pin_note: pinNote || null, pin_resolved: false },
        }));
        setPinFormId(null);
        setPinNote("");
      } else {
        const data = await res.json().catch(() => ({}));
        alert(`Pin failed: ${data.error ?? res.status}`);
      }
    } finally {
      setPinLoading(false);
    }
  };

  // Update note on an already-pinned invoice
  const handleUpdateNote = async (docId: string) => {
    setPinLoading(true);
    try {
      const res = await fetch(`/api/invoices/${docId}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: pinNote }),
      });
      if (res.ok) {
        setPinOverrides((prev) => ({
          ...prev,
          [docId]: { ...prev[docId], pinned: true, pin_note: pinNote || null, pin_resolved: false },
        }));
        setPinFormId(null);
      }
    } finally {
      setPinLoading(false);
    }
  };

  // Resolve a pin
  const handleResolve = async (docId: string) => {
    if (!confirm("Resolve this pin? It will move to history.")) return;
    setPinLoading(true);
    try {
      const res = await fetch(`/api/invoices/${docId}/pin`, { method: "DELETE" });
      if (res.ok) {
        setPinOverrides((prev) => ({
          ...prev,
          [docId]: { ...prev[docId], pinned: true, pin_resolved: true, pin_note: prev[docId]?.pin_note ?? null },
        }));
        setPinFormId(null);
      }
    } finally {
      setPinLoading(false);
    }
  };

  // Toggle acknowledge on an alert
  const toggleAck = async (alertId: string, currentlyAcked: boolean) => {
    setAckLoading((prev) => ({ ...prev, [alertId]: true }));
    try {
      const res = await fetch(`/api/alerts/acknowledge/${alertId}`, {
        method: currentlyAcked ? "DELETE" : "POST",
      });
      if (res.ok) {
        setAckOverrides((prev) => ({ ...prev, [alertId]: !currentlyAcked }));
      } else {
        const data = await res.json().catch(() => ({}));
        alert(`Acknowledge failed: ${data.error ?? res.status}`);
      }
    } catch (e: any) {
      alert(`Acknowledge failed: ${e?.message || "Network error"}`);
    } finally {
      setAckLoading((prev) => ({ ...prev, [alertId]: false }));
    }
  };

  const openPinForm = (alertId: string, currentNote: string | null) => {
    setPinFormId(pinFormId === alertId ? null : alertId);
    setPinNote(currentNote ?? "");
    setPreviewId(null); // collapse PDF if open
  };

  return (
    <div className="p-6 space-y-4">
      {/* Filters + Search */}
      <div className="rounded-xl border bg-white shadow-sm p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-600">Airport</label>
              <select
                className="h-10 rounded-lg border px-3 text-sm bg-white"
                value={airport}
                onChange={(e) => { setAirport(e.target.value); setPage(0); }}
              >
                <option value="all">All</option>
                {airports.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-600">Vendor</label>
              <select
                className="h-10 rounded-lg border px-3 text-sm bg-white min-w-[220px]"
                value={vendor}
                onChange={(e) => { setVendor(e.target.value); setPage(0); }}
              >
                <option value="all">All</option>
                {vendors.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-600">Status</label>
              <div className="flex h-10 items-center gap-1 rounded-lg border px-1 bg-white">
                {(["all", "unsent", "sent"] as SentFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => { setSentFilter(f); setPage(0); }}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      sentFilter === f
                        ? "bg-slate-900 text-white"
                        : "text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    {f === "all" ? "All" : f === "unsent" ? "Unsent" : "Sent"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-600">Acknowledged</label>
              <div className="flex h-10 items-center gap-1 rounded-lg border px-1 bg-white">
                {(["all", "unack", "ack"] as AckFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => { setAckFilter(f); setPage(0); }}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      ackFilter === f
                        ? "bg-slate-900 text-white"
                        : "text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    {f === "all" ? "All" : f === "unack" ? "New" : "Ack'd"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-600">Search</label>
              <input
                className="h-10 rounded-lg border px-3 text-sm min-w-[260px]"
                placeholder="Search vendor, airport, tail, fee, rule…"
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(0); }}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={clear}
              className="h-10 rounded-lg border px-3 text-sm hover:bg-gray-50"
            >
              Clear
            </button>

            <div className="text-xs text-gray-500 text-right">
              <div>
                <span className="font-medium text-gray-900">{filtered.length}</span> of{" "}
                <span className="font-medium text-gray-900">{alerts.length}</span> alerts
              </div>
              <div className="font-medium text-gray-900">
                {fmtCurrency(filteredTotal)}
              </div>
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
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Rule</th>
                <th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 font-medium">Airport</th>
                <th className="px-4 py-3 font-medium">Tail</th>
                <th className="px-4 py-3 font-medium">Fee</th>
                <th className="px-4 py-3 font-medium text-right">Amount</th>
                <th className="px-4 py-3 font-medium">Slack</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>

            <tbody>
              {paged.map((a) => {
                const shareState = shareStates[a.id] ?? "idle";
                const pdfUrl = a.document_id ? pdfUrls[a.document_id] : null;
                const isPreview = previewId === a.id;
                const isPinForm = pinFormId === a.id;
                const variant = amountVariant(a.fee_amount);
                const pin = getPinState(a);
                const isActivePinned = pin.pinned && !pin.pin_resolved;
                const acked = isAcked(a);
                const ackBusy = ackLoading[a.id] ?? false;
                return (
                  <>
                    <tr key={a.id} className={`border-t transition ${acked ? "bg-gray-50/60 opacity-60 hover:opacity-100" : "hover:bg-gray-50"}`}>
                      <td className="px-4 py-3 whitespace-nowrap">{fmtTime(a.created_at)}</td>
                      <td className="px-4 py-3 font-medium">{a.rule_name ?? "—"}</td>
                      <td className="px-4 py-3">{a.vendor ?? "—"}</td>
                      <td className="px-4 py-3">{a.airport_code ?? "—"}</td>
                      <td className="px-4 py-3">{a.tail ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-600">{a.fee_name ?? "—"}</td>
                      <td className={`px-4 py-3 text-right font-semibold tabular-nums whitespace-nowrap ${
                        variant === "danger" ? "text-red-700" : variant === "warning" ? "text-amber-700" : "text-gray-900"
                      }`}>
                        {fmtCurrency(a.fee_amount, a.currency)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Badge variant={slackBadgeVariant(a.slack_status)}>
                          {String(a.slack_status ?? "pending")}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-2">
                          {/* Acknowledge button */}
                          <button
                            type="button"
                            onClick={() => toggleAck(a.id, acked)}
                            disabled={ackBusy}
                            title={acked ? `Acknowledged${a.acknowledged_by ? ` by ${a.acknowledged_by}` : ""}` : "Acknowledge"}
                            className={`text-xs px-2 py-1 rounded border transition-colors disabled:opacity-40 ${
                              acked
                                ? "border-green-300 text-green-700 bg-green-50 hover:bg-green-100"
                                : "border-gray-300 text-gray-400 hover:text-green-600 hover:border-green-300 hover:bg-green-50"
                            }`}
                          >
                            <svg className="w-3.5 h-3.5 inline -mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={acked ? 3 : 2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          </button>
                          {/* Pin / Flag button */}
                          <button
                            type="button"
                            onClick={() => openPinForm(a.id, pin.pin_note)}
                            title={isActivePinned ? `Pinned: ${pin.pin_note || "no note"}` : "Flag for review"}
                            className={`text-xs px-2 py-1 rounded border transition-colors ${
                              isActivePinned
                                ? "border-red-300 text-red-600 bg-red-50 hover:bg-red-100"
                                : isPinForm
                                ? "border-amber-300 text-amber-700 bg-amber-50"
                                : "border-gray-300 text-gray-600 hover:bg-gray-50"
                            }`}
                          >
                            <BookmarkIcon filled={isActivePinned} className="w-3.5 h-3.5 inline -mt-0.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => shareOne(a.id)}
                            disabled={shareState === "loading"}
                            title="Send this alert to Slack"
                            className={`text-xs px-2 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                              shareState === "success"
                                ? "border-green-300 text-green-700 bg-green-50"
                                : shareState === "error"
                                ? "border-red-300 text-red-600 bg-red-50"
                                : "border-gray-300 text-gray-600 hover:bg-gray-50"
                            }`}
                          >
                            {shareState === "loading" ? "…" : shareState === "success" ? "Sent" : shareState === "error" ? "Error" : "Send"}
                          </button>
                          {pdfUrl && (
                            <button
                              type="button"
                              onClick={() => { setPreviewId(isPreview ? null : a.id); setPinFormId(null); }}
                              className={`text-xs px-2 py-1 rounded border transition-colors ${
                                isPreview ? "border-blue-300 text-blue-700 bg-blue-50" : "border-gray-300 text-gray-600 hover:bg-gray-50"
                              }`}
                            >
                              {isPreview ? "Hide" : "PDF"}
                            </button>
                          )}
                          <Link className="text-xs text-blue-600 hover:underline" href={`/invoices/${a.document_id}?from=alerts`}>
                            Detail
                          </Link>
                        </div>
                      </td>
                    </tr>

                    {/* Pin / Flag expandable row */}
                    {isPinForm && a.document_id && (
                      <tr key={`${a.id}-pin`}>
                        <td colSpan={9} className="p-0">
                          <div className={`border-t p-3 ${isActivePinned ? "bg-red-50" : "bg-amber-50"}`}>
                            {isActivePinned ? (
                              // Already pinned — show note + edit/resolve
                              <div className="flex items-center gap-3">
                                <BookmarkIcon filled className="w-4 h-4 text-red-600 shrink-0" />
                                <input
                                  type="text"
                                  value={pinNote}
                                  onChange={(e) => setPinNote(e.target.value)}
                                  placeholder="Update note…"
                                  className="border rounded px-2 py-1.5 text-sm flex-1 max-w-md"
                                  autoFocus
                                  onKeyDown={(e) => e.key === "Enter" && a.document_id && handleUpdateNote(a.document_id)}
                                />
                                <button
                                  onClick={() => a.document_id && handleUpdateNote(a.document_id)}
                                  disabled={pinLoading}
                                  className="text-xs px-3 py-1.5 rounded border border-blue-300 text-blue-700 bg-white hover:bg-blue-50 disabled:opacity-50"
                                >
                                  {pinLoading ? "…" : "Save"}
                                </button>
                                <button
                                  onClick={() => a.document_id && handleResolve(a.document_id)}
                                  disabled={pinLoading}
                                  className="text-xs px-3 py-1.5 rounded border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-50"
                                >
                                  {pinLoading ? "…" : "Resolve"}
                                </button>
                                <button
                                  onClick={() => setPinFormId(null)}
                                  className="text-xs text-gray-500 hover:text-gray-700"
                                >
                                  Close
                                </button>
                              </div>
                            ) : (
                              // Not pinned — pin form
                              <div className="flex items-center gap-3">
                                <BookmarkIcon className="w-4 h-4 text-amber-600 shrink-0" />
                                <span className="text-xs text-amber-800 font-medium shrink-0">Flag for review:</span>
                                <input
                                  type="text"
                                  value={pinNote}
                                  onChange={(e) => setPinNote(e.target.value)}
                                  placeholder="Why does this need review?"
                                  className="border rounded px-2 py-1.5 text-sm flex-1 max-w-md"
                                  autoFocus
                                  onKeyDown={(e) => e.key === "Enter" && a.document_id && handlePin(a.document_id)}
                                />
                                <button
                                  onClick={() => a.document_id && handlePin(a.document_id)}
                                  disabled={pinLoading}
                                  className="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                                >
                                  {pinLoading ? "…" : "Pin"}
                                </button>
                                <button
                                  onClick={() => setPinFormId(null)}
                                  className="text-xs text-gray-500 hover:text-gray-700"
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}

                    {isPreview && pdfUrl && (
                      <tr key={`${a.id}-preview`}>
                        <td colSpan={9} className="p-0">
                          <div className="border-t bg-gray-50 p-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs text-gray-500">Invoice PDF — {a.vendor}</span>
                              <a href={pdfUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">
                                Open in new tab
                              </a>
                            </div>
                            <iframe
                              src={pdfUrl}
                              className="w-full rounded border"
                              style={{ height: "600px" }}
                              title={`Invoice ${a.document_id}`}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-gray-500">
                    No alerts found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="h-9 rounded-lg border px-4 text-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ← Previous
          </button>
          <span className="text-xs text-gray-500">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
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
