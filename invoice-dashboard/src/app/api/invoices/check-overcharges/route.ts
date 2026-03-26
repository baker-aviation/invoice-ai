import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const maxDuration = 60;

/**
 * POST /api/invoices/check-overcharges
 *
 * Compare recent FBO invoice line items against published rates in fbo_handling_fees.
 * Creates invoice_alerts for fees $150+ over published rate.
 *
 * Query params:
 *   since=24h (default) — lookback window (e.g. "24h", "7d")
 */

// Fee pattern classifier — matches invoice line item descriptions to DB column names
const FEE_PATTERNS: [RegExp, string][] = [
  [/handl(ing)?\s*(fee|charge)/i, "facility_fee"],
  [/facilit(y|ies)\s*(fee|charge)/i, "facility_fee"],
  [/ramp\s*(fee|handl|charge)/i, "facility_fee"],
  [/secur(ity)?\s*(fee|charge)/i, "security_fee"],
  [/infra(structure)?\s*(fee|charge)/i, "security_fee"],
  [/landing\s*(fee|charge)/i, "landing_fee"],
  [/overnight\s*(fee|charge|park)/i, "overnight_fee"],
  [/park(ing)?\s*(fee|charge)/i, "overnight_fee"],
  [/hangar\s*(fee|charge|rent)/i, "hangar_fee"],
  [/gpu|ground\s*power/i, "gpu_fee"],
  [/lav(atory)?\s*(service|dump|fee|charge)/i, "lavatory_fee"],
];

// Maps fbo_handling_fees column → human-readable name for alert messages
const FEE_LABELS: Record<string, string> = {
  facility_fee: "Facility/Handling fee",
  security_fee: "Security fee",
  landing_fee: "Landing fee",
  overnight_fee: "Overnight/Parking fee",
  hangar_fee: "Hangar fee",
  gpu_fee: "GPU fee",
  lavatory_fee: "Lavatory fee",
};

const OVERAGE_THRESHOLD_DOLLARS = 150; // $150 above published rate
const OVERCHARGE_RULE_ID = "3ed2d1a9-7fb1-4a5a-9fba-5b4e7ae41dd8"; // "Fee Overcharge" in invoice_alert_rules

function classifyFee(desc: string): string | null {
  for (const [pattern, feeType] of FEE_PATTERNS) {
    if (pattern.test(desc)) return feeType;
  }
  return null;
}

function normAirport(code: string): string {
  const c = (code ?? "").toUpperCase().trim();
  if (c.length === 4 && c.startsWith("K") && /^K[A-Z]{3}$/.test(c)) return c.slice(1);
  return c;
}

function parseLookback(since: string): number {
  const m = since.match(/^(\d+)(h|d)$/);
  if (!m) return 24 * 3600_000; // default 24h
  const val = parseInt(m[1]);
  return m[2] === "d" ? val * 24 * 3600_000 : val * 3600_000;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const since = req.nextUrl.searchParams.get("since") ?? "24h";
  const lookbackMs = parseLookback(since);
  const cutoff = new Date(Date.now() - lookbackMs).toISOString();

  // 1. Fetch recent FBO invoices with line items
  const { data: invoices, error: invErr } = await supa
    .from("parsed_invoices")
    .select("id, document_id, vendor_name, airport_code, tail_number, invoice_number, invoice_date, line_items, created_at")
    .eq("doc_type", "fbo_fee")
    .gte("created_at", cutoff)
    .not("line_items", "is", null)
    .not("airport_code", "is", null);

  if (invErr) {
    return NextResponse.json({ error: invErr.message }, { status: 500 });
  }
  if (!invoices || invoices.length === 0) {
    return NextResponse.json({ ok: true, invoices_checked: 0, alerts_created: 0 });
  }

  // 2. Fetch all published FBO rates
  const { data: fboRates } = await supa
    .from("fbo_handling_fees")
    .select("airport_code, fbo_name, chain, aircraft_type, facility_fee, security_fee, landing_fee, overnight_fee, hangar_fee, gpu_fee, lavatory_fee");

  // Build lookup: "airport|aircraft_type" → fbo entries
  const rateIndex = new Map<string, typeof fboRates>();
  for (const r of fboRates ?? []) {
    const key = `${(r.airport_code as string).toUpperCase()}|${r.aircraft_type}`;
    if (!rateIndex.has(key)) rateIndex.set(key, []);
    rateIndex.get(key)!.push(r);
  }

  // 3. Fetch tail → aircraft type mapping from ics_sources
  const { data: icsSources } = await supa
    .from("ics_sources")
    .select("label, aircraft_type")
    .not("aircraft_type", "is", null);

  const tailTypeMap = new Map<string, string>();
  const AIRCRAFT_TYPE_MAP: Record<string, string> = {
    "CE-750": "Citation X", "C750": "Citation X", "Citation X": "Citation X",
    "CL-30": "Challenger 300", "CL300": "Challenger 300", "CL30": "Challenger 300",
    "Challenger 300": "Challenger 300", "CL35": "Challenger 350", "Challenger 350": "Challenger 350",
  };
  for (const s of icsSources ?? []) {
    if (s.label && s.aircraft_type) {
      const mapped = AIRCRAFT_TYPE_MAP[s.aircraft_type as string] ?? s.aircraft_type as string;
      tailTypeMap.set(s.label as string, mapped);
    }
  }

  // 4. Check each invoice for overcharges
  const alertsToCreate: Array<{
    document_id: string;
    parsed_invoice_id: string;
    rule_id: string | null;
    status: string;
    slack_status: string;
    match_reason: string;
    match_payload: Record<string, unknown>;
  }> = [];

  // Fetch existing overcharge alerts to avoid duplicates
  const docIds = [...new Set(invoices.map((i) => i.document_id as string))];
  const { data: existingAlerts } = await supa
    .from("invoice_alerts")
    .select("document_id, match_payload")
    .in("document_id", docIds);

  const existingParsedIds = new Set<string>();
  for (const a of existingAlerts ?? []) {
    const mp = a.match_payload as Record<string, unknown> | null;
    if (mp?.rule_name === "Fee Overcharge") {
      // Track by parsed_invoice_id if available, else document_id+fee_type
      existingParsedIds.add(`${a.document_id}|${mp.fee_type ?? ""}`);
    }
  }

  for (const inv of invoices) {
    const airport = normAirport(inv.airport_code as string);
    const vendor = inv.vendor_name as string | null;
    const tail = inv.tail_number as string | null;

    // Determine aircraft type from tail
    let aircraftType = tail ? tailTypeMap.get(tail) : null;
    // If no mapping, try both types and use whichever has rates
    const typesToCheck = aircraftType ? [aircraftType] : ["Citation X", "Challenger 300"];

    const lineItems = Array.isArray(inv.line_items) ? inv.line_items : [];

    for (const li of lineItems as Array<{ description?: string; category?: string; total?: number; amount?: number }>) {
      const desc = li.description ?? li.category ?? "";
      const charged = li.total ?? li.amount;
      if (!desc || !charged || charged <= 0) continue;

      const feeType = classifyFee(desc);
      if (!feeType) continue;

      // Dedup check
      const dedupKey = `${inv.document_id}|${feeType}`;
      if (existingParsedIds.has(dedupKey)) continue;

      // Look up published rate
      for (const acType of typesToCheck) {
        const key = `${airport}|${acType}`;
        const entries = rateIndex.get(key);
        if (!entries?.length) continue;

        // Try to match vendor
        const vendorLower = (vendor ?? "").toLowerCase();
        let match = entries.find((e) => {
          const chain = (e.chain as string ?? "").toLowerCase();
          const fboName = (e.fbo_name as string ?? "").toLowerCase();
          return chain.includes(vendorLower) || vendorLower.includes(chain)
            || fboName.includes(vendorLower) || vendorLower.includes(fboName)
            || (vendorLower.split(/\s+/)[0] === chain.split(/\s+/)[0] && vendorLower.length > 2);
        });

        // If no vendor match, skip — we don't want to compare against a different FBO's rates
        if (!match) continue;

        const publishedRate = match[feeType as keyof typeof match] as number | null;
        if (!publishedRate || publishedRate <= 0) continue;

        const overageDollars = charged - publishedRate;
        if (overageDollars >= OVERAGE_THRESHOLD_DOLLARS) {
          const overagePct = Math.round((overageDollars / publishedRate) * 100);
          const feeLabel = FEE_LABELS[feeType] ?? feeType;

          alertsToCreate.push({
            document_id: inv.document_id as string,
            parsed_invoice_id: inv.id as string,
            rule_id: OVERCHARGE_RULE_ID,
            status: "pending",
            slack_status: "pending",
            match_reason: `${feeLabel} $${overageDollars.toFixed(0)} over published rate (+${overagePct}%)`,
            match_payload: {
              rule_name: "Fee Overcharge",
              fee_type: feeType,
              fee_name: desc,
              charged_amount: charged,
              published_rate: publishedRate,
              overage_pct: overagePct,
              vendor: vendor,
              airport_code: airport,
              tail: tail,
              aircraft_type: acType,
              fbo_name: match.fbo_name,
              invoice_number: inv.invoice_number,
              invoice_date: inv.invoice_date,
              matched_line_items: [{ description: desc, total: charged }],
            },
          });
          existingParsedIds.add(dedupKey); // prevent duplicates within same run
          break; // don't check the other aircraft type
        }
      }
    }
  }

  // 5. Insert alerts
  if (alertsToCreate.length > 0) {
    const { error: insertErr } = await supa.from("invoice_alerts").insert(alertsToCreate);
    if (insertErr) {
      console.error("[overcharge] insert error:", insertErr);
      return NextResponse.json({ error: "Failed to create alerts" }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    invoices_checked: invoices.length,
    alerts_created: alertsToCreate.length,
    details: alertsToCreate.map((a) => ({
      vendor: a.match_payload.vendor,
      airport: a.match_payload.airport_code,
      fee: a.match_payload.fee_name,
      charged: a.match_payload.charged_amount,
      published: a.match_payload.published_rate,
      overage: `${a.match_payload.overage_pct}%`,
    })),
  });
}
