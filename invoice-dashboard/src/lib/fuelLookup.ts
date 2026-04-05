import type { AdvertisedPriceRow } from "@/lib/types";

/** Get the Monday of the week containing a date string */
export function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}

/** Normalize airport codes: KTEB↔TEB, KHOU↔HOU etc. */
export function airportVariants(code: string): string[] {
  const up = code.toUpperCase();
  if (up.length === 4 && up.startsWith("K")) return [up, up.slice(1)];
  if (up.length === 3) return [up, `K${up}`];
  return [up];
}

/** Extract FBO name from product field: "Jet (Atlantic Aviation - HOU)" → "Atlantic Aviation - HOU" */
function extractFboName(product: string): string | null {
  const m = product.match(/\(([^)]+)\)/);
  return m ? m[1] : null;
}

export type BestRate = { price: number; vendor: string; fbo: string | null; tier?: string };

/**
 * Build a map of airport → best (cheapest) advertised fuel rate.
 * Per airport, uses only the most recent week available for that airport,
 * then picks the cheapest option within that week.
 */
export function buildBestRateByAirport(
  advertisedPrices: AdvertisedPriceRow[],
): Map<string, BestRate> {
  if (!advertisedPrices.length) return new Map();

  // Skip tail-specific rows
  const general = advertisedPrices.filter((a) => !a.tail_numbers);

  // Group by normalized airport → find latest week per airport → cheapest in that week
  const byAirport = new Map<string, AdvertisedPriceRow[]>();
  for (const row of general) {
    const norm = row.airport_code.toUpperCase();
    const key = norm.length === 4 && norm.startsWith("K") ? norm.slice(1) : norm;
    if (!byAirport.has(key)) byAirport.set(key, []);
    byAirport.get(key)!.push(row);
  }

  const result = new Map<string, BestRate>();

  for (const [normCode, rows] of byAirport) {
    // Find the most recent week for this airport
    let latestWeek = "";
    for (const r of rows) {
      if (r.week_start > latestWeek) latestWeek = r.week_start;
    }
    // Cheapest in that week
    let best: AdvertisedPriceRow | null = null;
    for (const r of rows) {
      if (r.week_start === latestWeek && (!best || r.price < best.price)) {
        best = r;
      }
    }
    if (!best) continue;
    const rate: BestRate = { price: best.price, vendor: best.fbo_vendor, fbo: extractFboName(best.product) };
    // Store under both ICAO variants
    for (const code of airportVariants(normCode)) {
      result.set(code, rate);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// FBO-specific fuel price lookup
// ---------------------------------------------------------------------------

/** Check if a fuel vendor name IS the same chain as the FBO (for FBO's own fuel) */
function vendorIsFbo(vendor: string, fboName: string): boolean {
  const v = vendor.toLowerCase();
  const f = fboName.toLowerCase();
  // Match key chain words
  if (f.includes("atlantic") && v.includes("atlantic")) return true;
  if (f.includes("signature") && v.includes("signature")) return true;
  if (f.includes("jet aviation") && v.includes("jet aviation")) return true;
  if (f.includes("million air") && v.includes("million air")) return true;
  if (f.includes("sheltair") && v.includes("sheltair")) return true;
  return false;
}

// Patterns to match JetInsight FBO names to product field FBO references
const FBO_MATCH_PATTERNS: Array<{ pattern: RegExp; keywords: string[] }> = [
  { pattern: /atlantic/i, keywords: ["atlantic"] },
  { pattern: /signature.*east/i, keywords: ["signature", "east"] },
  { pattern: /signature.*west|meridian/i, keywords: ["signature", "west"] },
  { pattern: /signature.*south/i, keywords: ["signature", "south"] },
  { pattern: /signature.*terminal\s*4/i, keywords: ["signature", "terminal 4"] },
  { pattern: /signature/i, keywords: ["signature"] }, // generic Signature (must come after specific ones)
  { pattern: /jet\s*aviation/i, keywords: ["jet aviation"] },
  { pattern: /million\s*air/i, keywords: ["million air"] },
  { pattern: /sheltair/i, keywords: ["sheltair"] },
  { pattern: /clay\s*lacy/i, keywords: ["clay lacy"] },
  { pattern: /castle.*cooke/i, keywords: ["castle", "cooke"] },
  { pattern: /cutter/i, keywords: ["cutter"] },
  { pattern: /kaiser/i, keywords: ["kaiser"] },
  { pattern: /pentastar/i, keywords: ["pentastar"] },
  { pattern: /modern/i, keywords: ["modern"] },
  { pattern: /ross/i, keywords: ["ross"] },
  { pattern: /premier/i, keywords: ["premier"] },
];

/**
 * Check if an advertised price row's product field matches a given FBO name.
 * e.g. fboName="Signature Aviation East" matches product="Jet-A (SIGNATURE FLIGHT SUPPORT EAST/WEST)"
 *
 * IMPORTANT: Must NOT match across different chains.
 * "Atlantic Aviation" product must NOT match "Jet Aviation" FBO, even though both contain "aviation".
 */
function productMatchesFbo(product: string, fboName: string): boolean {
  // Extract the FBO reference from parentheses — this is what we match against
  const fboRef = extractFboName(product)?.toLowerCase();
  if (!fboRef) {
    // No FBO in product (e.g. "Jet-A" or "JETA") — this is the FBO's own fuel
    // Match only if the vendor IS the FBO chain (handled by caller checking fbo_vendor)
    return false;
  }

  const fboLower = fboName.toLowerCase();

  // Use pattern-based matching — specific patterns prevent cross-chain matches
  for (const { pattern, keywords } of FBO_MATCH_PATTERNS) {
    if (pattern.test(fboName)) {
      // ALL keywords must be present in the product's FBO reference
      if (keywords.every((kw) => fboRef.includes(kw))) return true;
      // If pattern matched the FBO name but keywords don't match the product, stop here
      // This prevents "jet aviation" FBO from falling through to match "atlantic aviation" product
      return false;
    }
  }

  return false;
}

/** Parse volume tier string "301-800" or "1+" or "1-300" into { min, max } gallons */
function parseTier(tier: string): { min: number; max: number } {
  const plus = tier.match(/^(\d+)\+$/);
  if (plus) return { min: parseInt(plus[1]), max: Infinity };

  const range = tier.match(/^(\d+)[–\-](\d+)$/);
  if (range) return { min: parseInt(range[1]), max: parseInt(range[2]) };

  // Default/unknown
  return { min: 0, max: Infinity };
}

/**
 * Find the best fuel price at a specific FBO for a given fuel quantity.
 *
 * @param advertisedPrices - all advertised prices (pre-fetched)
 * @param airport - ICAO code (KTEB, TEB, etc.)
 * @param fboName - JetInsight FBO name (e.g. "Signature Aviation East")
 * @param expectedGallons - expected fuel order in gallons (for volume tier matching)
 * @returns best rate at that FBO, or null if no match
 */
export function getBestRateAtFbo(
  advertisedPrices: AdvertisedPriceRow[],
  airport: string,
  fboName: string | null,
  expectedGallons: number,
): BestRate | null {
  if (!fboName || !advertisedPrices.length) return null;

  const variants = airportVariants(airport);

  // Filter to this airport, non-tail-specific, Jet-A only
  const atAirport = advertisedPrices.filter((r) =>
    !r.tail_numbers &&
    variants.some((v) => r.airport_code.toUpperCase() === v) &&
    /jet/i.test(r.product) &&
    !/saf/i.test(r.product),
  );

  if (!atAirport.length) return null;

  // Find latest week at this airport
  let latestWeek = "";
  for (const r of atAirport) {
    if (r.week_start > latestWeek) latestWeek = r.week_start;
  }

  // Filter to latest week + matching FBO
  // Two match types:
  // 1. Product has FBO in parentheses → productMatchesFbo checks it
  // 2. Product has NO parentheses (FBO's own fuel) → vendor name must match the FBO chain
  const candidates = atAirport.filter((r) => {
    if (r.week_start !== latestWeek) return false;
    // Check if product references a specific FBO
    if (productMatchesFbo(r.product, fboName)) return true;
    // Check if this is the FBO's own fuel (no parentheses, vendor IS the FBO)
    if (!extractFboName(r.product)) {
      return vendorIsFbo(r.fbo_vendor, fboName);
    }
    return false;
  });

  if (!candidates.length) return null;

  // Find cheapest price where expected gallons falls within the volume tier
  let best: AdvertisedPriceRow | null = null;

  for (const r of candidates) {
    const { min, max } = parseTier(r.volume_tier);
    if (expectedGallons >= min && expectedGallons <= max) {
      if (!best || r.price < best.price) best = r;
    }
  }

  // If no tier match for exact gallons, fall back to the tier that gives cheapest price
  // (user might buy more to hit a cheaper tier — optimizer handles this)
  if (!best) {
    for (const r of candidates) {
      if (!best || r.price < best.price) best = r;
    }
  }

  if (!best) return null;

  return {
    price: best.price,
    vendor: best.fbo_vendor,
    fbo: extractFboName(best.product),
    tier: best.volume_tier,
  };
}

/**
 * Get all available fuel options at a specific FBO (all vendors, all tiers).
 * Useful for the review page to show what was available.
 */
export function getAllRatesAtFbo(
  advertisedPrices: AdvertisedPriceRow[],
  airport: string,
  fboName: string | null,
): Array<BestRate & { tier: string }> {
  if (!fboName || !advertisedPrices.length) return [];

  const variants = airportVariants(airport);

  const atAirport = advertisedPrices.filter((r) =>
    !r.tail_numbers &&
    variants.some((v) => r.airport_code.toUpperCase() === v) &&
    /jet/i.test(r.product) &&
    !/saf/i.test(r.product),
  );

  let latestWeek = "";
  for (const r of atAirport) {
    if (r.week_start > latestWeek) latestWeek = r.week_start;
  }

  return atAirport
    .filter((r) => r.week_start === latestWeek && productMatchesFbo(r.product, fboName))
    .map((r) => ({
      price: r.price,
      vendor: r.fbo_vendor,
      fbo: extractFboName(r.product),
      tier: r.volume_tier,
    }))
    .sort((a, b) => a.price - b.price);
}
