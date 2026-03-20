import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/fbo-fees
 *
 * Returns FBO fee data from invoices + contract fuel from price sheets.
 * All airport codes normalized to FAA (strip leading K for US ICAO).
 */

type LineItem = {
  description?: string;
  category?: string;
  quantity?: number;
  unit_price?: number;
  total?: number;
};

const FEE_PATTERNS: [RegExp, string][] = [
  [/handl(ing)?\s*fee/i, "handling_fee"],
  [/facilit(y|ies)\s*fee/i, "facility_fee"],
  [/ramp\s*(fee|handl)/i, "handling_fee"],
  [/secur(ity)?\s*fee/i, "security_fee"],
  [/infra(structure)?\s*fee/i, "infrastructure_fee"],
  [/gpu|ground\s*power/i, "gpu_fee"],
  [/hangar/i, "hangar_fee"],
  [/lav(atory)?\s*(service|dump|fee)/i, "lavatory_fee"],
  [/water\s*serv/i, "water_fee"],
  [/park(ing)?\s*(fee)?/i, "parking_fee"],
  [/overnight/i, "overnight_fee"],
  [/landing\s*fee/i, "landing_fee"],
  [/de.?ic(e|ing)/i, "deice_fee"],
  [/cater(ing)?/i, "catering_fee"],
];

const SELF_VENDORS = /baker\s*aviation/i;

/** Normalize airport code: KVNY → VNY, KTEB → TEB, but PHNL stays PHNL */
function normAirport(code: string): string {
  const c = (code ?? "").toUpperCase().trim();
  // US ICAO codes start with K + 3 letters. Don't strip K from non-US (e.g. KJFK→JFK but LFPG stays)
  if (c.length === 4 && c.startsWith("K") && /^K[A-Z]{3}$/.test(c)) return c.slice(1);
  return c;
}

/** Clean product name: strip FBO/airport from the product string */
function cleanProduct(product: string): string {
  // "JET-A+FSII (JET AVIATION KVNY)" → "Jet-A+FSII"
  return product.replace(/\s*\([^)]*\)\s*/g, "").trim();
}

function classifyFee(desc: string): string | null {
  for (const [pattern, feeType] of FEE_PATTERNS) {
    if (pattern.test(desc)) return feeType;
  }
  return null;
}

export async function GET() {
  const supa = createServiceClient();

  const [{ data: fboInvoices, error: fboErr }, { data: advPrices, error: advErr }] = await Promise.all([
    supa
      .from("parsed_invoices")
      .select("airport_code, vendor_name, invoice_date, line_items")
      .eq("doc_type", "fbo_fee")
      .not("airport_code", "is", null)
      .not("line_items", "is", null)
      .order("invoice_date", { ascending: false })
      .limit(2000),
    supa
      .from("fbo_advertised_prices")
      .select("fbo_vendor, airport_code, volume_tier, product, price, week_start")
      .order("week_start", { ascending: false })
      .limit(5000),
  ]);

  if (fboErr) return NextResponse.json({ error: fboErr.message }, { status: 500 });
  if (advErr) return NextResponse.json({ error: advErr.message }, { status: 500 });

  // Extract fees per airport+vendor (keeping vendor so we can match to FBOs)
  type FeeAgg = Record<string, { amount: number; date: string }>;
  const feeMap = new Map<string, { vendor: string; airport: string; fees: FeeAgg }>();

  for (const inv of fboInvoices ?? []) {
    if (SELF_VENDORS.test(inv.vendor_name ?? "")) continue;
    const airport = normAirport(inv.airport_code ?? "");
    const vendor = inv.vendor_name ?? "";
    const key = `${airport}|${vendor}`;

    if (!feeMap.has(key)) feeMap.set(key, { vendor, airport, fees: {} });
    const entry = feeMap.get(key)!;

    const items: LineItem[] = Array.isArray(inv.line_items) ? inv.line_items : [];
    for (const item of items) {
      const desc = item.description || item.category || "";
      const amount = item.total ?? item.unit_price ?? 0;
      if (!desc || !amount || amount <= 0) continue;
      const feeType = classifyFee(desc);
      if (!feeType) continue;
      const existing = entry.fees[feeType];
      if (!existing || (inv.invoice_date ?? "") > existing.date) {
        entry.fees[feeType] = { amount, date: inv.invoice_date ?? "" };
      }
    }
  }

  // Fuel prices — normalize airport codes and clean product names
  type FuelEntry = {
    vendor: string;
    product: string;
    price: number;
    volume_tier: string;
    week_start: string;
  };
  const fuelMap = new Map<string, FuelEntry[]>();
  const seenFuel = new Set<string>();

  for (const row of advPrices ?? []) {
    const airport = normAirport(row.airport_code ?? "");
    const product = cleanProduct(row.product ?? "");
    const key = `${airport}|${row.fbo_vendor}|${product}|${row.volume_tier}`;
    if (seenFuel.has(key)) continue;
    seenFuel.add(key);

    if (!fuelMap.has(airport)) fuelMap.set(airport, []);
    fuelMap.get(airport)!.push({
      vendor: row.fbo_vendor ?? "",
      product,
      price: row.price ?? 0,
      volume_tier: row.volume_tier ?? "",
      week_start: row.week_start ?? "",
    });
  }

  return NextResponse.json({
    fees: Array.from(feeMap.values()).map((e) => ({
      airport_code: e.airport,
      vendor_name: e.vendor,
      ...Object.fromEntries(Object.entries(e.fees).map(([k, v]) => [k, v.amount])),
      latest_fee_date: Object.values(e.fees).reduce((max, v) => (v.date > max ? v.date : max), ""),
    })),
    fuel: Array.from(fuelMap.entries()).flatMap(([airport, entries]) =>
      entries.map((e) => ({
        airport_code: airport,
        vendor: e.vendor,
        product: e.product,
        price: e.price,
        volume_tier: e.volume_tier,
        week_start: e.week_start,
      }))
    ),
  });
}
