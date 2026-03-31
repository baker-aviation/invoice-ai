"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import Link from "next/link";
import type { InvoiceListItem, AlertRow, AlertRule } from "@/lib/types";
import InvoicesTable from "./InvoicesTable";
import AlertsTable from "../alerts/AlertsTable";
import RulesTable from "./RulesTable";

type Tab = "all" | "alerts" | "review" | "reviewed" | "rules";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All Invoices" },
  { key: "alerts", label: "Alerts" },
  { key: "review", label: "Needs Review" },
  { key: "reviewed", label: "Reviewed" },
  { key: "rules", label: "Rules" },
];

function TabsInner({
  invoices,
  alerts,
  pdfUrls,
  rules,
}: {
  invoices: InvoiceListItem[];
  alerts: AlertRow[];
  pdfUrls: Record<string, string>;
  rules: AlertRule[];
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = (searchParams.get("tab") as Tab) || "all";

  const alertCount = alerts.length;
  const pinCount = invoices.filter((i) => i.pinned && !i.pin_resolved).length;
  const reviewedCount = invoices.filter((i) => i.pinned && i.pin_resolved).length;
  const rulesCount = rules.length;

  function setTab(t: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    if (t === "all") {
      params.delete("tab");
    } else {
      params.set("tab", t);
    }
    router.replace(`/invoices?${params.toString()}`, { scroll: false });
  }

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-gray-200 px-6 pt-3">
        {TABS.map((t) => {
          const isActive = tab === t.key;
          const count =
            t.key === "alerts" ? alertCount :
            t.key === "review" ? pinCount :
            t.key === "reviewed" ? reviewedCount :
            t.key === "rules" ? rulesCount :
            null;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? "border-gray-900 text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {t.label}
              {count != null && count > 0 && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  isActive ? "bg-gray-800 text-white" : "bg-gray-200 text-gray-600"
                }`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === "all" && <InvoicesTable initialInvoices={invoices} />}
      {tab === "alerts" && <AlertsTable initialAlerts={alerts} pdfUrls={pdfUrls} />}
      {tab === "rules" && <RulesTable initialRules={rules} />}
      {tab === "review" && <NeedsReviewTab invoices={invoices} />}
      {tab === "reviewed" && <ReviewedTab invoices={invoices} />}
    </div>
  );
}

export default function InvoicesTabs(props: {
  invoices: InvoiceListItem[];
  alerts: AlertRow[];
  pdfUrls: Record<string, string>;
  rules: AlertRule[];
}) {
  return (
    <Suspense>
      <TabsInner {...props} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Needs Review tab — active pins only, with inline "Mark Reviewed" action
// ---------------------------------------------------------------------------

function NeedsReviewTab({ invoices }: { invoices: InvoiceListItem[] }) {
  const active = invoices.filter((i) => i.pinned && !i.pin_resolved);

  return (
    <div className="p-6 space-y-4">
      {active.length === 0 ? (
        <p className="text-sm text-gray-500">No invoices pinned for review.</p>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-700">
            {active.length} active pin{active.length !== 1 ? "s" : ""}
          </h3>
          {active.map((inv) => (
            <ActivePinCard key={inv.id} inv={inv} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reviewed tab — resolved pins with review notes
// ---------------------------------------------------------------------------

function ReviewedTab({ invoices }: { invoices: InvoiceListItem[] }) {
  const resolved = invoices
    .filter((i) => i.pinned && i.pin_resolved)
    .sort((a, b) => {
      const da = a.resolved_at ? new Date(a.resolved_at).getTime() : 0;
      const db = b.resolved_at ? new Date(b.resolved_at).getTime() : 0;
      return db - da;
    });

  return (
    <div className="p-6 space-y-4">
      {resolved.length === 0 ? (
        <p className="text-sm text-gray-500">No reviewed invoices yet.</p>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-700">
            {resolved.length} reviewed invoice{resolved.length !== 1 ? "s" : ""}
          </h3>
          {resolved.map((inv) => (
            <ReviewedCard key={inv.id} inv={inv} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active pin card — shows pin info + inline "Mark Reviewed" with note input
// ---------------------------------------------------------------------------

function ActivePinCard({ inv }: { inv: InvoiceListItem }) {
  const [showResolve, setShowResolve] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [resolved, setResolved] = useState(false);

  async function handleMarkReviewed() {
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${inv.document_id}/pin`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: resolveNote }),
      });
      if (res.ok) {
        setResolved(true);
      }
    } finally {
      setLoading(false);
    }
  }

  if (resolved) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-3 opacity-60">
        <div className="flex items-center gap-2 text-sm text-green-700">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Moved to Reviewed
          {resolveNote && <span className="text-xs text-green-600">— {resolveNote}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <Link
          href={`/invoices/${inv.document_id}?from=review`}
          className="flex-1 min-w-0 hover:opacity-80"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">{inv.vendor_name ?? "Unknown vendor"}</span>
            <span className="text-xs text-gray-500">{inv.airport_code ?? ""}</span>
            <span className="text-xs text-gray-500">{inv.tail_number ?? ""}</span>
            {inv.invoice_number && (
              <span className="text-xs text-gray-400">#{inv.invoice_number}</span>
            )}
          </div>
          {inv.pin_note && (
            <p className="text-xs mt-0.5 text-red-700">{inv.pin_note}</p>
          )}
          <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
            {inv.pinned_by && <span>Pinned by {inv.pinned_by}</span>}
            {inv.pinned_at && (
              <span>{new Date(inv.pinned_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
            )}
          </div>
        </Link>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="text-sm font-medium">
            {inv.total ?? "—"} {inv.currency ?? ""}
          </div>
          {showResolve ? (
            <div className="flex flex-col gap-1.5 items-end">
              <input
                type="text"
                value={resolveNote}
                onChange={(e) => setResolveNote(e.target.value)}
                placeholder="Review notes…"
                className="border rounded px-2 py-1 text-xs w-52"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleMarkReviewed()}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowResolve(false); setResolveNote(""); }}
                  className="text-[10px] text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handleMarkReviewed}
                  disabled={loading}
                  className="rounded bg-green-600 px-2 py-0.5 text-[10px] text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {loading ? "…" : "Submit"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowResolve(true)}
              className="rounded border border-green-300 px-2 py-1 text-[10px] text-green-700 hover:bg-green-50"
            >
              Mark Reviewed
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reviewed card — shows resolved pin info + review notes
// ---------------------------------------------------------------------------

function ReviewedCard({ inv }: { inv: InvoiceListItem }) {
  return (
    <Link
      href={`/invoices/${inv.document_id}?from=reviewed`}
      className="block rounded-lg border border-gray-200 bg-white p-3 hover:bg-gray-50 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">{inv.vendor_name ?? "Unknown vendor"}</span>
            <span className="text-xs text-gray-500">{inv.airport_code ?? ""}</span>
            <span className="text-xs text-gray-500">{inv.tail_number ?? ""}</span>
            {inv.invoice_number && (
              <span className="text-xs text-gray-400">#{inv.invoice_number}</span>
            )}
          </div>
          {inv.pin_note && (
            <p className="text-xs mt-0.5 text-gray-500">
              <span className="font-medium">Issue:</span> {inv.pin_note}
            </p>
          )}
          {inv.resolve_note && (
            <p className="text-xs mt-0.5 text-green-700">
              <span className="font-medium">Review:</span> {inv.resolve_note}
            </p>
          )}
          <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
            {inv.pinned_by && <span>Pinned by {inv.pinned_by}</span>}
            {inv.pinned_at && (
              <span>{new Date(inv.pinned_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
            )}
            {inv.resolved_by && (
              <>
                <span className="text-green-600">Reviewed by {inv.resolved_by}</span>
                {inv.resolved_at && (
                  <span className="text-green-600">
                    {new Date(inv.resolved_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-medium">
            {inv.total ?? "—"} {inv.currency ?? ""}
          </div>
          <span className="text-[10px] text-green-600 font-medium">Reviewed</span>
        </div>
      </div>
    </Link>
  );
}
