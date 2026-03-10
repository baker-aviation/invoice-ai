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
 * Uses the most recent week available in the data.
 */
export function buildBestRateByAirport(
  advertisedPrices: AdvertisedPriceRow[],
): Map<string, BestRate> {
  if (!advertisedPrices.length) return new Map();

  // Find the most recent week_start in the dataset
  let latestWeek = "";
  for (const a of advertisedPrices) {
    if (a.week_start > latestWeek) latestWeek = a.week_start;
  }

  // Filter to latest week, skip tail-specific rows
  const recent = advertisedPrices.filter(
    (a) => a.week_start === latestWeek && !a.tail_numbers,
  );

  // Group by normalized airport, find cheapest
  const result = new Map<string, BestRate>();

  for (const row of recent) {
    const variants = airportVariants(row.airport_code);
    for (const code of variants) {
      const existing = result.get(code);
      if (!existing || row.price < existing.price) {
        result.set(code, { price: row.price, vendor: row.fbo_vendor, fbo: extractFboName(row.product) });
      }
    }
  }

  return result;
}
