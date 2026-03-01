"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/Badge";
import type { FuelPriceRow } from "@/lib/types";

const PAGE_SIZE = 25;

function fmt$(v: number | null | undefined, decimals = 4): string {
  if (v == null) return "\u2014";
  return `$${Number(v).toFixed(decimals)}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${Number(v).toFixed(1)}%`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "\u2014";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

export default function FuelPricesTable({
  initialPrices,
}: {
  initialPrices: FuelPriceRow[];
}) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [airportFilter, setAirportFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");

  // Unique airports and vendors for filter dropdowns
  const airports = useMemo(() => {
    const set = new Set<string>();
    initialPrices.forEach((r) => {
      if (r.airport_code) set.add(r.airport_code);
    });
    return [...set].sort();
  }, [initialPrices]);

  const vendors = useMemo(() => {
    const set = new Set<string>();
    initialPrices.forEach((r) => {
      if (r.vendor_name) set.add(r.vendor_name);
    });
    return [...set].sort();
  }, [initialPrices]);

  const filtered = useMemo(() => {
    let rows = initialPrices;
    if (airportFilter) rows = rows.filter((r) => r.airport_code === airportFilter);
    if (vendorFilter) rows = rows.filter((r) => r.vendor_name === vendorFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        [r.airport_code, r.vendor_name, r.tail_number, r.document_id]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(q)),
      );
    }
    return rows;
  }, [initialPrices, airportFilter, vendorFilter, search]);

  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={airportFilter}
          onChange={(e) => { setAirportFilter(e.target.value); setPage(0); }}
          className="rounded-md border px-3 py-1.5 text-sm bg-white"
        >
          <option value="">All Airports</option>
          {airports.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        <select
          value={vendorFilter}
          onChange={(e) => { setVendorFilter(e.target.value); setPage(0); }}
          className="rounded-md border px-3 py-1.5 text-sm bg-white"
        >
          <option value="">All Vendors</option>
          {vendors.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="rounded-md border px-3 py-1.5 text-sm bg-white w-56"
        />

        <span className="ml-auto text-xs text-gray-500">{filtered.length} records</span>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Airport</th>
              <th className="px-4 py-3">Vendor</th>
              <th className="px-4 py-3">Tail</th>
              <th className="px-4 py-3 text-right">Base $/gal</th>
              <th className="px-4 py-3 text-right">Effective $/gal</th>
              <th className="px-4 py-3 text-right">Gallons</th>
              <th className="px-4 py-3 text-right">Fuel Total</th>
              <th className="px-4 py-3 text-right">Change</th>
              <th className="px-4 py-3 text-center">Invoices</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {pageRows.map((row) => {
              const hasIncrease = row.price_change_pct != null && row.price_change_pct > 0;
              return (
                <tr
                  key={row.id}
                  className={`hover:bg-gray-50 ${hasIncrease ? "bg-red-50" : ""}`}
                >
                  <td className="px-4 py-2.5 whitespace-nowrap">{fmtDate(row.invoice_date)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap font-medium">{row.airport_code || "\u2014"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap max-w-[180px] truncate" title={row.vendor_name || ""}>
                    {row.vendor_name || "\u2014"}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{row.tail_number || "\u2014"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">
                    {fmt$(row.base_price_per_gallon)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium">
                    {fmt$(row.effective_price_per_gallon)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">
                    {row.gallons != null ? Number(row.gallons).toFixed(0) : "\u2014"}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">
                    {fmt$(row.fuel_total, 2)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right">
                    {hasIncrease ? (
                      <Badge variant="danger">{fmtPct(row.price_change_pct)}</Badge>
                    ) : row.price_change_pct != null ? (
                      <span className="text-gray-400 text-xs">{fmtPct(row.price_change_pct)}</span>
                    ) : (
                      <span className="text-gray-300 text-xs">{"\u2014"}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-center">
                    <span className="inline-flex gap-2 text-xs">
                      <Link
                        href={`/invoices/${row.document_id}`}
                        className="text-blue-600 hover:text-blue-800 underline"
                        title="View this invoice"
                      >
                        New
                      </Link>
                      {row.previous_document_id ? (
                        <Link
                          href={`/invoices/${row.previous_document_id}`}
                          className="text-gray-500 hover:text-gray-700 underline"
                          title="View baseline invoice"
                        >
                          Baseline
                        </Link>
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                  No fuel price records found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-md border px-3 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-gray-500">
            Page {page + 1} of {totalPages}
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
