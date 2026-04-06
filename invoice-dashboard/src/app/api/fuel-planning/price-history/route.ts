import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/fuel-planning/price-history?airports=HPN,TEB,BOS&limit=5
 *
 * Returns recent fuel price history at given airports.
 * NO AUTH REQUIRED — used by shareable plan pages.
 */
export async function GET(req: NextRequest) {
  const airportsParam = req.nextUrl.searchParams.get("airports") ?? "";
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "5", 10), 20);

  const airports = airportsParam
    .split(",")
    .map((a) => a.trim().toUpperCase())
    .filter(Boolean);

  if (!airports.length) {
    return NextResponse.json({ ok: true, history: {} });
  }

  const supa = createServiceClient();

  // Expand variants: HPN → [HPN, KHPN]
  const allVariants: string[] = [];
  for (const ap of airports) {
    allVariants.push(ap);
    if (ap.length === 3) allVariants.push(`K${ap}`);
    if (ap.length === 4 && ap.startsWith("K")) allVariants.push(ap.slice(1));
  }

  const { data: rows } = await supa
    .from("fuel_prices")
    .select("airport_code, vendor_name, effective_price_per_gallon, gallons, invoice_date, tail_number")
    .in("airport_code", allVariants)
    .order("invoice_date", { ascending: false })
    .limit(limit * airports.length * 2);

  // Group by normalized airport
  const history: Record<string, {
    avgPrice: number;
    minPrice: number;
    maxPrice: number;
    recentPrices: Array<{ price: number; vendor: string; date: string; gallons: number; tail: string }>;
  }> = {};

  const normalize = (c: string) => c.length === 4 && c.startsWith("K") ? c.slice(1) : c;

  for (const row of rows ?? []) {
    const ap = normalize(row.airport_code);
    if (!history[ap]) {
      history[ap] = { avgPrice: 0, minPrice: Infinity, maxPrice: 0, recentPrices: [] };
    }
    const h = history[ap];
    const price = Number(row.effective_price_per_gallon);
    if (h.recentPrices.length < limit) {
      h.recentPrices.push({
        price,
        vendor: row.vendor_name,
        date: row.invoice_date,
        gallons: Number(row.gallons),
        tail: row.tail_number,
      });
    }
  }

  // Compute averages
  for (const ap of Object.keys(history)) {
    const prices = history[ap].recentPrices.map((p) => p.price);
    history[ap].avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    history[ap].minPrice = prices.length > 0 ? Math.min(...prices) : 0;
    history[ap].maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
  }

  return NextResponse.json({ ok: true, history });
}
