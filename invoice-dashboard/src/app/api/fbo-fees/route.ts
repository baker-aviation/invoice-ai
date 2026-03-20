import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/fbo-fees
 *
 * Aggregates FBO fee data from parsed invoices:
 * - FBO fees from parsed_invoices (doc_type = 'fbo_fee') line items
 * - Fuel prices from the fuel_prices table
 *
 * Returns per-airport, per-vendor summaries with most recent fees and avg fuel prices.
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

  // 2. Get fuel prices
  const { data: fuelPrices, error: fuelErr } = await supa
    .from("fuel_prices")
    .select("airport_code, vendor_name, invoice_date, base_price_per_gallon, effective_price_per_gallon, gallons, has_additive")
    .not("airport_code", "is", null)
    .order("invoice_date", { ascending: false })
    .limit(5000);

  if (fuelErr) {
    return NextResponse.json({ error: fuelErr.message }, { status: 500 });
  }

  // 3. Extract fees from line items
  const fees: FeeExtract[] = [];
  for (const inv of fboInvoices ?? []) {
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

  // 4. Aggregate fees: per airport+vendor, keep most recent of each fee type
  type AirportVendorKey = string;
  type FeeAgg = Record<string, { amount: number; date: string }>;
  const feeMap = new Map<AirportVendorKey, { vendor: string; airport: string; fees: FeeAgg }>();

  for (const f of fees) {
    const key = `${f.airport_code}|${f.vendor_name}`;
    if (!feeMap.has(key)) {
      feeMap.set(key, { vendor: f.vendor_name, airport: f.airport_code, fees: {} });
    }
    const entry = feeMap.get(key)!;
    const existing = entry.fees[f.fee_type];
    // Keep the most recent
    if (!existing || f.invoice_date > existing.date) {
      entry.fees[f.fee_type] = { amount: f.amount, date: f.invoice_date };
    }
  }

  // 5. Aggregate fuel prices: per airport, most recent + average
  type FuelAgg = {
    vendor: string;
    latest_price: number;
    latest_date: string;
    avg_price: number;
    count: number;
    has_additive: boolean;
  };
  const fuelMap = new Map<string, FuelAgg[]>();

  // Group by airport+vendor
  const fuelByAV = new Map<string, typeof fuelPrices>();
  for (const fp of fuelPrices ?? []) {
    const key = `${(fp.airport_code ?? "").toUpperCase()}|${fp.vendor_name ?? ""}`;
    if (!fuelByAV.has(key)) fuelByAV.set(key, []);
    fuelByAV.get(key)!.push(fp);
  }

  for (const [key, records] of fuelByAV) {
    const [airport] = key.split("|");
    const sorted = records.sort((a: any, b: any) => (b.invoice_date ?? "").localeCompare(a.invoice_date ?? ""));
    const latest = sorted[0];
    const prices = sorted.map((r: any) => r.effective_price_per_gallon ?? r.base_price_per_gallon).filter(Boolean);
    const avg = prices.length > 0 ? prices.reduce((a: number, b: number) => a + b, 0) / prices.length : 0;

    if (!fuelMap.has(airport)) fuelMap.set(airport, []);
    fuelMap.get(airport)!.push({
      vendor: latest.vendor_name ?? "",
      latest_price: latest.effective_price_per_gallon ?? latest.base_price_per_gallon ?? 0,
      latest_date: latest.invoice_date ?? "",
      avg_price: avg,
      count: prices.length,
      has_additive: latest.has_additive ?? false,
    });
  }

  // 6. Build response
  const result = {
    fees: Array.from(feeMap.values()).map((e) => ({
      airport_code: e.airport,
      vendor_name: e.vendor,
      ...Object.fromEntries(
        Object.entries(e.fees).map(([k, v]) => [k, v.amount])
      ),
      latest_fee_date: Object.values(e.fees).reduce(
        (max, v) => (v.date > max ? v.date : max),
        ""
      ),
    })),
    fuel: Array.from(fuelMap.entries()).flatMap(([airport, vendors]) =>
      vendors.map((v) => ({
        airport_code: airport,
        vendor_name: v.vendor,
        latest_price: v.latest_price,
        latest_date: v.latest_date,
        avg_price: v.avg_price,
        invoice_count: v.count,
        has_additive: v.has_additive,
      }))
    ),
  };

  return NextResponse.json(result);
}
