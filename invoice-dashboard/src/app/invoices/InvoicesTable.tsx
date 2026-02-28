"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const PAGE_SIZE = 25;

function normalize(v: any) {
  return String(v ?? "").trim();
}

function fmtTime(s: any): string {
  const t = normalize(s);
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return t.replace("T", " ").slice(0, 16);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

// ── Auto-categorization ─────────────────────────────────────────────────────
// Map doc_type from the backend classifier first; fall back to keyword heuristic.

type InvoiceCategory = "FBO/Fuel" | "Maintenance/Parts" | "Lease/Utilities" | "Other";

// Direct mapping from backend doc_type values → frontend categories
const DOC_TYPE_MAP: Record<string, InvoiceCategory> = {
  fuel_release:  "FBO/Fuel",
  fbo_fee:       "FBO/Fuel",
  maintenance:   "Maintenance/Parts",
  lease_utility: "Lease/Utilities",
};

// Keyword fallback for invoices with doc_type="other" or legacy rows
const FBO_KEYWORDS    = ["fbo", "fuel", "avfuel", "signature", "jet aviation", "million air", "atlantic", "sheltair", "wilson air", "world fuel", "avjet", "handling", "gpu", "lav", "de-ice", "catering", "landing fee", "ramp"];
const MAINT_KEYWORDS  = ["maintenance", "maint", "avionics", "parts", "repair", "overhaul", "aog", "mx ", "inspection", "mechanic", "technician", "service center", "jet support", "duncan", "standardaero", "west star", "elliott", "turbine", "propeller", "engine shop", "work order", "component", "mro"];
const LEASE_KEYWORDS  = ["lease", "rent", "hangar rent", "utilities", "management fee", "charter management", "aircraft management", "insurance", "property"];

function inferCategory(inv: any): InvoiceCategory {
  // 1. Use explicit category if the DB ever provides one
  if (inv.category) return inv.category as InvoiceCategory;
  // 2. Map from backend doc_type
  const mapped = inv.doc_type ? DOC_TYPE_MAP[inv.doc_type] : undefined;
  if (mapped) return mapped;
  // 3. Keyword fallback for doc_type="other" or missing
  const hay = [inv.vendor_name, inv.doc_type, ...(inv.line_items?.map((l: any) => l.description) ?? [])]
    .join(" ")
    .toLowerCase();
  if (MAINT_KEYWORDS.some((k) => hay.includes(k)))  return "Maintenance/Parts";
  if (LEASE_KEYWORDS.some((k) => hay.includes(k)))  return "Lease/Utilities";
  if (FBO_KEYWORDS.some((k) => hay.includes(k)))    return "FBO/Fuel";
  return "Other";
}

const CATEGORY_COLORS: Record<InvoiceCategory, string> = {
  "FBO/Fuel":          "bg-blue-100 text-blue-700",
  "Maintenance/Parts": "bg-amber-100 text-amber-700",
  "Lease/Utilities":   "bg-purple-100 text-purple-700",
  "Other":             "bg-gray-100 text-gray-600",
};

function CategoryBadge({ inv }: { inv: any }) {
  const cat = inferCategory(inv);
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${CATEGORY_COLORS[cat]}`}>
      {cat}
    </span>
  );
}

// ── Overdue detection ───────────────────────────────────────────────────────
// An invoice is overdue if invoice_date is > 30 days ago and status is not paid.

function isOverdue(inv: any): boolean {
  if (inv.status === "paid") return false;
  const dateStr = inv.invoice_date ?? inv.created_at;
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > 30;
}

const ALL_CATEGORIES: string[] = ["ALL", "FBO/Fuel", "Maintenance/Parts", "Lease/Utilities", "Other"];

export default function InvoicesTable({ initialInvoices }: { initialInvoices: any[] }) {
  const [q, setQ] = useState("");
  const [airport, setAirport] = useState("ALL");
  const [vendor, setVendor] = useState("ALL");
  const [category, setCategory] = useState("ALL");
  const [showOverdueOnly, setShowOverdueOnly] = useState(false);
  const [page, setPage] = useState(0);

  const airports = useMemo(() => {
    const set = new Set<string>();
    for (const inv of initialInvoices) {
      const a = normalize(inv.airport_code).toUpperCase();
      if (a) set.add(a);
    }
    return ["ALL", ...Array.from(set).sort()];
  }, [initialInvoices]);

  const vendors = useMemo(() => {
    const set = new Set<string>();
    for (const inv of initialInvoices) {
      const v = normalize(inv.vendor_name);
      if (v) set.add(v);
    }
    return ["ALL", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [initialInvoices]);

  const overdueCount = useMemo(() => initialInvoices.filter(isOverdue).length, [initialInvoices]);

  const filtered = useMemo(() => {
    const query = q.toLowerCase().trim();

    return initialInvoices.filter((inv) => {
      const invAirport = normalize(inv.airport_code).toUpperCase();
      const invVendor = normalize(inv.vendor_name);

      if (airport !== "ALL" && invAirport !== airport) return false;
      if (vendor !== "ALL" && invVendor !== vendor) return false;
      if (category !== "ALL" && inferCategory(inv) !== category) return false;
      if (showOverdueOnly && !isOverdue(inv)) return false;

      if (!query) return true;

      const haystack = [
        inv.document_id,
        inv.vendor_name,
        inv.airport_code,
        inv.tail_number,
        inv.invoice_number,
        inv.currency,
      ]
        .map((v) => String(v ?? "").toLowerCase())
        .join(" ");

      return haystack.includes(query);
    });
  }, [initialInvoices, q, airport, vendor, category, showOverdueOnly]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const clear = () => {
    setQ("");
    setAirport("ALL");
    setVendor("ALL");
    setCategory("ALL");
    setShowOverdueOnly(false);
    setPage(0);
  };

  return (
    <div className="p-6 space-y-4">
      {/* Overdue alert banner */}
      {overdueCount > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm text-red-700">
            <span className="font-semibold">⚠ {overdueCount} overdue invoice{overdueCount !== 1 ? "s" : ""}</span>
            <span className="text-red-500">(unpaid &gt; 30 days)</span>
          </div>
          <button
            type="button"
            onClick={() => { setShowOverdueOnly(true); setPage(0); }}
            className="text-xs font-medium text-red-700 border border-red-300 rounded-lg px-3 py-1.5 hover:bg-red-100"
          >
            Show overdue only
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
          placeholder="Search vendor, airport, tail, invoice #…"
          className="w-full max-w-xl rounded-xl border bg-white px-4 py-2 text-sm shadow-sm outline-none"
        />

        <select
          value={airport}
          onChange={(e) => { setAirport(e.target.value); setPage(0); }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm"
        >
          {airports.map((a) => (
            <option key={a} value={a}>{a === "ALL" ? "All airports" : a}</option>
          ))}
        </select>

        <select
          value={vendor}
          onChange={(e) => { setVendor(e.target.value); setPage(0); }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm max-w-[320px]"
        >
          {vendors.map((v) => (
            <option key={v} value={v}>{v === "ALL" ? "All vendors" : v}</option>
          ))}
        </select>

        <select
          value={category}
          onChange={(e) => { setCategory(e.target.value); setPage(0); }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm"
        >
          {ALL_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c === "ALL" ? "All categories" : c}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={showOverdueOnly}
            onChange={(e) => { setShowOverdueOnly(e.target.checked); setPage(0); }}
            className="rounded"
          />
          Overdue only
        </label>

        <button
          onClick={clear}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
        >
          Clear
        </button>

        <div className="text-xs text-gray-500">{filtered.length} shown</div>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100 text-left text-gray-700">
              <tr>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Airport</th>
                <th className="px-4 py-3 font-medium">Tail</th>
                <th className="px-4 py-3 font-medium">Invoice #</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>

            <tbody>
              {paged.map((inv) => {
                const overdue = isOverdue(inv);
                return (
                  <tr key={inv.id ?? inv.document_id} className={`border-t hover:bg-gray-50 ${overdue ? "bg-red-50" : ""}`}>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {fmtTime(inv.created_at)}
                      {overdue && (
                        <span className="ml-1.5 text-xs font-semibold text-red-600 bg-red-100 rounded px-1 py-0.5">
                          Overdue
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">{inv.vendor_name ?? "—"}</td>
                    <td className="px-4 py-3">
                      <CategoryBadge inv={inv} />
                    </td>
                    <td className="px-4 py-3">{inv.airport_code ?? "—"}</td>
                    <td className="px-4 py-3">{inv.tail_number ?? "—"}</td>
                    <td className="px-4 py-3">{inv.invoice_number ?? "—"}</td>
                    <td className="px-4 py-3">
                      {inv.total ?? "—"} {inv.currency ?? ""}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {inv.document_id ? (
                        <Link href={`/invoices/${inv.document_id}`} className="text-blue-600 hover:underline">
                          View →
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}

              {paged.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                    No invoices found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

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

      <div className="text-xs text-gray-500">
        Showing {filtered.length} invoice{filtered.length === 1 ? "" : "s"} across {totalPages} page{totalPages === 1 ? "" : "s"}.
      </div>
    </div>
  );
}
