"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense } from "react";
import type { InvoiceListItem, AlertRow } from "@/lib/types";
import InvoicesTable from "./InvoicesTable";
import AlertsTable from "../alerts/AlertsTable";

type Tab = "all" | "alerts" | "review";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All Invoices" },
  { key: "alerts", label: "Alerts" },
  { key: "review", label: "Needs Review" },
];

function TabsInner({
  invoices,
  alerts,
  pdfUrls,
}: {
  invoices: InvoiceListItem[];
  alerts: AlertRow[];
  pdfUrls: Record<string, string>;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = (searchParams.get("tab") as Tab) || "all";

  const alertCount = alerts.length;
  const pinCount = invoices.filter((i) => i.pinned && !i.pin_resolved).length;

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
          const count = t.key === "alerts" ? alertCount : t.key === "review" ? pinCount : null;
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
      {tab === "review" && <NeedsReviewTab invoices={invoices} />}
    </div>
  );
}

export default function InvoicesTabs(props: {
  invoices: InvoiceListItem[];
  alerts: AlertRow[];
  pdfUrls: Record<string, string>;
}) {
  return (
    <Suspense>
      <TabsInner {...props} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Needs Review tab
// ---------------------------------------------------------------------------

function NeedsReviewTab({ invoices }: { invoices: InvoiceListItem[] }) {
  const active = invoices.filter((i) => i.pinned && !i.pin_resolved);
  const resolved = invoices.filter((i) => i.pinned && i.pin_resolved);
  const [showResolved, setShowResolved] = useState(false);

  return (
    <div className="p-6 space-y-4">
      {/* Active pins */}
      {active.length === 0 ? (
        <p className="text-sm text-gray-500">No invoices pinned for review.</p>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-700">{active.length} active pin{active.length !== 1 ? "s" : ""}</h3>
          {active.map((inv) => (
            <PinCard key={inv.id} inv={inv} isResolved={false} />
          ))}
        </div>
      )}

      {/* Resolved history */}
      {resolved.length > 0 && (
        <div className="pt-4 border-t border-gray-200">
          <button
            onClick={() => setShowResolved(!showResolved)}
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${showResolved ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            History ({resolved.length} resolved)
          </button>
          {showResolved && (
            <div className="space-y-2 mt-2">
              {resolved.map((inv) => (
                <PinCard key={inv.id} inv={inv} isResolved />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import Link from "next/link";

function PinCard({ inv, isResolved }: { inv: InvoiceListItem; isResolved: boolean }) {
  return (
    <Link
      href={`/invoices/${inv.document_id}`}
      className={`block rounded-lg border p-3 hover:bg-gray-50 transition-colors ${
        isResolved ? "border-gray-200 opacity-60" : "border-red-200 bg-red-50"
      }`}
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
            <p className={`text-xs mt-0.5 ${isResolved ? "text-gray-500" : "text-red-700"}`}>
              {inv.pin_note}
            </p>
          )}
          <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
            {inv.pinned_by && <span>Pinned by {inv.pinned_by}</span>}
            {inv.pinned_at && <span>{new Date(inv.pinned_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
            {isResolved && inv.resolved_by && (
              <>
                <span>Resolved by {inv.resolved_by}</span>
                {inv.resolved_at && <span>{new Date(inv.resolved_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
              </>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-medium">
            {inv.total ?? "—"} {inv.currency ?? ""}
          </div>
          {isResolved && (
            <span className="text-[10px] text-green-600 font-medium">Resolved</span>
          )}
        </div>
      </div>
    </Link>
  );
}
