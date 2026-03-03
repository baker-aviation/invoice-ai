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

// ─── Data source labels & colors ─────────────────────────────────────────────

type SourceFilter = "all" | "invoice" | "jetinsight";
type ViewMode = "compare" | "all";

const SOURCE_BADGE: Record<string, { label: string; classes: string }> = {
  invoice:    { label: "Invoice",    classes: "bg-blue-100 text-blue-800" },
  jetinsight: { label: "JetInsight", classes: "bg-emerald-100 text-emerald-800" },
};

function sourceBadge(source: string | null) {
  const s = SOURCE_BADGE[source ?? "invoice"] ?? SOURCE_BADGE.invoice;
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${s.classes}`}>
      {s.label}
    </span>
  );
}

// ─── Comparison data builder ─────────────────────────────────────────────────

type AirportComparison = {
  airport: string;
  invoicePrice: number | null;
  invoiceDate: string | null;
  invoiceVendor: string | null;
  invoiceDocId: string | null;
  invoiceCount: number;
  jetAvgPrice: number | null;
  jetMinPrice: number | null;
  jetMaxPrice: number | null;
  jetLatestDate: string | null;
  jetCount: number;
  diffPct: number | null; // positive = invoice is more expensive
};

function buildComparisons(prices: FuelPriceRow[]): AirportComparison[] {
  const byAirport = new Map<string, { invoices: FuelPriceRow[]; jet: FuelPriceRow[] }>();

  for (const r of prices) {
    const apt = r.airport_code;
    if (!apt) continue;
    if (!byAirport.has(apt)) byAirport.set(apt, { invoices: [], jet: [] });
    const bucket = byAirport.get(apt)!;
    if ((r.data_source ?? "invoice") === "jetinsight") {
      bucket.jet.push(r);
    } else {
      bucket.invoices.push(r);
    }
  }

  const comparisons: AirportComparison[] = [];

  for (const [airport, { invoices, jet }] of byAirport) {
    if (invoices.length === 0 && jet.length === 0) continue;

    // Sort invoices by date desc to get latest
    const sortedInv = [...invoices]
      .filter((r) => r.effective_price_per_gallon != null)
      .sort((a, b) => (b.invoice_date ?? "").localeCompare(a.invoice_date ?? ""));
    const latestInv = sortedInv[0] ?? null;

    // JetInsight: compute average price
    const jetPrices = jet
      .map((r) => r.effective_price_per_gallon)
      .filter((p): p is number => p != null);
    const jetAvg = jetPrices.length > 0
      ? jetPrices.reduce((a, b) => a + b, 0) / jetPrices.length
      : null;
    const jetMin = jetPrices.length > 0 ? Math.min(...jetPrices) : null;
    const jetMax = jetPrices.length > 0 ? Math.max(...jetPrices) : null;
    const jetSorted = [...jet].sort((a, b) => (b.invoice_date ?? "").localeCompare(a.invoice_date ?? ""));

    const invPrice = latestInv?.effective_price_per_gallon ?? null;
    let diffPct: number | null = null;
    if (invPrice != null && jetAvg != null && jetAvg > 0) {
      diffPct = ((invPrice - jetAvg) / jetAvg) * 100;
    }

    comparisons.push({
      airport,
      invoicePrice: invPrice,
      invoiceDate: latestInv?.invoice_date ?? null,
      invoiceVendor: latestInv?.vendor_name ?? null,
      invoiceDocId: latestInv?.document_id ?? null,
      invoiceCount: sortedInv.length,
      jetAvgPrice: jetAvg != null ? Math.round(jetAvg * 10000) / 10000 : null,
      jetMinPrice: jetMin,
      jetMaxPrice: jetMax,
      jetLatestDate: jetSorted[0]?.invoice_date ?? null,
      jetCount: jet.length,
      diffPct: diffPct != null ? Math.round(diffPct * 10) / 10 : null,
    });
  }

  // Sort: airports with both sources first, then by airport code
  comparisons.sort((a, b) => {
    const aBoth = a.invoicePrice != null && a.jetAvgPrice != null ? 0 : 1;
    const bBoth = b.invoicePrice != null && b.jetAvgPrice != null ? 0 : 1;
    if (aBoth !== bBoth) return aBoth - bBoth;
    return a.airport.localeCompare(b.airport);
  });

  return comparisons;
}

// ═════════════════════════════════════════════════════════════════════════════

export default function FuelPricesTable({
  initialPrices,
}: {
  initialPrices: FuelPriceRow[];
}) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [airportFilter, setAirportFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("compare");

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

  // Source counts
  const sourceCounts = useMemo(() => {
    const counts = { invoice: 0, jetinsight: 0 };
    for (const r of initialPrices) {
      const src = (r.data_source ?? "invoice") as keyof typeof counts;
      if (src in counts) counts[src]++;
    }
    return counts;
  }, [initialPrices]);

  // Comparison data
  const comparisons = useMemo(() => buildComparisons(initialPrices), [initialPrices]);

  // Airport+Vendor average lookup for All Records view
  // Key: "AIRPORT|VENDOR" → { avg, count, min, max }
  const fboAvgLookup = useMemo(() => {
    const buckets = new Map<string, number[]>();
    for (const r of initialPrices) {
      if (!r.airport_code || !r.vendor_name || r.effective_price_per_gallon == null) continue;
      const key = `${r.airport_code}|${r.vendor_name}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r.effective_price_per_gallon);
    }
    const lookup = new Map<string, { avg: number; count: number; min: number; max: number }>();
    for (const [key, prices] of buckets) {
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      lookup.set(key, {
        avg: Math.round(avg * 10000) / 10000,
        count: prices.length,
        min: Math.min(...prices),
        max: Math.max(...prices),
      });
    }
    return lookup;
  }, [initialPrices]);

  const filtered = useMemo(() => {
    let rows = initialPrices;
    if (sourceFilter !== "all") {
      rows = rows.filter((r) => (r.data_source ?? "invoice") === sourceFilter);
    }
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
    // Sort: dates descending, nulls last
    rows = [...rows].sort((a, b) => {
      const da = a.invoice_date ?? "";
      const db = b.invoice_date ?? "";
      if (!da && db) return 1;
      if (da && !db) return -1;
      return db.localeCompare(da);
    });
    return rows;
  }, [initialPrices, sourceFilter, airportFilter, vendorFilter, search]);

  // Filtered comparisons
  const filteredComparisons = useMemo(() => {
    let rows = comparisons;
    if (airportFilter) rows = rows.filter((r) => r.airport === airportFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        [r.airport, r.invoiceVendor]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(q)),
      );
    }
    return rows;
  }, [comparisons, airportFilter, search]);

  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const compPageRows = filteredComparisons.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const compTotalPages = Math.ceil(filteredComparisons.length / PAGE_SIZE);

  const hasBothSources = sourceCounts.invoice > 0 && sourceCounts.jetinsight > 0;
  const hasJetInsight = sourceCounts.jetinsight > 0;

  const activeTotalPages = viewMode === "compare" ? compTotalPages : totalPages;
  const activeCount = viewMode === "compare" ? filteredComparisons.length : filtered.length;

  return (
    <div className="space-y-4">
      {/* View mode tabs + source filters */}
      <div className="flex flex-wrap items-center gap-4">
        {/* View toggle */}
        {hasBothSources && (
          <div className="flex rounded-lg border bg-gray-100 p-0.5">
            {(["compare", "all"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => { setViewMode(mode); setPage(0); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  viewMode === mode
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {mode === "compare" ? "Compare by Airport" : "All Records"}
              </button>
            ))}
          </div>
        )}

        {/* Source pills (only in "all" mode) */}
        {viewMode === "all" && (hasBothSources || hasJetInsight) && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-400 mr-0.5">Source:</span>
            {(["all", "invoice", "jetinsight"] as const).map((key) => {
              const isActive = sourceFilter === key;
              const count = key === "all" ? initialPrices.length : sourceCounts[key];
              if (key !== "all" && count === 0) return null;
              const label = key === "all" ? "All" : key === "invoice" ? "Invoices" : "JetInsight";
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setSourceFilter(key); setPage(0); }}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                    isActive
                      ? key === "jetinsight"
                        ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                        : key === "invoice"
                        ? "bg-blue-100 text-blue-800 border-blue-300"
                        : "bg-slate-800 text-white border-slate-800"
                      : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
                  }`}
                >
                  {label}
                  <span className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold rounded-full ${
                    isActive ? "bg-white/30 text-inherit" : "bg-gray-100 text-gray-600"
                  }`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

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

        {viewMode === "all" && (
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
        )}

        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="rounded-md border px-3 py-1.5 text-sm bg-white w-56"
        />

        <span className="ml-auto text-xs text-gray-500">
          {activeCount} {viewMode === "compare" ? "airports" : "records"}
        </span>
      </div>

      {/* ─── Comparison View ─────────────────────────────────────────── */}
      {viewMode === "compare" && (
        <>
          <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Airport</th>
                  <th className="px-4 py-3 text-right">
                    <span className="inline-flex items-center gap-1">
                      Invoice $/gal
                      <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
                    </span>
                  </th>
                  <th className="px-4 py-3">Invoice Date</th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3 text-right">
                    <span className="inline-flex items-center gap-1">
                      JetInsight Avg $/gal
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
                    </span>
                  </th>
                  <th className="px-4 py-3 text-right">JI Range</th>
                  <th className="px-4 py-3 text-center"># Records</th>
                  <th className="px-4 py-3 text-right">Diff</th>
                  <th className="px-4 py-3 text-center">Invoice</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {compPageRows.map((row) => {
                  const overpriced = row.diffPct != null && row.diffPct > 5;
                  const underpriced = row.diffPct != null && row.diffPct < -5;
                  return (
                    <tr
                      key={row.airport}
                      className={`hover:bg-gray-50 ${
                        overpriced ? "bg-red-50/60" : underpriced ? "bg-green-50/60" : ""
                      }`}
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap font-semibold">{row.airport}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium text-blue-700">
                        {fmt$(row.invoicePrice)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 text-xs">
                        {fmtDate(row.invoiceDate)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap max-w-[160px] truncate text-xs text-gray-600" title={row.invoiceVendor || ""}>
                        {row.invoiceVendor || "\u2014"}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium text-emerald-700">
                        {fmt$(row.jetAvgPrice)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-xs text-gray-400">
                        {row.jetMinPrice != null && row.jetMaxPrice != null
                          ? `${fmt$(row.jetMinPrice)} – ${fmt$(row.jetMaxPrice)}`
                          : "\u2014"}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-gray-500">
                        <span className="text-blue-600">{row.invoiceCount}</span>
                        {" / "}
                        <span className="text-emerald-600">{row.jetCount}</span>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right">
                        {row.diffPct != null ? (
                          <Badge variant={overpriced ? "danger" : underpriced ? "success" : "default"}>
                            {row.diffPct >= 0 ? "+" : ""}{row.diffPct}%
                          </Badge>
                        ) : (
                          <span className="text-gray-300 text-xs">{"\u2014"}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-center">
                        {row.invoiceDocId ? (
                          <Link
                            href={`/invoices/${row.invoiceDocId}`}
                            className="text-blue-600 hover:text-blue-800 underline text-xs"
                          >
                            View
                          </Link>
                        ) : (
                          <span className="text-gray-300 text-xs">{"\u2014"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {compPageRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                      No airports with comparable data found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>Diff = Invoice vs JetInsight avg.</span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-300" /> &gt;5% more expensive
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-green-300" /> &gt;5% cheaper
            </span>
            <span className="inline-flex items-center gap-1">
              # = <span className="text-blue-600">invoices</span> / <span className="text-emerald-600">JetInsight</span>
            </span>
          </div>
        </>
      )}

      {/* ─── All Records View ─────────────────────────────────────────── */}
      {viewMode === "all" && (
        <div className="rounded-xl border bg-white overflow-hidden shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Airport</th>
                <th className="px-4 py-3">Vendor / FBO</th>
                <th className="px-4 py-3">Tail</th>
                <th className="px-4 py-3 text-right">Effective $/gal</th>
                <th className="px-4 py-3 text-right">
                  <span title="Average effective $/gal for this airport + vendor across all records">FBO Avg</span>
                </th>
                <th className="px-4 py-3 text-right">
                  <span title="How this row's price compares to the airport+vendor average">vs Avg</span>
                </th>
                <th className="px-4 py-3 text-right">Gallons</th>
                <th className="px-4 py-3 text-right">Fuel Total</th>
                <th className="px-4 py-3 text-center">Source</th>
                <th className="px-4 py-3 text-center">Invoice</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {pageRows.map((row) => {
                const isJetInsight = (row.data_source ?? "invoice") === "jetinsight";
                const fboKey = row.airport_code && row.vendor_name
                  ? `${row.airport_code}|${row.vendor_name}` : null;
                const fboStats = fboKey ? fboAvgLookup.get(fboKey) : null;
                const price = row.effective_price_per_gallon;
                let vsAvgPct: number | null = null;
                if (price != null && fboStats && fboStats.count > 1) {
                  vsAvgPct = ((price - fboStats.avg) / fboStats.avg) * 100;
                  vsAvgPct = Math.round(vsAvgPct * 10) / 10;
                }
                const overpriced = vsAvgPct != null && vsAvgPct > 5;
                const underpriced = vsAvgPct != null && vsAvgPct < -5;
                return (
                  <tr
                    key={row.id}
                    className={`hover:bg-gray-50 ${
                      overpriced ? "bg-red-50/60" : underpriced ? "bg-green-50/60" : isJetInsight ? "bg-emerald-50/40" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">{fmtDate(row.invoice_date)}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap font-medium">{row.airport_code || "\u2014"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap max-w-[180px] truncate" title={row.vendor_name || ""}>
                      {row.vendor_name || "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">{row.tail_number || "\u2014"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium">
                      {fmt$(price)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-gray-500">
                      {fboStats ? (
                        <span title={`${fboStats.count} records | range: ${fmt$(fboStats.min)} – ${fmt$(fboStats.max)}`}>
                          {fmt$(fboStats.avg)}
                          <span className="text-[10px] text-gray-400 ml-1">({fboStats.count})</span>
                        </span>
                      ) : (
                        <span className="text-gray-300">{"\u2014"}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right">
                      {vsAvgPct != null ? (
                        <Badge variant={overpriced ? "danger" : underpriced ? "success" : "default"}>
                          {vsAvgPct >= 0 ? "+" : ""}{vsAvgPct}%
                        </Badge>
                      ) : (
                        <span className="text-gray-300 text-xs">{"\u2014"}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">
                      {row.gallons != null ? Number(row.gallons).toFixed(0) : "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">
                      {fmt$(row.fuel_total, 2)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-center">
                      {sourceBadge(row.data_source)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-center">
                      {isJetInsight ? (
                        <span className="text-xs text-gray-400">{"\u2014"}</span>
                      ) : (
                        <span className="inline-flex gap-2 text-xs">
                          <Link
                            href={`/invoices/${row.document_id}`}
                            className="text-blue-600 hover:text-blue-800 underline"
                            title="View this invoice"
                          >
                            View
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
                      )}
                    </td>
                  </tr>
                );
              })}
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-gray-400">
                    No fuel price records found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {activeTotalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-md border px-3 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-gray-500">
            Page {page + 1} of {activeTotalPages}
          </span>
          <button
            disabled={page >= activeTotalPages - 1}
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
