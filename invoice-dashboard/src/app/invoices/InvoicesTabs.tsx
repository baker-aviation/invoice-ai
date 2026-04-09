"use client";

import { useState } from "react";
import type { InvoiceListItem, AlertRow, AlertRule } from "@/lib/types";
import InvoicesTable from "./InvoicesTable";
import AlertsTable from "../alerts/AlertsTable";
import RulesTable from "./RulesTable";

type Tab = "all" | "alerts" | "rules";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All Invoices" },
  { key: "alerts", label: "Alerts" },
  { key: "rules", label: "Rules" },
];

export default function InvoicesTabs({
  invoices,
  alerts,
  pdfUrls,
  rules,
  initialTab,
}: {
  invoices: InvoiceListItem[];
  alerts: AlertRow[];
  pdfUrls: Record<string, string>;
  rules: AlertRule[];
  initialTab?: string;
}) {
  const [tab, setTab] = useState<Tab>(
    TABS.some((t) => t.key === initialTab) ? (initialTab as Tab) : "all"
  );

  const alertCount = alerts.length;
  const rulesCount = rules.length;

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-gray-200 px-6 pt-3">
        {TABS.map((t) => {
          const isActive = tab === t.key;
          const count =
            t.key === "alerts" ? alertCount :
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
    </div>
  );
}

