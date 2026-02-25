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

type FlushState = "idle" | "loading" | "success" | "error";
type ShareState = "idle" | "loading" | "success" | "error";

const PAGE_SIZE = 25;

export default function AlertsTable({ initialAlerts }: { initialAlerts: AlertRow[] }) {
  const [airport, setAirport] = useState<string>("all");
  const [vendor, setVendor] = useState<string>("all");
  const [q, setQ] = useState<string>("");
  const [flushState, setFlushState] = useState<FlushState>("idle");
  const [flushMsg, setFlushMsg] = useState<string>("");
  const [page, setPage] = useState(0);
  const [shareStates, setShareStates] = useState<Record<string, ShareState>>({});

  const airports = useMemo(() => {
    const set = new Set<string>();
    for (const a of initialAlerts) {
      const code = norm(a.airport_code).toUpperCase();
      if (code) set.add(code);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [initialAlerts]);

  const vendors = useMemo(() => {
    const set = new Set<string>();
    for (const a of initialAlerts) {
      const v = norm(a.vendor);
      if (v) set.add(v);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [initialAlerts]);

  const filtered = useMemo(() => {
    const qn = q.trim().toLowerCase();

    return initialAlerts.filter((a) => {
      if (airport !== "all") {
        const ac = norm(a.airport_code).toUpperCase();
        if (ac !== airport) return false;
      }

      if (vendor !== "all") {
        const v = norm(a.vendor);
        if (v !== vendor) return false;
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
  }, [initialAlerts, airport, vendor, q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const clear = () => {
    setAirport("all");
    setVendor("all");
    setQ("");
    setPage(0);
  };

  const flushToSlack = async () => {
    setFlushState("loading");
    setFlushMsg("");
    try {
      const res = await fetch("/api/alerts/flush", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const sent = data.sent ?? data.flushed ?? "?";
        setFlushMsg(`Sent ${sent} alert${sent === 1 ? "" : "s"} to Slack.`);
        setFlushState("success");
      } else {
        setFlushMsg(data.error ?? `Error ${res.status}`);
        setFlushState("error");
      }
    } catch (e: any) {
      setFlushMsg(String(e?.message ?? "Network error"));
      setFlushState("error");
    }
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
      {/* Slack flush bar */}
      <div className="rounded-xl border bg-white shadow-sm px-4 py-3 flex items-center justify-between gap-4">
        <div className="text-sm text-gray-600">
          Send all pending alerts to Slack.
        </div>
        <div className="flex items-center gap-3">
          {flushMsg && (
            <span className={`text-xs font-medium ${flushState === "success" ? "text-green-700" : "text-red-600"}`}>
              {flushMsg}
            </span>
          )}
          <button
            type="button"
            onClick={flushToSlack}
            disabled={flushState === "loading"}
            className="h-9 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {flushState === "loading" ? "Sending…" : "Send to Slack"}
          </button>
        </div>
      </div>

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
                  <option key={a} value={a}>
                    {a}
                  </option>
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
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
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

            <div className="text-xs text-gray-500">
              Showing <span className="font-medium text-gray-900">{filtered.length}</span> of{" "}
              <span className="font-medium text-gray-900">{initialAlerts.length}</span>
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
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>

            <tbody>
              {paged.map((a) => {
                const shareState = shareStates[a.id] ?? "idle";
                return (
                  <tr key={a.id} className="border-t hover:bg-gray-50 transition">
                    <td className="px-4 py-3 whitespace-nowrap">{fmtTime(a.created_at)}</td>
                    <td className="px-4 py-3 font-medium">{a.rule_name ?? "—"}</td>
                    <td className="px-4 py-3">{a.vendor ?? "—"}</td>
                    <td className="px-4 py-3">{a.airport_code ?? "—"}</td>
                    <td className="px-4 py-3">{a.tail ?? "—"}</td>
                    <td className="px-4 py-3">
                      {a.fee_name ?? "—"}{" "}
                      {a.fee_amount != null ? (
                        <span className="font-medium">
                          • {a.fee_amount} {a.currency ?? ""}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 space-x-2 whitespace-nowrap">
                      <Badge>{a.status ?? "—"}</Badge>
                      <Badge variant={String(a.slack_status).toLowerCase() === "sent" ? "success" : "warning"}>
                        slack: {a.slack_status ?? "—"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => shareOne(a.id)}
                          disabled={shareState === "loading"}
                          title="Share this alert to Slack"
                          className={`text-xs px-2 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                            shareState === "success"
                              ? "border-green-300 text-green-700 bg-green-50"
                              : shareState === "error"
                              ? "border-red-300 text-red-600 bg-red-50"
                              : "border-gray-300 text-gray-600 hover:bg-gray-50"
                          }`}
                        >
                          {shareState === "loading" ? "…" : shareState === "success" ? "Sent" : shareState === "error" ? "Error" : "Share"}
                        </button>
                        <Link className="text-blue-600 hover:underline" href={`/invoices/${a.document_id}`}>
                          View →
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
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

      <div className="text-xs text-gray-500">Showing {filtered.length} alerts across {totalPages} page{totalPages === 1 ? "" : "s"}.</div>
    </div>
  );
}
