"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/Badge";

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
};

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

const PAGE_SIZE = 25;

export default function AlertsTable({ initialAlerts, pdfUrls = {} }: { initialAlerts: AlertRow[]; pdfUrls?: Record<string, string> }) {
  const [alerts] = useState<AlertRow[]>(initialAlerts);

  const [airport, setAirport] = useState<string>("all");
  const [vendor, setVendor] = useState<string>("all");
  const [q, setQ] = useState<string>("");
  const [sentFilter, setSentFilter] = useState<SentFilter>("all");
  const [page, setPage] = useState(0);
  const [shareStates, setShareStates] = useState<Record<string, ShareState>>({});
  const [previewId, setPreviewId] = useState<string | null>(null);

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
      if (v) set.add(v);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [alerts]);

  const filtered = useMemo(() => {
    const qn = q.trim().toLowerCase();

    return alerts.filter((a) => {
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
  }, [alerts, airport, vendor, sentFilter, q]);

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
        console.error("share error", data);
        setShareStates((prev) => ({ ...prev, [alertId]: "error" }));
      }
    } catch {
      setShareStates((prev) => ({ ...prev, [alertId]: "error" }));
    }
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
                const variant = amountVariant(a.fee_amount);
                return (
                  <>
                    <tr key={a.id} className="border-t hover:bg-gray-50 transition">
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
                              onClick={() => setPreviewId(isPreview ? null : a.id)}
                              className={`text-xs px-2 py-1 rounded border transition-colors ${
                                isPreview ? "border-blue-300 text-blue-700 bg-blue-50" : "border-gray-300 text-gray-600 hover:bg-gray-50"
                              }`}
                            >
                              {isPreview ? "Hide" : "PDF"}
                            </button>
                          )}
                          <Link className="text-xs text-blue-600 hover:underline" href={`/invoices/${a.document_id}`}>
                            Detail
                          </Link>
                        </div>
                      </td>
                    </tr>
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
