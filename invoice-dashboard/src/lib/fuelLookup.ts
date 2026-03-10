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

export type BestRate = { price: number; vendor: string; fbo: string | null };

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
