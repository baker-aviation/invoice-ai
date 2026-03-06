"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/Badge";
import type { AdvertisedPriceRow, FuelPriceRow } from "@/lib/types";

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

/** Get the Monday of the week containing a date string */
function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}

// ─── Data source labels & colors ─────────────────────────────────────────────

type SourceFilter = "all" | "invoice" | "jetinsight";
type ViewMode = "compare" | "all" | "advertised";

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

// ─── Advertised price lookup helper ──────────────────────────────────────────

function lookupAdvertisedPrice(
  advLookup: Map<string, AdvertisedPriceRow[]>,
  vendorName: string | null,
  airportCode: string | null,
  invoiceDate: string | null,
  tailNumber: string | null,
): number | null {
  if (!vendorName || !airportCode || !invoiceDate) return null;
  const weekMonday = getWeekMonday(invoiceDate);
  const key = `${vendorName.toLowerCase()}|${airportCode}|${weekMonday}`;
  const matches = advLookup.get(key);
  if (!matches || matches.length === 0) return null;

  // Prefer tail-specific match, fall back to null (all tails)
  if (tailNumber) {
    const tailMatch = matches.find(
      (m) => m.tail_numbers && m.tail_numbers.split(",").map((t) => t.trim()).includes(tailNumber)
    );
    if (tailMatch) return tailMatch.price;
  }
  // Fall back to "all tails" (null tail_numbers), lowest volume tier ("1+")
  const allTails = matches
    .filter((m) => !m.tail_numbers)
    .sort((a, b) => a.volume_tier.localeCompare(b.volume_tier));
  return allTails[0]?.price ?? matches[0]?.price ?? null;
}

// ─── Advertised vs Actual comparison builder ─────────────────────────────────

type AdvVsActualRow = {
  key: string;
  airport: string;
  fboVendor: string;
  volumeTier: string;
  tailNumbers: string | null;
  currentWeek: string;
  currentPrice: number;
  prevWeek: string | null;
  prevPrice: number | null;
  wowChange: number | null;     // dollar change
  wowChangePct: number | null;  // percent change
  actualAvgPrice: number | null;
  invoiceCount: number;
  vsActualPct: number | null;
};

function buildAdvVsActual(
  prices: FuelPriceRow[],
  advertisedPrices: AdvertisedPriceRow[],
): AdvVsActualRow[] {
  // Group invoice data by (vendor_lower, airport) — all time for "actual" avg
  const invoiceBuckets = new Map<string, { prices: number[]; count: number }>();
  for (const r of prices) {
    if (!r.vendor_name || !r.airport_code || r.effective_price_per_gallon == null) continue;
    if ((r.data_source ?? "invoice") !== "invoice") continue;
    const key = `${r.vendor_name.toLowerCase()}|${r.airport_code}`;
    if (!invoiceBuckets.has(key)) invoiceBuckets.set(key, { prices: [], count: 0 });
    const bucket = invoiceBuckets.get(key)!;
    bucket.prices.push(r.effective_price_per_gallon);
    bucket.count++;
  }

  // Group advertised by identity key → sorted by week_start desc
  const advByIdentity = new Map<string, AdvertisedPriceRow[]>();
  for (const adv of advertisedPrices) {
    const key = `${adv.fbo_vendor}|${adv.airport_code}|${adv.volume_tier}|${adv.tail_numbers ?? ""}`;
    if (!advByIdentity.has(key)) advByIdentity.set(key, []);
    advByIdentity.get(key)!.push(adv);
  }

  const rows: AdvVsActualRow[] = [];
  for (const [, group] of advByIdentity) {
    // Sort by week desc
    group.sort((a, b) => b.week_start.localeCompare(a.week_start));
    const latest = group[0];
    const prev = group.length > 1 ? group[1] : null;

    let wowChange: number | null = null;
    let wowChangePct: number | null = null;
    if (prev) {
      wowChange = Math.round((latest.price - prev.price) * 10000) / 10000;
      if (prev.price > 0) {
        wowChangePct = Math.round(((latest.price - prev.price) / prev.price) * 1000) / 10;
      }
    }

    // Actual invoice avg for this vendor+airport
    const invKey = `${latest.fbo_vendor.toLowerCase()}|${latest.airport_code}`;
    const bucket = invoiceBuckets.get(invKey);
    const actualAvg = bucket && bucket.prices.length > 0
      ? Math.round((bucket.prices.reduce((a, b) => a + b, 0) / bucket.prices.length) * 10000) / 10000
      : null;
    const invoiceCount = bucket?.count ?? 0;

    let vsActualPct: number | null = null;
    if (actualAvg != null && latest.price > 0) {
      vsActualPct = Math.round(((actualAvg - latest.price) / latest.price) * 1000) / 10;
    }

    rows.push({
      key: `${latest.id}`,
      airport: latest.airport_code,
      fboVendor: latest.fbo_vendor,
      volumeTier: latest.volume_tier,
      tailNumbers: latest.tail_numbers,
      currentWeek: latest.week_start,
      currentPrice: latest.price,
      prevWeek: prev?.week_start ?? null,
      prevPrice: prev?.price ?? null,
      wowChange,
      wowChangePct,
      actualAvgPrice: actualAvg,
      invoiceCount,
      vsActualPct,
    });
  }

  // Sort by airport, then vendor, then tier
  rows.sort((a, b) => {
    const ac = a.airport.localeCompare(b.airport);
    if (ac !== 0) return ac;
    const vc = a.fboVendor.localeCompare(b.fboVendor);
    if (vc !== 0) return vc;
    return a.volumeTier.localeCompare(b.volumeTier);
  });

  return rows;
}

// ─── Import Modal ────────────────────────────────────────────────────────────

function ImportAdvertisedModal({ onClose }: { onClose: () => void }) {
  const [vendor, setVendor] = useState("");
  const [weekStart, setWeekStart] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; inserted?: number; skipped?: number; error?: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !vendor || !weekStart) return;
    setLoading(true);
    setResult(null);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("vendor", vendor);
    fd.append("week_start", weekStart);

    try {
      const res = await fetch("/api/fuel-prices/advertised/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok && data.ok) {
        setResult({ ok: true, inserted: data.inserted, skipped: data.skipped });
      } else {
        setResult({ ok: false, error: data.error || "Upload failed" });
      }
    } catch {
      setResult({ ok: false, error: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Import Advertised Prices</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>

        <div className="mb-4 rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-800">
          <p className="font-semibold mb-1">Expected CSV format:</p>
          <code className="block whitespace-pre text-[11px]">FBO, Volume Tier, Product, Price, Tail Numbers</code>
          <p className="mt-1 text-blue-600">FBO (airport code) may be blank on continuation rows (carries forward). Price like $6.30. &ldquo;All Tails&rdquo; = all aircraft.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">FBO Vendor Name</label>
            <input
              type="text"
              required
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="e.g. Jet Aviation"
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Week Starting</label>
            <input
              type="date"
              required
              value={weekStart}
              onChange={(e) => setWeekStart(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">CSV File</label>
            <input
              type="file"
              accept=".csv"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
          </div>

          {result && (
            <div className={`rounded-lg p-3 text-sm ${result.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
              {result.ok
                ? `Imported ${result.inserted} rows (${result.skipped} duplicates skipped)`
                : result.error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-md border hover:bg-gray-50">
              {result?.ok ? "Close" : "Cancel"}
            </button>
            {!result?.ok && (
              <button
                type="submit"
                disabled={loading || !file || !vendor || !weekStart}
                className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Uploading..." : "Import"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════

export default function FuelPricesTable({
  initialPrices,
  advertisedPrices = [],
}: {
  initialPrices: FuelPriceRow[];
  advertisedPrices?: AdvertisedPriceRow[];
}) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [airportFilter, setAirportFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const [showImportModal, setShowImportModal] = useState(false);

  // Document IDs that serve as baselines for other rows
  const baselineDocIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of initialPrices) {
      if (r.previous_document_id) ids.add(r.previous_document_id);
    }
    return ids;
  }, [initialPrices]);

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

  // Airport-level average lookup (all vendors combined)
  const airportAvgLookup = useMemo(() => {
    const buckets = new Map<string, number[]>();
    for (const r of initialPrices) {
      if (!r.airport_code || r.effective_price_per_gallon == null) continue;
      if (!buckets.has(r.airport_code)) buckets.set(r.airport_code, []);
      buckets.get(r.airport_code)!.push(r.effective_price_per_gallon);
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

  // Advertised price lookup: key = "vendor_lower|airport|week_monday" → rows
  const advLookup = useMemo(() => {
    const lookup = new Map<string, AdvertisedPriceRow[]>();
    for (const adv of advertisedPrices) {
      const key = `${adv.fbo_vendor.toLowerCase()}|${adv.airport_code}|${adv.week_start}`;
      if (!lookup.has(key)) lookup.set(key, []);
      lookup.get(key)!.push(adv);
    }
    return lookup;
  }, [advertisedPrices]);

  // Advertised vs Actual comparison rows
  const advVsActual = useMemo(
    () => buildAdvVsActual(initialPrices, advertisedPrices),
    [initialPrices, advertisedPrices],
  );

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

  // Filtered advertised vs actual
  const filteredAdvVsActual = useMemo(() => {
    let rows = advVsActual;
    if (airportFilter) rows = rows.filter((r) => r.airport === airportFilter);
    if (vendorFilter) rows = rows.filter((r) => r.fboVendor === vendorFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        [r.airport, r.fboVendor, r.tailNumbers]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(q)),
      );
    }
    return rows;
  }, [advVsActual, airportFilter, vendorFilter, search]);

  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const compPageRows = filteredComparisons.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const compTotalPages = Math.ceil(filteredComparisons.length / PAGE_SIZE);

  const advPageRows = filteredAdvVsActual.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const advTotalPages = Math.ceil(filteredAdvVsActual.length / PAGE_SIZE);

  const hasBothSources = sourceCounts.invoice > 0 && sourceCounts.jetinsight > 0;
  const hasJetInsight = sourceCounts.jetinsight > 0;
  const hasAdvertised = advertisedPrices.length > 0;

  const activeTotalPages = viewMode === "compare" ? compTotalPages : viewMode === "advertised" ? advTotalPages : totalPages;
  const activeCount = viewMode === "compare" ? filteredComparisons.length : viewMode === "advertised" ? filteredAdvVsActual.length : filtered.length;

  return (
    <div className="space-y-4">
      {/* View mode tabs + source filters */}
      <div className="flex flex-wrap items-center gap-4">
        {/* View toggle */}
        <div className="flex rounded-lg border bg-gray-100 p-0.5">
          {(
            [
              { key: "all" as const, label: "Live Feed" },
              ...(hasBothSources ? [{ key: "compare" as const, label: "Compare by Airport" }] : []),
              ...(hasAdvertised ? [{ key: "advertised" as const, label: "Advertised vs Actual" }] : []),
            ]
          ).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => { setViewMode(key); setPage(0); }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === key
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

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

        {/* Import button */}
        <button
          type="button"
          onClick={() => setShowImportModal(true)}
          className="ml-auto px-3 py-1.5 text-xs font-medium rounded-md border border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100 transition-colors"
        >
          Import Advertised Prices
        </button>
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

        {(viewMode === "all" || viewMode === "advertised") && (
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
          {activeCount} {viewMode === "compare" ? "airports" : viewMode === "advertised" ? "price rows" : "records"}
        </span>
      </div>

      {showImportModal && <ImportAdvertisedModal onClose={() => setShowImportModal(false)} />}

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

      {/* ─── All Records View (Live Feed) ───────────────────────────── */}
      {viewMode === "all" && (
        <div className="rounded-xl border bg-white overflow-hidden shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Airport</th>
                <th className="px-4 py-3">Vendor / FBO</th>
                <th className="px-4 py-3">Tail</th>
                <th className="px-4 py-3 text-right">Gallons</th>
                <th className="px-4 py-3 text-right">Fuel Total</th>
                <th className="px-4 py-3 text-right">
                  <span title="Effective $/gal (fuel + per-gallon taxes). Base price shown below in gray.">$/Gal</span>
                </th>
                {hasAdvertised && (
                  <>
                    <th className="px-4 py-3 text-right">
                      <span title="FBO advertised price for this airport + vendor + week">Adv. Price</span>
                    </th>
                    <th className="px-4 py-3 text-right">
                      <span title="Difference between effective price and advertised price">vs Adv.</span>
                    </th>
                  </>
                )}
                <th className="px-4 py-3 text-right">
                  <span title="Average effective $/gal for this airport + vendor across all records">FBO Avg</span>
                </th>
                <th className="px-4 py-3 text-right">
                  <span title="How this row's price compares to the FBO average">vs FBO</span>
                </th>
                <th className="px-4 py-3 text-right">
                  <span title="Average effective $/gal across all vendors at this airport">Airport Avg</span>
                </th>
                <th className="px-4 py-3 text-right">
                  <span title="How this row's price compares to the airport average">vs Apt</span>
                </th>
                <th className="px-4 py-3 text-center">Source</th>
                <th className="px-4 py-3 text-center">Invoice</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {pageRows.map((row) => {
                const isJetInsight = (row.data_source ?? "invoice") === "jetinsight";
                const isBaseline = !isJetInsight && baselineDocIds.has(row.document_id);
                const fboKey = row.airport_code && row.vendor_name
                  ? `${row.airport_code}|${row.vendor_name}` : null;
                const fboStats = fboKey ? fboAvgLookup.get(fboKey) : null;
                const aptStats = row.airport_code ? airportAvgLookup.get(row.airport_code) : null;
                const price = row.effective_price_per_gallon;

                // Advertised price lookup
                const advPrice = hasAdvertised
                  ? lookupAdvertisedPrice(advLookup, row.vendor_name, row.airport_code, row.invoice_date, row.tail_number)
                  : null;
                let vsAdvPct: number | null = null;
                if (price != null && advPrice != null && advPrice > 0) {
                  vsAdvPct = Math.round(((price - advPrice) / advPrice) * 1000) / 10;
                }

                let vsAvgPct: number | null = null;
                if (price != null && fboStats && fboStats.count > 1) {
                  vsAvgPct = ((price - fboStats.avg) / fboStats.avg) * 100;
                  vsAvgPct = Math.round(vsAvgPct * 10) / 10;
                }
                let vsAptPct: number | null = null;
                if (price != null && aptStats && aptStats.count > 1) {
                  vsAptPct = ((price - aptStats.avg) / aptStats.avg) * 100;
                  vsAptPct = Math.round(vsAptPct * 10) / 10;
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
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">
                      {row.gallons != null ? Number(row.gallons).toFixed(0) : "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">
                      {fmt$(row.fuel_total, 2)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium">
                      <div className="inline-flex items-center gap-1 justify-end">
                        {fmt$(price)}
                        {row.has_additive && (
                          <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-amber-100 text-amber-700" title="Includes FSII/Prist additive">FSII</span>
                        )}
                      </div>
                      {row.base_price_per_gallon != null && row.base_price_per_gallon !== price && (
                        <div className="text-[10px] text-gray-400 font-normal" title="Base fuel rate (before per-gallon taxes)">
                          base {fmt$(row.base_price_per_gallon)}
                        </div>
                      )}
                    </td>
                    {hasAdvertised && (
                      <>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-purple-700">
                          {advPrice != null ? fmt$(advPrice) : <span className="text-gray-300">{"\u2014"}</span>}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right">
                          {vsAdvPct != null ? (
                            <Badge variant={vsAdvPct > 2 ? "danger" : vsAdvPct < -2 ? "success" : "default"}>
                              {vsAdvPct >= 0 ? "+" : ""}{vsAdvPct}%
                            </Badge>
                          ) : (
                            <span className="text-gray-300 text-xs">{"\u2014"}</span>
                          )}
                        </td>
                      </>
                    )}
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
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-gray-500">
                      {aptStats ? (
                        <span title={`${aptStats.count} records | range: ${fmt$(aptStats.min)} – ${fmt$(aptStats.max)}`}>
                          {fmt$(aptStats.avg)}
                          <span className="text-[10px] text-gray-400 ml-1">({aptStats.count})</span>
                        </span>
                      ) : (
                        <span className="text-gray-300">{"\u2014"}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right">
                      {vsAptPct != null ? (
                        <Badge variant={vsAptPct > 5 ? "danger" : vsAptPct < -5 ? "success" : "default"}>
                          {vsAptPct >= 0 ? "+" : ""}{vsAptPct}%
                        </Badge>
                      ) : (
                        <span className="text-gray-300 text-xs">{"\u2014"}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-center">
                      {isBaseline ? (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-800">Baseline</span>
                      ) : sourceBadge(row.data_source)}
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
                          {row.previous_document_id && /^[a-f0-9-]{36}$/.test(row.previous_document_id) ? (
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
                  <td colSpan={hasAdvertised ? 15 : 13} className="px-4 py-8 text-center text-gray-400">
                    No fuel price records found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Advertised vs Actual View ──────────────────────────────── */}
      {viewMode === "advertised" && (
        <>
          <div className="rounded-xl border bg-white overflow-hidden shadow-sm overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Airport</th>
                  <th className="px-4 py-3">FBO Vendor</th>
                  <th className="px-4 py-3">Tier</th>
                  <th className="px-4 py-3">Tails</th>
                  <th className="px-4 py-3 text-right">
                    <span title="Current week's advertised price">Current $/gal</span>
                  </th>
                  <th className="px-4 py-3 text-right">
                    <span title="Previous week's advertised price">Prev $/gal</span>
                  </th>
                  <th className="px-4 py-3 text-right">
                    <span title="Week-over-week change in advertised price">WoW</span>
                  </th>
                  <th className="px-4 py-3 text-right">
                    <span title="Average actual invoice price for this vendor + airport">Actual Avg</span>
                  </th>
                  <th className="px-4 py-3 text-center"># Inv</th>
                  <th className="px-4 py-3 text-right">
                    <span title="Actual vs current advertised: positive = paying more">vs Adv.</span>
                  </th>
                  <th className="px-4 py-3 text-right text-[10px] normal-case">Week of</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {advPageRows.map((row) => {
                  const wowUp = row.wowChangePct != null && row.wowChangePct > 0;
                  const wowDown = row.wowChangePct != null && row.wowChangePct < 0;
                  const overActual = row.vsActualPct != null && row.vsActualPct > 2;
                  const underActual = row.vsActualPct != null && row.vsActualPct < -2;
                  return (
                    <tr
                      key={row.key}
                      className={`hover:bg-gray-50 ${
                        overActual ? "bg-red-50/60" : underActual ? "bg-green-50/60" : ""
                      }`}
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap font-semibold">{row.airport}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap max-w-[180px] truncate text-xs text-gray-600" title={row.fboVendor}>
                        {row.fboVendor}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">{row.volumeTier}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">{row.tailNumbers || "All"}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium text-purple-700">
                        {fmt$(row.currentPrice)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-gray-400">
                        {row.prevPrice != null ? fmt$(row.prevPrice) : <span className="text-gray-300">{"\u2014"}</span>}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right">
                        {row.wowChange != null ? (
                          <span className={`font-mono text-xs font-medium ${wowUp ? "text-red-600" : wowDown ? "text-green-600" : "text-gray-500"}`}>
                            {row.wowChange > 0 ? "+" : ""}{row.wowChange.toFixed(4)}
                            <span className="text-[10px] ml-0.5 opacity-70">
                              ({row.wowChangePct! >= 0 ? "+" : ""}{row.wowChangePct}%)
                            </span>
                          </span>
                        ) : (
                          <span className="text-gray-300 text-xs">{"\u2014"}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium text-blue-700">
                        {row.actualAvgPrice != null ? (
                          <span>
                            {fmt$(row.actualAvgPrice)}
                            <span className="text-[10px] text-gray-400 ml-1">({row.invoiceCount})</span>
                          </span>
                        ) : (
                          <span className="text-gray-300">{"\u2014"}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-center text-xs text-gray-500">
                        {row.invoiceCount || "\u2014"}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right">
                        {row.vsActualPct != null ? (
                          <Badge variant={overActual ? "danger" : underActual ? "success" : "default"}>
                            {row.vsActualPct >= 0 ? "+" : ""}{row.vsActualPct}%
                          </Badge>
                        ) : (
                          <span className="text-gray-300 text-xs">{"\u2014"}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right text-[10px] text-gray-400">
                        {fmtDate(row.currentWeek)}
                      </td>
                    </tr>
                  );
                })}
                {advPageRows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-4 py-8 text-center text-gray-400">
                      No advertised price data found. Use &ldquo;Import Advertised Prices&rdquo; to upload FBO price sheets.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
            <span>WoW = week-over-week change in advertised price</span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-300" /> Price went up / Paying more
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-green-300" /> Price went down / Paying less
            </span>
            <span>vs Adv. = (Actual Avg &minus; Advertised) / Advertised</span>
          </div>
        </>
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
