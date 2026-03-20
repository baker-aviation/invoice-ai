import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/fbo-fees
 *
 * Aggregates FBO fee data from parsed invoices and advertised fuel prices:
 * - FBO fees from parsed_invoices (doc_type = 'fbo_fee') line items
 * - Fuel prices from fbo_advertised_prices (the weekly fuel price sheet uploads)
 *
 * Fees are aggregated per airport (not per vendor) — one card per fee type.
 * "Baker Aviation" invoices are treated as the FBO at that airport, not as a vendor.
 */

type LineItem = {
  description?: string;
  category?: string;
  quantity?: number;
  unit_price?: number;
  total?: number;
  uom?: string;
  unit?: string;
};

type FeeExtract = {
  airport_code: string;
  vendor_name: string;
  invoice_date: string;
  fee_type: string;
  amount: number;
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

// Skip invoices where "vendor" is actually us
const SELF_VENDORS = /baker\s*aviation/i;

function classifyFee(desc: string): string | null {
  for (const [pattern, feeType] of FEE_PATTERNS) {
    if (pattern.test(desc)) return feeType;
  }
  return null;
}

export async function GET() {
  const supa = createServiceClient();

  // 1. Get FBO fee invoices with line items
  const { data: fboInvoices, error: fboErr } = await supa
    .from("parsed_invoices")
    .select("airport_code, vendor_name, invoice_date, line_items")
    .eq("doc_type", "fbo_fee")
    .not("airport_code", "is", null)
    .not("line_items", "is", null)
    .order("invoice_date", { ascending: false })
    .limit(2000);

  if (fboErr) {
    return NextResponse.json({ error: fboErr.message }, { status: 500 });
  }

  // 2. Get advertised fuel prices (from fuel price sheet uploads)
  const { data: advPrices, error: advErr } = await supa
    .from("fbo_advertised_prices")
    .select("fbo_vendor, airport_code, volume_tier, product, price, week_start")
    .order("week_start", { ascending: false })
    .limit(5000);

  if (advErr) {
    return NextResponse.json({ error: advErr.message }, { status: 500 });
  }

  // 3. Extract fees from line items, skipping self-vendor invoices
  const fees: FeeExtract[] = [];
  for (const inv of fboInvoices ?? []) {
    if (SELF_VENDORS.test(inv.vendor_name ?? "")) continue;

    const items: LineItem[] = Array.isArray(inv.line_items) ? inv.line_items : [];
    for (const item of items) {
      const desc = item.description || item.category || "";
      const amount = item.total ?? item.unit_price ?? 0;
      if (!desc || !amount || amount <= 0) continue;

      const feeType = classifyFee(desc);
      if (feeType) {
        fees.push({
          airport_code: (inv.airport_code ?? "").toUpperCase(),
          vendor_name: inv.vendor_name ?? "",
          invoice_date: inv.invoice_date ?? "",
          fee_type: feeType,
          amount,
        });
      }
    }
  }

  // 4. Aggregate fees per AIRPORT (not per vendor) — keep most recent of each fee type
  type FeeAgg = Record<string, { amount: number; date: string; vendor: string }>;
  const feeMap = new Map<string, FeeAgg>();

  for (const f of fees) {
    if (!feeMap.has(f.airport_code)) feeMap.set(f.airport_code, {});
    const entry = feeMap.get(f.airport_code)!;
    const existing = entry[f.fee_type];
    if (!existing || f.invoice_date > existing.date) {
      entry[f.fee_type] = { amount: f.amount, date: f.invoice_date, vendor: f.vendor_name };
    }
  }

  // 5. Aggregate advertised fuel prices per airport+vendor — most recent week only
  type FuelEntry = {
    vendor: string;
    product: string;
    price: number;
    volume_tier: string;
    week_start: string;
  };
  const fuelMap = new Map<string, FuelEntry[]>();

  // Group by airport+vendor+product, keep most recent week
  const seenFuel = new Set<string>();
  for (const row of advPrices ?? []) {
    const airport = (row.airport_code ?? "").toUpperCase();
    const key = `${airport}|${row.fbo_vendor}|${row.product}|${row.volume_tier}`;
    if (seenFuel.has(key)) continue; // already have newer week
    seenFuel.add(key);

    if (!fuelMap.has(airport)) fuelMap.set(airport, []);
    fuelMap.get(airport)!.push({
      vendor: row.fbo_vendor ?? "",
      product: row.product ?? "",
      price: row.price ?? 0,
      volume_tier: row.volume_tier ?? "",
      week_start: row.week_start ?? "",
    });
  }

  // 6. Build response
  const result = {
    fees: Array.from(feeMap.entries()).map(([airport, feeAgg]) => ({
      airport_code: airport,
      ...Object.fromEntries(
        Object.entries(feeAgg).map(([feeType, v]) => [feeType, v.amount])
      ),
      latest_fee_date: Object.values(feeAgg).reduce(
        (max, v) => (v.date > max ? v.date : max),
        ""
      ),
      fee_vendor: Object.values(feeAgg)[0]?.vendor ?? "",
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
  };

  return NextResponse.json(result);
}
