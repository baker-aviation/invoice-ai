"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/Badge";
import type { AdvertisedPriceRow, FuelPriceRow } from "@/lib/types";
import type { TripSalesperson } from "@/lib/invoiceApi";

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

function fmtTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
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
type ViewMode = "compare" | "all" | "advertised" | "stats";

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
  // Try both ICAO (KTEB) and IATA (TEB) variants
  const codes = airportCode.length === 4 && airportCode.startsWith("K")
    ? [airportCode, airportCode.slice(1)]
    : airportCode.length === 3
    ? [airportCode, `K${airportCode}`]
    : [airportCode];
  let matches: AdvertisedPriceRow[] | undefined;
  for (const code of codes) {
    matches = advLookup.get(`${vendorName.toLowerCase()}|${code}|${weekMonday}`);
    if (matches && matches.length > 0) break;
  }
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

/** Find the cheapest advertised rate across ALL vendors for a given airport + week */
function lookupBestRate(
  advByAirportWeek: Map<string, AdvertisedPriceRow[]>,
  advByAirport: Map<string, AdvertisedPriceRow[]>,
  airportCode: string | null,
  invoiceDate: string | null,
  gallons: number | null,
): { price: number; vendor: string } | null {
  if (!airportCode || !invoiceDate) return null;
  const weekMonday = getWeekMonday(invoiceDate);
  const codes = airportCode.length === 4 && airportCode.startsWith("K")
    ? [airportCode, airportCode.slice(1)]
    : airportCode.length === 3
    ? [airportCode, `K${airportCode}`]
    : [airportCode];

  // Try exact week match first
  let allMatches: AdvertisedPriceRow[] = [];
  for (const code of codes) {
    const m = advByAirportWeek.get(`${code}|${weekMonday}`);
    if (m) allMatches = allMatches.concat(m);
  }

  // Fallback: use most recent week's prices for this airport (not newer than invoice date)
  if (allMatches.length === 0) {
    for (const code of codes) {
      const allForAirport = advByAirport.get(code);
      if (!allForAirport) continue;
      // Find the most recent week that's on or before the invoice date
      const recent = allForAirport.filter((a) => a.week_start <= weekMonday);
      if (recent.length > 0) {
        // recent is already sorted newest first — grab the latest week
        const latestWeek = recent[0].week_start;
        allMatches = allMatches.concat(recent.filter((a) => a.week_start === latestWeek));
      }
    }
  }

  if (allMatches.length === 0) return null;

  // Filter to applicable volume tiers based on gallons purchased
  let candidates = allMatches.filter((m) => !m.tail_numbers);
  if (gallons && gallons > 0) {
    const applicable = candidates.filter((m) => tierMatchesVolume(m.volume_tier, gallons));
    if (applicable.length > 0) candidates = applicable;
  }
  if (candidates.length === 0) candidates = allMatches;

  // Find the cheapest
  let best: AdvertisedPriceRow | null = null;
  for (const c of candidates) {
    if (!best || c.price < best.price) best = c;
  }
  return best ? { price: best.price, vendor: best.fbo_vendor } : null;
}

/** Check if a gallon amount falls within a volume tier like "1-300" or "1201+" */
function tierMatchesVolume(tier: string, gallons: number): boolean {
  const plusMatch = tier.match(/^(\d+)\+$/);
  if (plusMatch) return gallons >= parseInt(plusMatch[1], 10);
  const rangeMatch = tier.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) return gallons >= parseInt(rangeMatch[1], 10) && gallons <= parseInt(rangeMatch[2], 10);
  return true;
}

// ─── Advertised vs Actual comparison builder ─────────────────────────────────

/** Extract FBO name from product field: "Jet (Atlantic Aviation - HOU)" → "Atlantic Aviation - HOU" */
function extractFboName(product: string): string | null {
  const m = product.match(/\(([^)]+)\)/);
  return m ? m[1] : null;
}

/** Normalize FBO name for grouping — fix typos, collapse whitespace */
function normFboKey(fbo: string): string {
  return fbo
    .toLowerCase()
    .replace(/avaition/g, "aviation")  // common typo in Avfuel data
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Canonical FBO brand mapping — collapses vendor naming variations
// ---------------------------------------------------------------------------

const FBO_BRAND_PATTERNS: [RegExp, string][] = [
  [/\bsignature\b|flight\s*support/i, "Signature"],
  [/\batlantic\b/i, "Atlantic Aviation"],
  [/\bjet\s*aviation\b/i, "Jet Aviation"],
  [/\bsheltair\b/i, "Sheltair"],
  [/\bclay\s*lacy\b/i, "Clay Lacy"],
  [/\bmill(?:ion)?\s*air\b/i, "Million Air"],
  [/\bhenriksen\b/i, "Henriksen"],
  [/\bwilson\s*air\b/i, "Wilson Air"],
  [/\bfountainhead\b/i, "Fountainhead"],
  [/\bross\s*aviation\b/i, "Ross Aviation"],
  [/\bbanyan\b/i, "Banyan"],
  [/\bcutter\b/i, "Cutter Aviation"],
  [/\bepic\b/i, "Epic Aviation"],
  [/\bglobal\s*select\b/i, "Global Select"],
  [/\bkaiser\b/i, "Kaiser Air"],
  [/\bpentastar\b/i, "Pentastar"],
  [/\bpriester\b/i, "Priester"],
  [/\bxo\s*jet\b|\bxojet\b/i, "XOJet"],
  [/\btac\s*air\b/i, "TAC Air"],
];

/** Location qualifiers (East, West, South, Terminal N, etc.) */
const LOCATION_RE = /[\s\-–·]*(?:east(?:\/west)?|west|south|north|terminal\s*\d+)/i;

/** Airport code suffixes vendors stick on FBO names (e.g. "Atlantic TEB", "Jet Aviation KTEB") */
const AIRPORT_SUFFIX_RE = /[\s\-–·]*(?:K?[A-Z]{3})$/;

type CanonicalFbo = { brand: string; location: string | null };

function canonicalFbo(rawFbo: string, airportCode?: string): CanonicalFbo {
  const cleaned = rawFbo.trim();

  // 1. Match known brand
  for (const [pattern, brand] of FBO_BRAND_PATTERNS) {
    if (pattern.test(cleaned)) {
      // Extract location qualifier before stripping
      const locMatch = cleaned.match(LOCATION_RE);
      const location = locMatch
        ? locMatch[0].replace(/^[\s\-–·]+/, "").replace(/\b\w/g, (c) => c.toUpperCase())
        : null;
      return { brand, location };
    }
  }

  // 2. Unknown brand — strip airport code suffix and return as-is
  let brand = cleaned;
  if (airportCode) {
    const iata = airportCode.replace(/^K/, "");
    brand = brand.replace(new RegExp(`[\\s\\-–·]*K?${iata}$`, "i"), "");
  }
  brand = brand.replace(AIRPORT_SUFFIX_RE, "").trim();
  const locMatch = brand.match(LOCATION_RE);
  const location = locMatch
    ? locMatch[0].replace(/^[\s\-–·]+/, "").replace(/\b\w/g, (c) => c.toUpperCase())
    : null;
  if (location) brand = brand.replace(LOCATION_RE, "").trim();
  return { brand: brand || cleaned, location };
}

/** Create a grouping key from canonical FBO + airport */
function canonicalFboKey(rawFbo: string, airportCode: string): string {
  const { brand, location } = canonicalFbo(rawFbo, airportCode);
  const key = normFboKey(brand) + (location ? `|${location.toLowerCase()}` : "");
  return `${normAirport(airportCode)}|${key}`;
}

type VendorQuote = {
  fboVendor: string;
  volumeTier: string;
  tailNumbers: string | null;
  currentWeek: string;
  currentPrice: number;
  prevWeek: string | null;
  prevPrice: number | null;
  wowChange: number | null;
  wowChangePct: number | null;
};

type AdvVsActualRow = {
  key: string;
  airport: string;
  fboVendor: string;
  fboName: string | null;  // specific FBO at airport (e.g. "Atlantic Aviation - HOU")
  canonicalBrand: string | null;   // e.g. "Signature"
  canonicalLocation: string | null; // e.g. "East"
  vendorQuotes: VendorQuote[];     // per-vendor pricing for this FBO
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
  recent7dAvg: number | null;   // avg price paid last 7 days at this airport
  recent7dCount: number;         // number of entries in last 7 days
};

/** Strip leading K from US ICAO codes: KTEB→TEB, KHOU→HOU */
function normAirport(code: string): string {
  const up = code.toUpperCase();
  return up.length === 4 && up.startsWith("K") ? up.slice(1) : up;
}

/** Normalize airport codes: KTEB↔TEB, KHOU↔HOU etc. */
function airportVariants(code: string): string[] {
  const up = code.toUpperCase();
  if (up.length === 4 && up.startsWith("K")) return [up, up.slice(1)];
  if (up.length === 3) return [up, `K${up}`];
  return [up];
}

function buildAdvVsActual(
  prices: FuelPriceRow[],
  advertisedPrices: AdvertisedPriceRow[],
  volumeGallons: number | null,
): AdvVsActualRow[] {
  // Group invoice data by (vendor_lower, airport) — all time for "actual" avg
  const invoiceBuckets = new Map<string, { prices: number[]; count: number }>();
  // Build per-airport list of (date, price) for flexible date-range lookups
  // Key: normalized airport code → { date, price }[]
  const pricesByAirport = new Map<string, { date: string; price: number }[]>();

  for (const r of prices) {
    if (!r.airport_code || r.effective_price_per_gallon == null) continue;
    // Filter out prices below $1 (assumed erroneous)
    if (r.effective_price_per_gallon < 1) continue;

    // Store under all airport variants for flexible matching
    if (r.invoice_date) {
      for (const v of airportVariants(r.airport_code)) {
        if (!pricesByAirport.has(v)) pricesByAirport.set(v, []);
        pricesByAirport.get(v)!.push({ date: r.invoice_date, price: r.effective_price_per_gallon });
      }
    }

    // All-time by airport (all sources — assume same FBO at each airport)
    for (const v of airportVariants(r.airport_code)) {
      if (!invoiceBuckets.has(v)) invoiceBuckets.set(v, { prices: [], count: 0 });
      const bucket = invoiceBuckets.get(v)!;
      bucket.prices.push(r.effective_price_per_gallon);
      bucket.count++;
    }
  }

  // Group advertised by vendor+airport — skip tail-specific rows, filter by volume tier
  let filteredAdv = advertisedPrices.filter((a) => !a.tail_numbers);
  if (volumeGallons && volumeGallons > 0) {
    // Keep only tiers that match the selected volume
    const volumeFiltered = filteredAdv.filter((a) => tierMatchesVolume(a.volume_tier, volumeGallons));
    if (volumeFiltered.length > 0) filteredAdv = volumeFiltered;
  }
  // For each (vendor, airport, FBO, week), keep the best-matching tier:
  // - If volume is set: pick the tier whose min is closest to (but ≤) the volume
  // - If no volume: pick the tier with the smallest minimum (retail/base tier)
  const dedupedAdv: AdvertisedPriceRow[] = [];
  const seenByWeek = new Map<string, AdvertisedPriceRow>();
  function tierMinGal(tier: string): number {
    const m = tier.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  for (const adv of filteredAdv) {
    const fbo = extractFboName(adv.product) ?? "";
    const wk = `${adv.fbo_vendor}|${normAirport(adv.airport_code)}|${normFboKey(fbo)}|${getWeekMonday(adv.week_start)}`;
    const existing = seenByWeek.get(wk);
    if (!existing) {
      seenByWeek.set(wk, adv);
      dedupedAdv.push(adv);
    } else {
      const existMin = tierMinGal(existing.volume_tier);
      const newMin = tierMinGal(adv.volume_tier);
      let replace = false;
      if (volumeGallons && volumeGallons > 0) {
        // Prefer tier whose min is closest to volume without exceeding it
        const existFit = existMin <= volumeGallons ? existMin : -1;
        const newFit = newMin <= volumeGallons ? newMin : -1;
        replace = newFit > existFit;
      } else {
        // No volume set — prefer smallest tier (retail price)
        replace = newMin < existMin;
      }
      if (replace) {
        seenByWeek.set(wk, adv);
        const idx = dedupedAdv.indexOf(existing);
        if (idx >= 0) dedupedAdv[idx] = adv;
      }
    }
  }

  // --- Step 1: Group by (vendor, airport, fboName, week) as before for WoW ---
  const advByVendorIdentity = new Map<string, AdvertisedPriceRow[]>();
  for (const adv of dedupedAdv) {
    const fbo = extractFboName(adv.product) ?? "";
    const key = `${adv.fbo_vendor}|${normAirport(adv.airport_code)}|${normFboKey(fbo)}`;
    if (!advByVendorIdentity.has(key)) advByVendorIdentity.set(key, []);
    advByVendorIdentity.get(key)!.push(adv);
  }

  // Build per-vendor WoW data
  const vendorWow = new Map<string, VendorQuote>();
  for (const [vKey, group] of advByVendorIdentity) {
    group.sort((a, b) => b.week_start.localeCompare(a.week_start));
    const latest = group[0];
    const prev = group.length > 1 ? group[1] : null;
    let wowChange: number | null = null;
    let wowChangePct: number | null = null;
    if (prev) {
      wowChange = Math.round((latest.price - prev.price) * 10000) / 10000;
      if (prev.price > 0) wowChangePct = Math.round(((latest.price - prev.price) / prev.price) * 1000) / 10;
    }
    vendorWow.set(vKey, {
      fboVendor: latest.fbo_vendor,
      volumeTier: latest.volume_tier,
      tailNumbers: latest.tail_numbers,
      currentWeek: latest.week_start,
      currentPrice: latest.price,
      prevWeek: prev?.week_start ?? null,
      prevPrice: prev?.price ?? null,
      wowChange,
      wowChangePct,
    });
  }

  // --- Step 2: Group by canonical FBO (airport + brand + location) ---
  const advByCanonical = new Map<string, { adv: AdvertisedPriceRow; vKey: string }[]>();
  for (const adv of dedupedAdv) {
    const fbo = extractFboName(adv.product) ?? adv.fbo_vendor;
    const cKey = canonicalFboKey(fbo, adv.airport_code);
    if (!advByCanonical.has(cKey)) advByCanonical.set(cKey, []);
    const vKey = `${adv.fbo_vendor}|${normAirport(adv.airport_code)}|${normFboKey(extractFboName(adv.product) ?? "")}`;
    advByCanonical.get(cKey)!.push({ adv, vKey });
  }

  const rows: AdvVsActualRow[] = [];
  for (const [cKey, group] of advByCanonical) {
    // Pick the most recent entry as representative
    group.sort((a, b) => b.adv.week_start.localeCompare(a.adv.week_start));
    const latest = group[0].adv;
    const fboRaw = extractFboName(latest.product) ?? latest.fbo_vendor;
    const canon = canonicalFbo(fboRaw, latest.airport_code);

    // Collect unique vendor quotes for this canonical FBO
    const seenVendors = new Set<string>();
    const quotes: VendorQuote[] = [];
    for (const { vKey } of group) {
      if (seenVendors.has(vKey)) continue;
      seenVendors.add(vKey);
      const q = vendorWow.get(vKey);
      if (!q) continue;
      // Dedup by vendor display name — same vendor can appear with different vKeys
      // due to airport code variants (KTEB vs TEB) or product format differences
      const vendorDisplayKey = `${q.fboVendor.toLowerCase()}|${q.volumeTier}`;
      if (seenVendors.has(vendorDisplayKey)) continue;
      seenVendors.add(vendorDisplayKey);
      quotes.push(q);
    }
    // Sort quotes: cheapest first
    quotes.sort((a, b) => a.currentPrice - b.currentPrice);

    // Use cheapest vendor quote as the "headline" price
    const best = quotes[0] ?? null;
    // Find previous week across all vendors for WoW
    const allPrevPrices = quotes.filter((q) => q.prevPrice != null);
    const bestPrev = allPrevPrices.length > 0 ? allPrevPrices.sort((a, b) => a.prevPrice! - b.prevPrice!)[0] : null;

    let wowChange: number | null = null;
    let wowChangePct: number | null = null;
    if (best && bestPrev?.prevPrice != null) {
      wowChange = Math.round((best.currentPrice - bestPrev.prevPrice) * 10000) / 10000;
      if (bestPrev.prevPrice > 0) wowChangePct = Math.round(((best.currentPrice - bestPrev.prevPrice) / bestPrev.prevPrice) * 1000) / 10;
    }

    // Actual avg for this airport
    const variants = airportVariants(latest.airport_code);
    let bucket: { prices: number[]; count: number } | undefined;
    for (const v of variants) {
      bucket = invoiceBuckets.get(v);
      if (bucket && bucket.prices.length > 0) break;
    }
    const actualAvg = bucket && bucket.prices.length > 0
      ? Math.round((bucket.prices.reduce((a, b) => a + b, 0) / bucket.prices.length) * 10000) / 10000
      : null;
    const invoiceCount = bucket?.count ?? 0;

    // Recent 7-day avg
    const weekDate = new Date(latest.week_start + "T12:00:00");
    const minDate = new Date(weekDate.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const maxDate = new Date(weekDate.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    let airportPrices: { date: string; price: number }[] = [];
    for (const v of variants) {
      airportPrices = pricesByAirport.get(v) ?? [];
      if (airportPrices.length > 0) break;
    }
    const recentPrices = airportPrices.filter((p) => p.date >= minDate && p.date <= maxDate && p.price >= 1);
    const recent7dAvg = recentPrices.length > 0
      ? Math.round((recentPrices.reduce((a, b) => a + b.price, 0) / recentPrices.length) * 10000) / 10000
      : null;
    const recent7dCount = recentPrices.length;

    const comparePrice = recent7dAvg ?? actualAvg;
    let vsActualPct: number | null = null;
    if (comparePrice != null && best && best.currentPrice > 0) {
      vsActualPct = Math.round(((comparePrice - best.currentPrice) / best.currentPrice) * 1000) / 10;
    }

    rows.push({
      key: cKey,
      airport: normAirport(latest.airport_code),
      fboVendor: best?.fboVendor ?? latest.fbo_vendor,
      fboName: extractFboName(latest.product),
      canonicalBrand: canon.brand,
      canonicalLocation: canon.location,
      vendorQuotes: quotes,
      volumeTier: best?.volumeTier ?? latest.volume_tier,
      tailNumbers: best?.tailNumbers ?? latest.tail_numbers,
      currentWeek: quotes.reduce((newest, q) => q.currentWeek > newest ? q.currentWeek : newest, best?.currentWeek ?? latest.week_start),
      currentPrice: best?.currentPrice ?? latest.price,
      prevWeek: bestPrev?.prevWeek ?? null,
      prevPrice: bestPrev?.prevPrice ?? null,
      wowChange,
      wowChangePct,
      actualAvgPrice: actualAvg,
      invoiceCount,
      vsActualPct,
      recent7dAvg,
      recent7dCount,
    });
  }

  // Sort: rows with actual invoice data first (by invoice count desc), then airport alpha
  rows.sort((a, b) => {
    // Rows with actual paid data come first, ordered by most invoice activity
    const aCount = a.invoiceCount + a.recent7dCount;
    const bCount = b.invoiceCount + b.recent7dCount;
    if (aCount > 0 && bCount === 0) return -1;
    if (aCount === 0 && bCount > 0) return 1;
    if (aCount > 0 && bCount > 0) {
      if (bCount !== aCount) return bCount - aCount;
    }
    // Then by airport
    const ac = a.airport.localeCompare(b.airport);
    if (ac !== 0) return ac;
    return a.fboVendor.localeCompare(b.fboVendor);
  });

  return rows;
}

// ─── Import Modal ────────────────────────────────────────────────────────────

function ImportAdvertisedModal({ onClose }: { onClose: () => void }) {
  const [vendor, setVendor] = useState("");
  const [weekStart, setWeekStart] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; inserted?: number; skipped?: number; error?: string; vendor?: string; format?: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setResult(null);

    const fd = new FormData();
    fd.append("file", file);
    if (vendor) fd.append("vendor", vendor);
    if (weekStart) fd.append("week_start", weekStart);

    try {
      const res = await fetch("/api/fuel-prices/advertised/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok && data.ok) {
        setResult({ ok: true, inserted: data.inserted, skipped: data.skipped, vendor: data.vendor, format: data.detectedFormat });
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
          <p className="font-semibold mb-1">Supported CSV formats:</p>
          <ul className="list-disc ml-4 space-y-0.5 text-[11px]">
            <li><strong>AEG/Baker</strong> &mdash; auto-detected (ICAO, FUELER, TOTAL PRICE columns)</li>
            <li><strong>Everest Fuel</strong> &mdash; auto-detected (ICAO, FBO, TIER, PRICE columns)</li>
            <li><strong>WFS (World Fuel)</strong> &mdash; auto-detected (SUPPLIER, ESTIMATED TOTAL PRICE columns)</li>
            <li><strong>Avfuel/BAKAV</strong> &mdash; auto-detected (FIXED BASE OPERATOR, EFF DATE columns)</li>
            <li><strong>Titan Fuels</strong> &mdash; auto-detected (AIRPORT CODE, JET A WITH ADD PRICE PER UNIT columns)</li>
            <li><strong>Signature</strong> &mdash; auto-detected (BASE, MIN QUANTITY, MAX QUANTITY, TOTAL columns)</li>
            <li><strong>Generic</strong> &mdash; Airport, Volume Tier, Product, Price, Tail Numbers</li>
          </ul>
          <p className="mt-1 text-blue-600">All named formats are auto-detected. Vendor name and week date are optional &mdash; date can be in filename or per-row.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vendor Name <span className="text-gray-400 font-normal">(optional for Baker/Everest)</span></label>
            <input
              type="text"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="e.g. Jet Aviation — leave blank for auto-detect"
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Week Starting <span className="text-gray-400 font-normal">(optional if in filename)</span></label>
            <input
              type="date"
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
                ? `Imported ${result.inserted} rows (${result.skipped} updated)${result.vendor ? ` — ${result.vendor}` : ""}${result.format && result.format !== "generic" ? ` (${result.format} format)` : ""}`
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
                disabled={loading || !file}
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
  salespersons = [],
}: {
  initialPrices: FuelPriceRow[];
  advertisedPrices?: AdvertisedPriceRow[];
  salespersons?: TripSalesperson[];
}) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [airportFilter, setAirportFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("advertised");
  const [showImportModal, setShowImportModal] = useState(false);
  const [volumeGallons, setVolumeGallons] = useState<string>("");
  const [compareJetFbo, setCompareJetFbo] = useState(false);
  const [hideStale, setHideStale] = useState(true);
  const [isPulling, setIsPulling] = useState(false);
  const [pullResult, setPullResult] = useState<string | null>(null);
  const [extendedAdv, setExtendedAdv] = useState<AdvertisedPriceRow[] | null>(null);
  const [loadingExtended, setLoadingExtended] = useState(false);
  const [showWoW, setShowWoW] = useState(false);

  const activeAdvertisedPrices = extendedAdv ?? advertisedPrices;

  // Build salesperson lookup: tail|airport(IATA)|date → salesperson_name
  const salespersonLookup = useMemo(() => {
    const map = new Map<string, string>();
    if (!salespersons?.length) return map;
    for (const s of salespersons) {
      if (!s.tail_number || !s.scheduled_departure) continue;
      const date = s.scheduled_departure.split("T")[0];
      const toIata = (icao: string | null) =>
        icao && icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;
      const originIata = toIata(s.origin_icao);
      const destIata = toIata(s.destination_icao);
      if (originIata) map.set(`${s.tail_number}|${originIata}|${date}`, s.salesperson_name);
      if (destIata) map.set(`${s.tail_number}|${destIata}|${date}`, s.salesperson_name);
    }
    return map;
  }, [salespersons]);

  async function handlePullNow() {
    setIsPulling(true);
    setPullResult(null);
    try {
      const res = await fetch("/api/fuel-prices/advertised/pull-mailbox?force=true", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setPullResult(`Error: ${data.error ?? res.statusText}`);
      } else if (data.totalInserted > 0) {
        setPullResult(`Pulled ${data.totalInserted} prices from ${data.messagesProcessed} email(s). Refreshing...`);
        setTimeout(() => window.location.reload(), 2000);
      } else {
        setPullResult(`Scanned ${data.messagesScanned} emails — no new rate sheets found`);
      }
    } catch (e) {
      setPullResult(`Error: ${String(e)}`);
    } finally {
      setIsPulling(false);
    }
  }

  // Filter out advertised prices older than 14 days (some vendors have effective dates
  // up to ~12 days before the current date, e.g. Avfuel EFF DATE of 3/4 on 3/14)
  const freshAdvertisedPrices = useMemo(() => {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    return activeAdvertisedPrices.filter((a) => a.week_start >= cutoff);
  }, [activeAdvertisedPrices]);

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
    for (const adv of freshAdvertisedPrices) {
      const key = `${adv.fbo_vendor.toLowerCase()}|${adv.airport_code}|${adv.week_start}`;
      if (!lookup.has(key)) lookup.set(key, []);
      lookup.get(key)!.push(adv);
    }
    return lookup;
  }, [freshAdvertisedPrices]);

  // Best-rate lookup: key = "airport|week_monday" → all vendor rows for that airport+week
  const advByAirportWeek = useMemo(() => {
    const lookup = new Map<string, AdvertisedPriceRow[]>();
    for (const adv of freshAdvertisedPrices) {
      const key = `${adv.airport_code}|${adv.week_start}`;
      if (!lookup.has(key)) lookup.set(key, []);
      lookup.get(key)!.push(adv);
    }
    return lookup;
  }, [freshAdvertisedPrices]);

  // Fallback lookup: airport → all weeks sorted newest first (for when exact week has no match)
  const advByAirport = useMemo(() => {
    const lookup = new Map<string, AdvertisedPriceRow[]>();
    for (const adv of freshAdvertisedPrices) {
      if (!lookup.has(adv.airport_code)) lookup.set(adv.airport_code, []);
      lookup.get(adv.airport_code)!.push(adv);
    }
    // Sort each airport's prices newest first
    for (const [, rows] of lookup) {
      rows.sort((a, b) => b.week_start.localeCompare(a.week_start));
    }
    return lookup;
  }, [freshAdvertisedPrices]);

  // Latest week per vendor (for freshness indicator)
  const vendorFreshness = useMemo(() => {
    const byVendor = new Map<string, { latestWeek: string; rowCount: number }>();
    for (const adv of freshAdvertisedPrices) {
      const existing = byVendor.get(adv.fbo_vendor);
      if (!existing || adv.week_start > existing.latestWeek) {
        byVendor.set(adv.fbo_vendor, {
          latestWeek: adv.week_start,
          rowCount: (existing?.rowCount ?? 0) + 1,
        });
      } else {
        existing.rowCount++;
      }
    }
    return [...byVendor.entries()]
      .map(([vendor, info]) => ({ vendor, ...info }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor));
  }, [freshAdvertisedPrices]);

  // Advertised vs Actual comparison rows
  const parsedGallons = volumeGallons ? parseInt(volumeGallons, 10) : null;
  const advVsActual = useMemo(
    () => buildAdvVsActual(initialPrices, freshAdvertisedPrices, parsedGallons),
    [initialPrices, freshAdvertisedPrices, parsedGallons],
  );

  // Average WoW change per vendor
  const vendorAvgWow = useMemo(() => {
    const byVendor = new Map<string, number[]>();
    for (const row of advVsActual) {
      if (row.wowChangePct == null) continue;
      if (!byVendor.has(row.fboVendor)) byVendor.set(row.fboVendor, []);
      byVendor.get(row.fboVendor)!.push(row.wowChangePct);
    }
    const result = new Map<string, number>();
    for (const [vendor, pcts] of byVendor) {
      result.set(vendor, Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10);
    }
    return result;
  }, [advVsActual]);

  // Latest invoice per airport (for linking from Adv vs Actual tab)
  const latestInvoiceByAirport = useMemo(() => {
    const lookup = new Map<string, { docId: string; date: string }>();
    for (const r of initialPrices) {
      if (!r.airport_code || !r.document_id || (r.data_source ?? "invoice") === "jetinsight") continue;
      const codes = r.airport_code.length === 4 && r.airport_code.startsWith("K")
        ? [r.airport_code, r.airport_code.slice(1)]
        : r.airport_code.length === 3
        ? [r.airport_code, `K${r.airport_code}`]
        : [r.airport_code];
      for (const code of codes) {
        const existing = lookup.get(code);
        if (!existing || (r.invoice_date ?? "") > existing.date) {
          lookup.set(code, { docId: r.document_id, date: r.invoice_date ?? "" });
        }
      }
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

  // Filtered advertised vs actual
  const filteredAdvVsActual = useMemo(() => {
    let rows = advVsActual;
    if (airportFilter) {
      // Match both KSAN↔SAN variants
      const normFilter = airportFilter.length === 4 && airportFilter.startsWith("K")
        ? airportFilter.slice(1) : airportFilter;
      const variants = new Set([airportFilter, normFilter, `K${normFilter}`]);
      rows = rows.filter((r) => variants.has(r.airport));
    }
    if (vendorFilter) rows = rows.filter((r) => r.fboVendor === vendorFilter);
    if (compareJetFbo) {
      // Match rows where the FBO (by vendor or fboName) is Jet Aviation, Atlantic, or Signature
      function isTargetFbo(r: AdvVsActualRow): boolean {
        const brand = (r.canonicalBrand ?? "").toLowerCase();
        if (brand === "jet aviation" || brand === "atlantic aviation" || brand === "signature") return true;
        // Fallback: check raw names
        const vendor = r.fboVendor.toLowerCase();
        const fbo = (r.fboName ?? "").toLowerCase();
        if (vendor === "jet aviation" || vendor === "signature flight support") return true;
        if (fbo.includes("jet aviation") || fbo.includes("atlantic") || fbo.includes("signature")) return true;
        return false;
      }
      // Find airports where Jet Aviation has pricing (by vendor or FBO name)
      const jetAirports = new Set(
        rows
          .filter((r) => {
            const vendor = r.fboVendor.toLowerCase();
            const fbo = (r.fboName ?? "").toLowerCase();
            return vendor === "jet aviation" || fbo.includes("jet aviation");
          })
          .map((r) => r.airport),
      );
      rows = rows.filter((r) => jetAirports.has(r.airport) && isTargetFbo(r));
    }
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        [r.airport, r.fboVendor, r.fboName, r.canonicalBrand, r.canonicalLocation, r.tailNumbers]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(q)),
      );
    }
    if (hideStale) {
      const staleCutoff = new Date(Date.now() - 8 * 86400000).toISOString().split("T")[0];
      rows = rows.filter((r) => r.currentWeek >= staleCutoff);
    }
    return rows;
  }, [advVsActual, airportFilter, vendorFilter, search, compareJetFbo, hideStale]);

  // Cheapest price per airport — only rows with data ≤8 days old
  const cheapestByAirport = useMemo(() => {
    const cutoff = new Date(Date.now() - 8 * 86400000).toISOString().split("T")[0];
    const best = new Map<string, number>();
    for (const r of filteredAdvVsActual) {
      if (r.currentWeek < cutoff) continue;
      const existing = best.get(r.airport);
      if (existing == null || r.currentPrice < existing) {
        best.set(r.airport, r.currentPrice);
      }
    }
    return best;
  }, [filteredAdvVsActual]);

  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const compPageRows = filteredComparisons.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const compTotalPages = Math.ceil(filteredComparisons.length / PAGE_SIZE);

  const advPageRows = filteredAdvVsActual.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const advTotalPages = Math.ceil(filteredAdvVsActual.length / PAGE_SIZE);

  const hasBothSources = sourceCounts.invoice > 0 && sourceCounts.jetinsight > 0;
  const hasJetInsight = sourceCounts.jetinsight > 0;
  const hasAdvertised = freshAdvertisedPrices.length > 0;

  const activeTotalPages = viewMode === "compare" ? compTotalPages : viewMode === "advertised" ? advTotalPages : totalPages;
  const activeCount = viewMode === "compare" ? filteredComparisons.length : viewMode === "advertised" ? filteredAdvVsActual.length : filtered.length;

  // ─── Price sheet health indicator ───────────────────────────────────────────
  const EXPECTED_VENDORS = ["AEG Fuels", "Atlantic Aviation", "Avfuel", "EVO", "Everest Fuel", "Jet Aviation", "Signature Flight Support", "Titan Fuels", "World Fuel Services"];

  const vendorHealth = useMemo(() => {
    const now = new Date();
    const byVendor = new Map<string, { latestWeek: string; rowCount: number; latestUpload: string }>();
    for (const adv of activeAdvertisedPrices) {
      const existing = byVendor.get(adv.fbo_vendor);
      if (!existing || adv.week_start > existing.latestWeek) {
        byVendor.set(adv.fbo_vendor, {
          latestWeek: adv.week_start,
          rowCount: (existing?.rowCount ?? 0) + 1,
          latestUpload: adv.created_at > (existing?.latestUpload ?? "") ? adv.created_at : (existing?.latestUpload ?? adv.created_at),
        });
      } else {
        existing.rowCount++;
        if (adv.created_at > existing.latestUpload) existing.latestUpload = adv.created_at;
      }
    }
    return EXPECTED_VENDORS.map((vendor) => {
      const info = byVendor.get(vendor);
      if (!info) return { vendor, status: "missing" as const, latestWeek: null, daysOld: null, rowCount: 0, latestUpload: null };
      const weekDate = new Date(info.latestWeek + "T12:00:00");
      const daysOld = Math.floor((now.getTime() - weekDate.getTime()) / (1000 * 60 * 60 * 24));
      const status = daysOld <= 7 ? "current" as const : daysOld <= 14 ? "aging" as const : "stale" as const;
      return { vendor, status, latestWeek: info.latestWeek, daysOld, rowCount: info.rowCount, latestUpload: info.latestUpload };
    });
  }, [activeAdvertisedPrices]);

  const healthCounts = useMemo(() => {
    let current = 0, aging = 0, missing = 0;
    for (const v of vendorHealth) {
      if (v.status === "current") current++;
      else if (v.status === "aging") aging++;
      else missing++;
    }
    return { current, aging, missing };
  }, [vendorHealth]);

  // ─── Stats: Vendor price change stats ──────────────────────────────────────
  const vendorPriceStats = useMemo(() => {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0];
    const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000).toISOString().split("T")[0];
    const fourWeeksAgo = new Date(now.getTime() - 28 * 86400000).toISOString().split("T")[0];
    const fiveWeeksAgo = new Date(now.getTime() - 35 * 86400000).toISOString().split("T")[0];

    return EXPECTED_VENDORS.map((vendor) => {
      const rows = activeAdvertisedPrices.filter((a) => a.fbo_vendor === vendor && !a.tail_numbers && a.price >= 2 && a.price <= 15);

      // Current = latest week (within 7 days)
      const currentRows = rows.filter((a) => a.week_start >= oneWeekAgo);
      const prevWeekRows = rows.filter((a) => a.week_start >= twoWeeksAgo && a.week_start < oneWeekAgo);
      const monthAgoRows = rows.filter((a) => a.week_start >= fiveWeeksAgo && a.week_start < fourWeeksAgo);

      const avg = (arr: typeof rows) => {
        if (arr.length === 0) return null;
        return arr.reduce((s, r) => s + r.price, 0) / arr.length;
      };

      const currentAvg = avg(currentRows);
      const prevWeekAvg = avg(prevWeekRows);
      const monthAgoAvg = avg(monthAgoRows);

      let weekChange$: number | null = null;
      let weekChangePct: number | null = null;
      if (currentAvg != null && prevWeekAvg != null) {
        weekChange$ = Math.round((currentAvg - prevWeekAvg) * 10000) / 10000;
        if (prevWeekAvg > 0) weekChangePct = Math.round(((currentAvg - prevWeekAvg) / prevWeekAvg) * 1000) / 10;
      }

      let monthChange$: number | null = null;
      let monthChangePct: number | null = null;
      if (currentAvg != null && monthAgoAvg != null) {
        monthChange$ = Math.round((currentAvg - monthAgoAvg) * 10000) / 10000;
        if (monthAgoAvg > 0) monthChangePct = Math.round(((currentAvg - monthAgoAvg) / monthAgoAvg) * 1000) / 10;
      }

      return {
        vendor,
        currentAvg,
        prevWeekAvg,
        monthAgoAvg,
        weekChange$,
        weekChangePct,
        monthChange$,
        monthChangePct,
        rowCount: currentRows.length,
      };
    });
  }, [activeAdvertisedPrices]);

  // Overall average across all vendors with data
  const overallStats = useMemo(() => {
    const withCurrent = vendorPriceStats.filter((v) => v.currentAvg != null);
    const withWeek = vendorPriceStats.filter((v) => v.weekChange$ != null);
    const withMonth = vendorPriceStats.filter((v) => v.monthChange$ != null);

    const avgCurrent = withCurrent.length > 0
      ? withCurrent.reduce((s, v) => s + v.currentAvg!, 0) / withCurrent.length : null;
    const avgWeek$ = withWeek.length > 0
      ? withWeek.reduce((s, v) => s + v.weekChange$!, 0) / withWeek.length : null;
    const avgWeekPct = withWeek.length > 0
      ? withWeek.reduce((s, v) => s + v.weekChangePct!, 0) / withWeek.length : null;
    const avgMonth$ = withMonth.length > 0
      ? withMonth.reduce((s, v) => s + v.monthChange$!, 0) / withMonth.length : null;
    const avgMonthPct = withMonth.length > 0
      ? withMonth.reduce((s, v) => s + v.monthChangePct!, 0) / withMonth.length : null;

    return {
      currentAvg: avgCurrent != null ? Math.round(avgCurrent * 10000) / 10000 : null,
      weekChange$: avgWeek$ != null ? Math.round(avgWeek$ * 10000) / 10000 : null,
      weekChangePct: avgWeekPct != null ? Math.round(avgWeekPct * 10) / 10 : null,
      monthChange$: avgMonth$ != null ? Math.round(avgMonth$ * 10000) / 10000 : null,
      monthChangePct: avgMonthPct != null ? Math.round(avgMonthPct * 10) / 10 : null,
      vendorCount: withCurrent.length,
    };
  }, [vendorPriceStats]);

  // ─── Stats: VNY & TEB Jet Aviation vs cheapest ────────────────────────────
  const airportJetComparisons = useMemo(() => {
    const TARGET_AIRPORTS = ["VNY", "TEB"];
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0];
    const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000).toISOString().split("T")[0];
    const fourWeeksAgo = new Date(now.getTime() - 28 * 86400000).toISOString().split("T")[0];
    const fiveWeeksAgo = new Date(now.getTime() - 35 * 86400000).toISOString().split("T")[0];

    return TARGET_AIRPORTS.map((airport) => {
      const variants = airportVariants(airport);
      const airportRows = activeAdvertisedPrices.filter(
        (a) => !a.tail_numbers && a.price >= 2 && a.price <= 15 && variants.includes(a.airport_code.toUpperCase()),
      );

      const currentRows = airportRows.filter((a) => a.week_start >= oneWeekAgo);
      const prevWeekRows = airportRows.filter((a) => a.week_start >= twoWeeksAgo && a.week_start < oneWeekAgo);
      const monthAgoRows = airportRows.filter((a) => a.week_start >= fiveWeeksAgo && a.week_start < fourWeeksAgo);

      // Jet Aviation
      const isJet = (r: AdvertisedPriceRow) => r.fbo_vendor.toLowerCase() === "jet aviation";
      const jetCurrent = currentRows.filter(isJet);
      const jetPrev = prevWeekRows.filter(isJet);
      const jetMonth = monthAgoRows.filter(isJet);

      const avg = (arr: AdvertisedPriceRow[]) =>
        arr.length === 0 ? null : arr.reduce((s, r) => s + r.price, 0) / arr.length;

      const jetCurrentAvg = avg(jetCurrent);
      const jetPrevAvg = avg(jetPrev);
      const jetMonthAvg = avg(jetMonth);

      // Cheapest vendor (current week, excluding Jet Aviation)
      const nonJetCurrent = currentRows.filter((r) => !isJet(r));
      let cheapestVendor: string | null = null;
      let cheapestPrice: number | null = null;
      for (const r of nonJetCurrent) {
        if (cheapestPrice == null || r.price < cheapestPrice) {
          cheapestPrice = r.price;
          cheapestVendor = r.fbo_vendor;
        }
      }

      // Cheapest vendor's prev/month prices (same vendor)
      const cheapPrev = cheapestVendor
        ? prevWeekRows.filter((r) => r.fbo_vendor === cheapestVendor)
        : [];
      const cheapMonth = cheapestVendor
        ? monthAgoRows.filter((r) => r.fbo_vendor === cheapestVendor)
        : [];
      const cheapPrevAvg = avg(cheapPrev);
      const cheapMonthAvg = avg(cheapMonth);

      const trend = (curr: number | null, prev: number | null) => {
        if (curr == null || prev == null || prev === 0) return { $: null as number | null, pct: null as number | null };
        return {
          $: Math.round((curr - prev) * 10000) / 10000,
          pct: Math.round(((curr - prev) / prev) * 1000) / 10,
        };
      };

      let savings$: number | null = null;
      let savingsPct: number | null = null;
      if (jetCurrentAvg != null && cheapestPrice != null) {
        savings$ = Math.round((jetCurrentAvg - cheapestPrice) * 10000) / 10000;
        if (cheapestPrice > 0) savingsPct = Math.round(((jetCurrentAvg - cheapestPrice) / cheapestPrice) * 1000) / 10;
      }

      return {
        airport,
        jet: {
          currentAvg: jetCurrentAvg,
          weekTrend: trend(jetCurrentAvg, jetPrevAvg),
          monthTrend: trend(jetCurrentAvg, jetMonthAvg),
        },
        cheapest: {
          vendor: cheapestVendor,
          currentPrice: cheapestPrice,
          weekTrend: trend(cheapestPrice, cheapPrevAvg),
          monthTrend: trend(cheapestPrice, cheapMonthAvg),
        },
        savings$,
        savingsPct,
      };
    });
  }, [activeAdvertisedPrices]);

  // Load extended advertised prices (30 days) for WOW/month comparisons
  async function loadExtendedPrices() {
    if (extendedAdv || loadingExtended) return;
    setLoadingExtended(true);
    try {
      const res = await fetch("/api/fuel-prices/advertised?weeks=8");
      const data = await res.json();
      if (data.prices) setExtendedAdv(data.prices);
    } catch { /* ignore */ }
    finally { setLoadingExtended(false); }
  }

  return (
    <div className="space-y-4">
      {/* Price sheet health bar */}
      <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-xs font-semibold text-gray-700">Price Sheet Health</span>
          <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
            healthCounts.missing + healthCounts.aging === 0
              ? "bg-green-100 text-green-700"
              : healthCounts.missing > 0
              ? "bg-red-100 text-red-700"
              : "bg-amber-100 text-amber-700"
          }`}>
            {healthCounts.current}/{EXPECTED_VENDORS.length} current
          </span>
          <button
            type="button"
            onClick={handlePullNow}
            disabled={isPulling}
            className="ml-auto px-3 py-1 text-xs font-medium rounded-md border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
          >
            {isPulling ? "Pulling..." : "Pull Emails Now"}
          </button>
          {pullResult && (
            <span className={`text-[10px] ${pullResult.startsWith("Error") ? "text-red-600" : "text-green-600"}`}>
              {pullResult}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {vendorHealth.map(({ vendor, status, latestWeek, rowCount, latestUpload }) => {
            const uploadAge = latestUpload ? fmtTimeAgo(latestUpload) : null;
            return (
            <span
              key={vendor}
              title={status === "missing"
                ? `${vendor}: No data uploaded`
                : `${vendor}: ${rowCount} prices, week of ${fmtDate(latestWeek)}${uploadAge ? `, updated ${uploadAge}` : ""}`}
              className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full border ${
                status === "current"
                  ? "bg-green-50 text-green-700 border-green-200"
                  : status === "aging"
                  ? "bg-amber-50 text-amber-700 border-amber-200"
                  : status === "stale"
                  ? "bg-red-50 text-red-700 border-red-200"
                  : "bg-gray-50 text-gray-400 border-gray-200 border-dashed"
              }`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                status === "current" ? "bg-green-400"
                  : status === "aging" ? "bg-amber-400"
                  : status === "stale" ? "bg-red-400"
                  : "bg-gray-300"
              }`} />
              {vendor.replace("Flight Support", "").replace("Aviation", "Avn").replace("Services", "Svc").trim()}
              {uploadAge
                ? <span className="opacity-60">{uploadAge}</span>
                : latestWeek && <span className="opacity-60">{fmtDate(latestWeek)}</span>}
            </span>
            );
          })}
        </div>
      </div>

      {/* View mode tabs + source filters */}
      <div className="flex flex-wrap items-center gap-4">
        {/* View toggle */}
        <div className="flex rounded-lg border bg-gray-100 p-0.5">
          {(
            [
              { key: "all" as const, label: "Live Feed" },
              ...(hasBothSources ? [{ key: "compare" as const, label: "Compare by Airport" }] : []),
              ...(hasAdvertised ? [{ key: "advertised" as const, label: "Advertised vs Actual" }] : []),
              ...(hasAdvertised ? [{ key: "stats" as const, label: "Stats" }] : []),
            ]
          ).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => { setViewMode(key); setPage(0); if (key === "stats" && !extendedAdv) loadExtendedPrices(); }}
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

        {/* WoW toggle (Live Feed only) */}
        {viewMode === "all" && (
          <button
            type="button"
            onClick={() => setShowWoW((v) => !v)}
            className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
              showWoW
                ? "bg-indigo-100 text-indigo-800 border-indigo-300"
                : "bg-white text-gray-500 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
            }`}
          >
            {showWoW ? "Hide" : "Show"} Averages
          </button>
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

      {/* Filters (hidden on stats tab) */}
      {viewMode !== "stats" && <div className="flex flex-wrap items-center gap-3">
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

        {viewMode === "advertised" && (
          <>
            <input
              type="number"
              placeholder="Gallons (e.g. 500)"
              value={volumeGallons}
              onChange={(e) => { setVolumeGallons(e.target.value); setPage(0); }}
              className="rounded-md border px-3 py-1.5 text-sm bg-white w-44"
              min={1}
            />
            <button
              type="button"
              onClick={() => { setCompareJetFbo((v) => !v); setPage(0); }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                compareJetFbo
                  ? "bg-indigo-100 text-indigo-800 border-indigo-300"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
              }`}
              title="Compare Jet Aviation, Atlantic, and Signature at airports where Jet Aviation has pricing"
            >
              Compare FBOs
            </button>
            <button
              type="button"
              onClick={() => { setHideStale((v) => !v); setPage(0); }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                hideStale
                  ? "bg-amber-100 text-amber-800 border-amber-300"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
              }`}
              title="Hide prices older than 8 days"
            >
              {hideStale ? "Stale Hidden" : "Show All"}
            </button>
            {!extendedAdv && (
              <button
                type="button"
                onClick={loadExtendedPrices}
                disabled={loadingExtended}
                className="px-3 py-1.5 text-xs font-medium rounded-md border bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                {loadingExtended ? "Loading..." : "30 Day Comparison"}
              </button>
            )}
          </>
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
      </div>}

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
                <th className="px-4 py-3">FBO</th>
                <th className="px-4 py-3">Tail</th>
                <th className="px-4 py-3 text-right">Gallons</th>
                <th className="px-4 py-3 text-right">Fuel Total</th>
                <th className="px-4 py-3 text-right bg-blue-50/70 border-l border-blue-100">
                  <span title="Effective $/gal (fuel + per-gallon taxes). Base price shown below in gray." className="text-blue-900">$/Gal</span>
                </th>
                {hasAdvertised && (
                  <>
                    <th className="px-4 py-3 text-right bg-blue-50/70">
                      <span title="Cheapest contract rate across all vendors for this airport + week + volume" className="text-blue-900">Best Rate</span>
                    </th>
                    <th className="px-4 py-3 text-right bg-blue-50/70 border-r border-blue-100">
                      <span title="How much more/less you paid vs the best available contract rate" className="text-blue-900">% Diff</span>
                    </th>
                  </>
                )}
                <th className="px-4 py-3">Salesperson</th>
                {showWoW && (
                  <>
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
                  </>
                )}
                <th className="px-4 py-3 text-center">Source</th>
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

                // Advertised price lookup (vendor-specific)
                const advPrice = hasAdvertised
                  ? lookupAdvertisedPrice(advLookup, row.vendor_name, row.airport_code, row.invoice_date, row.tail_number)
                  : null;
                let vsAdvPct: number | null = null;
                if (price != null && advPrice != null && advPrice > 0) {
                  vsAdvPct = Math.round(((price - advPrice) / advPrice) * 1000) / 10;
                }

                // Best available rate across all vendors
                const bestRate = hasAdvertised
                  ? lookupBestRate(advByAirportWeek, advByAirport, row.airport_code, row.invoice_date, row.gallons)
                  : null;
                let vsBestPct: number | null = null;
                if (price != null && bestRate && bestRate.price > 0) {
                  vsBestPct = Math.round(((price - bestRate.price) / bestRate.price) * 1000) / 10;
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
                const overpriced = vsBestPct != null && vsBestPct > 5;
                const underpriced = vsBestPct != null && vsBestPct < -5;

                // Salesperson lookup by tail + airport + date
                const spKey = row.tail_number && row.airport_code && row.invoice_date
                  ? `${row.tail_number}|${row.airport_code}|${row.invoice_date}` : null;
                const salesperson = spKey ? salespersonLookup.get(spKey) ?? null : null;

                return (
                  <tr
                    key={row.id}
                    className={`hover:bg-gray-50 ${
                      overpriced ? "bg-red-50/60" : underpriced ? "bg-green-50/60" : isJetInsight ? "bg-emerald-50/40" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">{fmtDate(row.invoice_date)}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap font-medium">{row.airport_code || "\u2014"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap max-w-[200px]" title={row.vendor_name || ""}>
                      <div className="truncate">{row.vendor_name || "\u2014"}</div>
                      {row.fuel_vendor && (
                        <div className="text-[10px] text-gray-400 font-normal truncate">{row.fuel_vendor}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">{row.tail_number || "\u2014"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">
                      {row.gallons != null ? Number(row.gallons).toFixed(0) : "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">
                      {fmt$(row.fuel_total, 2)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium bg-blue-50/40 border-l border-blue-100">
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
                        <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-blue-700 font-medium bg-blue-50/40">
                          {bestRate ? (
                            <span title={`${bestRate.vendor} contract rate`}>
                              {fmt$(bestRate.price)}
                              <div className="text-[10px] text-gray-400 font-normal">{bestRate.vendor}</div>
                            </span>
                          ) : <span className="text-gray-300">{"\u2014"}</span>}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right bg-blue-50/40 border-r border-blue-100">
                          {vsBestPct != null ? (
                            <Badge variant={vsBestPct > 2 ? "danger" : vsBestPct < -2 ? "success" : "default"}>
                              {vsBestPct >= 0 ? "+" : ""}{vsBestPct}%
                            </Badge>
                          ) : (
                            <span className="text-gray-300 text-xs">{"\u2014"}</span>
                          )}
                        </td>
                      </>
                    )}
                    <td className="px-4 py-2.5 whitespace-nowrap text-sm text-gray-600">
                      {salesperson || <span className="text-gray-300">{"\u2014"}</span>}
                    </td>
                    {showWoW && (
                      <>
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
                            <Badge variant={vsAvgPct > 5 ? "danger" : vsAvgPct < -5 ? "success" : "default"}>
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
                      </>
                    )}
                    <td className="px-4 py-2.5 whitespace-nowrap text-center">
                      {isJetInsight ? (
                        sourceBadge(row.data_source)
                      ) : (
                        <span className="inline-flex gap-2 text-xs">
                          {isBaseline && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-800">Baseline</span>
                          )}
                          <Link
                            href={`/invoices/${row.document_id}`}
                            className="text-blue-600 hover:text-blue-800 underline"
                            title="View this invoice"
                          >
                            Invoice
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
                  <td colSpan={99} className="px-4 py-8 text-center text-gray-400">
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
          {/* Vendor freshness */}
          {vendorFreshness.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-gray-500">Data as of:</span>
              {vendorFreshness.map(({ vendor, latestWeek }) => {
                const weekDate = new Date(latestWeek + "T12:00:00");
                const now = new Date();
                const daysOld = Math.floor((now.getTime() - weekDate.getTime()) / (1000 * 60 * 60 * 24));
                const isStale = daysOld > 10;
                const isRecent = daysOld < 7;
                return (
                  <span
                    key={vendor}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border ${
                      isStale
                        ? "bg-red-50 text-red-700 border-red-200"
                        : isRecent
                        ? "bg-green-50 text-green-700 border-green-200"
                        : "bg-amber-50 text-amber-700 border-amber-200"
                    }`}
                  >
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                      isStale ? "bg-red-400" : isRecent ? "bg-green-400" : "bg-amber-400"
                    }`} />
                    <span className="font-medium">{vendor}</span>
                    <span className="opacity-70">{fmtDate(latestWeek)}</span>
                    {vendorAvgWow.has(vendor) && (() => {
                      const avg = vendorAvgWow.get(vendor)!;
                      const color = avg > 0.5 ? "text-red-600" : avg < -0.5 ? "text-green-600" : "text-gray-500";
                      return (
                        <span className={`font-mono font-semibold ${color}`}>
                          {avg >= 0 ? "+" : ""}{avg}%
                        </span>
                      );
                    })()}
                  </span>
                );
              })}
            </div>
          )}

          <div className="rounded-xl border bg-white overflow-hidden shadow-sm overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Airport</th>
                  <th className="px-4 py-3">FBO / Vendors</th>
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
                    <span title="Average price actually paid at this airport during the same week (invoices + JetInsight)">Actual Paid</span>
                  </th>
                  <th className="px-4 py-3 text-right">
                    <span title="Actual vs current advertised: positive = paying more">vs Adv.</span>
                  </th>
                  <th className="px-4 py-3 text-right text-[10px] normal-case">Week of</th>
                  <th className="px-4 py-3 text-center">Invoice</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {advPageRows.map((row) => {
                  const absWow = row.wowChange != null ? Math.abs(row.wowChange) : 0;
                  // Green ≤$0.05, Yellow $0.06–$0.15, Red >$0.15
                  const wowColor = row.wowChange == null || absWow === 0
                    ? "text-gray-500"
                    : absWow <= 0.05
                    ? "text-green-600"
                    : absWow <= 0.15
                    ? "text-amber-600"
                    : "text-red-600";
                  const overActual = row.vsActualPct != null && row.vsActualPct > 2;
                  const underActual = row.vsActualPct != null && row.vsActualPct < -2;
                  const isCheapest = cheapestByAirport.get(row.airport) === row.currentPrice;
                  return (
                    <tr
                      key={row.key}
                      className={`hover:bg-gray-50 ${
                        isCheapest ? "bg-green-50/70" : overActual ? "bg-red-50/60" : underActual ? "bg-green-50/60" : ""
                      }`}
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap font-semibold">{row.airport}</td>
                      <td className="px-4 py-2.5 max-w-[280px] text-xs text-gray-600">
                        <div className="truncate font-medium">
                          {row.canonicalBrand ?? row.fboName ?? row.fboVendor}
                          {row.canonicalLocation && <span className="text-gray-400 font-normal ml-1">({row.canonicalLocation})</span>}
                        </div>
                        {row.vendorQuotes.length > 1 ? (
                          <div className="mt-0.5 space-y-0">
                            {row.vendorQuotes.map((q) => {
                              const isFboDirect = row.canonicalBrand
                                ? FBO_BRAND_PATTERNS.some(([pat, brand]) => brand === row.canonicalBrand && pat.test(q.fboVendor))
                                : false;
                              return (
                                <div key={q.fboVendor} className="flex items-center gap-1.5 text-[10px]">
                                  <span className={`truncate max-w-[100px] ${isFboDirect ? "text-indigo-600 font-semibold" : "text-gray-400"}`}>{q.fboVendor}</span>
                                  {isFboDirect && <span className="text-[8px] font-bold px-1 py-px rounded bg-indigo-100 text-indigo-700 shrink-0">FBO</span>}
                                  <span className="font-mono text-gray-500">{fmt$(q.currentPrice)}</span>
                                  <span className="text-gray-300">{q.volumeTier}</span>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-[10px] text-gray-400 truncate">
                            {row.fboVendor}
                            {row.canonicalBrand && FBO_BRAND_PATTERNS.some(([pat, brand]) => brand === row.canonicalBrand && pat.test(row.fboVendor))
                              && <span className="ml-1 text-[8px] font-bold px-1 py-px rounded bg-indigo-100 text-indigo-700">FBO</span>}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">{row.volumeTier}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-500 max-w-[120px] truncate" title={row.tailNumbers || "All"}>{row.tailNumbers || "All"}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium">
                        {(() => {
                          const weekDate = new Date(row.currentWeek + "T12:00:00");
                          const now = new Date();
                          const diffDays = Math.floor((now.getTime() - weekDate.getTime()) / 86400000);
                          const isStale = diffDays > 8;
                          return (
                            <span className={`${isCheapest ? "inline-flex items-center gap-1" : ""} ${isStale ? "text-amber-600" : "text-green-700"}`}>
                              {fmt$(row.currentPrice)}
                              {isStale && <span className="text-[9px] ml-1 opacity-70">({fmtDate(row.currentWeek)})</span>}
                              {isCheapest && <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-green-200 text-green-800">BEST</span>}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-gray-400">
                        {row.prevPrice != null ? fmt$(row.prevPrice) : <span className="text-gray-300">{"\u2014"}</span>}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right">
                        {row.wowChange != null ? (
                          absWow === 0 ? (
                            <span className="text-xs text-gray-400 font-medium">No Change</span>
                          ) : (
                            <span className={`font-mono text-xs font-medium ${wowColor}`}>
                              {row.wowChange > 0 ? "+" : ""}{row.wowChange.toFixed(4)}
                              <span className="text-[10px] ml-0.5 opacity-70">
                                ({row.wowChangePct! >= 0 ? "+" : ""}{row.wowChangePct}%)
                              </span>
                            </span>
                          )
                        ) : (
                          <span className="text-gray-300 text-xs">{"\u2014"}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium text-blue-700">
                        {row.recent7dAvg != null ? (
                          <span>
                            {fmt$(row.recent7dAvg)}
                            <span className="text-[10px] text-gray-400 ml-1">({row.recent7dCount})</span>
                          </span>
                        ) : (
                          <span className="text-gray-300">{"\u2014"}</span>
                        )}
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
                      <td className="px-4 py-2.5 whitespace-nowrap text-center">
                        {(() => {
                          const inv = latestInvoiceByAirport.get(row.airport);
                          return inv ? (
                            <Link
                              href={`/invoices/${inv.docId}`}
                              className="text-xs text-blue-600 hover:text-blue-800 underline"
                              title={`Latest invoice: ${fmtDate(inv.date)}`}
                            >
                              View
                            </Link>
                          ) : (
                            <span className="text-gray-300 text-xs">{"\u2014"}</span>
                          );
                        })()}
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

      {/* ─── Stats View ──────────────────────────────────────────── */}
      {viewMode === "stats" && (
        <>
          {/* Overall summary banner */}
          <div className="rounded-xl border bg-slate-50 shadow-sm px-5 py-4">
            <div className="flex flex-wrap items-center gap-6">
              <div>
                <div className="text-[10px] uppercase font-semibold text-gray-400">Overall Avg</div>
                <div className="text-lg font-mono font-bold text-gray-900">
                  {overallStats.currentAvg != null ? fmt$(overallStats.currentAvg) : "\u2014"}
                </div>
                <div className="text-[10px] text-gray-400">{overallStats.vendorCount} vendors</div>
              </div>
              <div>
                <div className="text-[10px] uppercase font-semibold text-gray-400">1-Week Change</div>
                {overallStats.weekChange$ != null ? (
                  <div className={`text-lg font-mono font-bold ${
                    overallStats.weekChange$ > 0 ? "text-red-600" : overallStats.weekChange$ < 0 ? "text-green-600" : "text-gray-700"
                  }`}>
                    {overallStats.weekChange$ > 0 ? "+" : ""}{overallStats.weekChange$.toFixed(4)}
                    <span className="text-sm ml-1 opacity-70">
                      ({overallStats.weekChangePct! >= 0 ? "+" : ""}{overallStats.weekChangePct}%)
                    </span>
                  </div>
                ) : <div className="text-lg text-gray-300">{"\u2014"}</div>}
              </div>
              <div>
                <div className="text-[10px] uppercase font-semibold text-gray-400">1-Month Change</div>
                {overallStats.monthChange$ != null ? (
                  <div className={`text-lg font-mono font-bold ${
                    overallStats.monthChange$ > 0 ? "text-red-600" : overallStats.monthChange$ < 0 ? "text-green-600" : "text-gray-700"
                  }`}>
                    {overallStats.monthChange$ > 0 ? "+" : ""}{overallStats.monthChange$.toFixed(4)}
                    <span className="text-sm ml-1 opacity-70">
                      ({overallStats.monthChangePct! >= 0 ? "+" : ""}{overallStats.monthChangePct}%)
                    </span>
                  </div>
                ) : <div className="text-lg text-gray-300">{"\u2014"}</div>}
              </div>
            </div>
          </div>

          {/* Vendor Price Changes Table */}
          <div className="rounded-xl border bg-white overflow-hidden shadow-sm overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3 text-right">Current Avg $/gal</th>
                  <th className="px-4 py-3 text-right">1-Week Change</th>
                  <th className="px-4 py-3 text-right">1-Month Change</th>
                  <th className="px-4 py-3 text-right text-[10px] normal-case">Prices This Week</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {vendorPriceStats.map((v) => (
                  <tr key={v.vendor} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 whitespace-nowrap font-medium">{v.vendor}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-medium">
                      {v.currentAvg != null ? fmt$(v.currentAvg) : <span className="text-gray-300">{"\u2014"}</span>}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right">
                      {v.weekChange$ != null ? (
                        <div>
                          <span className={`font-mono text-xs font-medium ${
                            v.weekChange$ > 0 ? "text-red-600" : v.weekChange$ < 0 ? "text-green-600" : "text-gray-500"
                          }`}>
                            {v.weekChange$ > 0 ? "+" : ""}{v.weekChange$.toFixed(4)}
                            {v.weekChangePct != null && (
                              <span className="text-[10px] ml-1 opacity-70">
                                ({v.weekChangePct >= 0 ? "+" : ""}{v.weekChangePct}%)
                              </span>
                            )}
                          </span>
                          {v.prevWeekAvg != null && (
                            <div className="text-[10px] text-gray-400 font-mono">
                              was {fmt$(v.prevWeekAvg)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-300 text-xs">{"\u2014"}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right">
                      {v.monthChange$ != null ? (
                        <div>
                          <span className={`font-mono text-xs font-medium ${
                            v.monthChange$ > 0 ? "text-red-600" : v.monthChange$ < 0 ? "text-green-600" : "text-gray-500"
                          }`}>
                            {v.monthChange$ > 0 ? "+" : ""}{v.monthChange$.toFixed(4)}
                            {v.monthChangePct != null && (
                              <span className="text-[10px] ml-1 opacity-70">
                                ({v.monthChangePct >= 0 ? "+" : ""}{v.monthChangePct}%)
                              </span>
                            )}
                          </span>
                          {v.monthAgoAvg != null && (
                            <div className="text-[10px] text-gray-400 font-mono">
                              was {fmt$(v.monthAgoAvg)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-300 text-xs">{"\u2014"}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right text-xs text-gray-500">
                      {v.rowCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* VNY & TEB: Jet Aviation vs Cheapest */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {airportJetComparisons.map((comp) => (
              <div key={comp.airport} className="rounded-xl border bg-white shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">{comp.airport}</h3>

                <div className="grid grid-cols-2 gap-4">
                  {/* Jet Aviation */}
                  <div>
                    <div className="text-[10px] uppercase font-semibold text-gray-400 mb-1">Jet Aviation</div>
                    <div className="text-lg font-mono font-bold text-gray-900">
                      {comp.jet.currentAvg != null ? fmt$(comp.jet.currentAvg) : "\u2014"}
                    </div>
                    <div className="mt-1 space-y-0.5">
                      <div className="text-xs">
                        <span className="text-gray-500">1 wk: </span>
                        {comp.jet.weekTrend.$ != null ? (
                          <span className={`font-mono font-medium ${comp.jet.weekTrend.$ > 0 ? "text-red-600" : comp.jet.weekTrend.$ < 0 ? "text-green-600" : "text-gray-500"}`}>
                            {comp.jet.weekTrend.$ > 0 ? "+" : ""}{comp.jet.weekTrend.$.toFixed(4)}
                            {comp.jet.weekTrend.pct != null && <span className="opacity-70"> ({comp.jet.weekTrend.pct >= 0 ? "+" : ""}{comp.jet.weekTrend.pct}%)</span>}
                          </span>
                        ) : <span className="text-gray-300">{"\u2014"}</span>}
                      </div>
                      <div className="text-xs">
                        <span className="text-gray-500">1 mo: </span>
                        {comp.jet.monthTrend.$ != null ? (
                          <span className={`font-mono font-medium ${comp.jet.monthTrend.$ > 0 ? "text-red-600" : comp.jet.monthTrend.$ < 0 ? "text-green-600" : "text-gray-500"}`}>
                            {comp.jet.monthTrend.$ > 0 ? "+" : ""}{comp.jet.monthTrend.$.toFixed(4)}
                            {comp.jet.monthTrend.pct != null && <span className="opacity-70"> ({comp.jet.monthTrend.pct >= 0 ? "+" : ""}{comp.jet.monthTrend.pct}%)</span>}
                          </span>
                        ) : <span className="text-gray-300">{"\u2014"}</span>}
                      </div>
                    </div>
                  </div>

                  {/* Cheapest */}
                  <div>
                    <div className="text-[10px] uppercase font-semibold text-gray-400 mb-1">
                      Cheapest{comp.cheapest.vendor ? ` (${comp.cheapest.vendor})` : ""}
                    </div>
                    <div className="text-lg font-mono font-bold text-green-700">
                      {comp.cheapest.currentPrice != null ? fmt$(comp.cheapest.currentPrice) : "\u2014"}
                    </div>
                    <div className="mt-1 space-y-0.5">
                      <div className="text-xs">
                        <span className="text-gray-500">1 wk: </span>
                        {comp.cheapest.weekTrend.$ != null ? (
                          <span className={`font-mono font-medium ${comp.cheapest.weekTrend.$ > 0 ? "text-red-600" : comp.cheapest.weekTrend.$ < 0 ? "text-green-600" : "text-gray-500"}`}>
                            {comp.cheapest.weekTrend.$ > 0 ? "+" : ""}{comp.cheapest.weekTrend.$.toFixed(4)}
                            {comp.cheapest.weekTrend.pct != null && <span className="opacity-70"> ({comp.cheapest.weekTrend.pct >= 0 ? "+" : ""}{comp.cheapest.weekTrend.pct}%)</span>}
                          </span>
                        ) : <span className="text-gray-300">{"\u2014"}</span>}
                      </div>
                      <div className="text-xs">
                        <span className="text-gray-500">1 mo: </span>
                        {comp.cheapest.monthTrend.$ != null ? (
                          <span className={`font-mono font-medium ${comp.cheapest.monthTrend.$ > 0 ? "text-red-600" : comp.cheapest.monthTrend.$ < 0 ? "text-green-600" : "text-gray-500"}`}>
                            {comp.cheapest.monthTrend.$ > 0 ? "+" : ""}{comp.cheapest.monthTrend.$.toFixed(4)}
                            {comp.cheapest.monthTrend.pct != null && <span className="opacity-70"> ({comp.cheapest.monthTrend.pct >= 0 ? "+" : ""}{comp.cheapest.monthTrend.pct}%)</span>}
                          </span>
                        ) : <span className="text-gray-300">{"\u2014"}</span>}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Savings callout */}
                {comp.savings$ != null && (
                  <div className={`mt-3 rounded-lg px-3 py-2 text-xs font-medium ${
                    comp.savings$ > 0
                      ? "bg-amber-50 text-amber-800 border border-amber-200"
                      : "bg-green-50 text-green-800 border border-green-200"
                  }`}>
                    {comp.savings$ > 0
                      ? `Jet Aviation is ${fmt$(comp.savings$)}/gal more expensive (${fmtPct(comp.savingsPct)})`
                      : comp.savings$ < 0
                      ? `Jet Aviation is ${fmt$(Math.abs(comp.savings$))}/gal cheaper`
                      : "Same price as cheapest option"}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Pagination */}
      {activeTotalPages > 1 && viewMode !== "stats" && (
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
