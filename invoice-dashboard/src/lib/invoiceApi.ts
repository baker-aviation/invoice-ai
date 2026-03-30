import { createServiceClient } from "@/lib/supabase/service";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";
import { signGcsUrl } from "@/lib/gcs";
import type { AdvertisedPriceRow, AlertRow, AlertRule, AlertsResponse, FuelPriceRow, FuelPricesResponse, InvoiceDetailResponse, InvoiceListItem, InvoiceListResponse } from "@/lib/types";

// ---------------------------------------------------------------------------
// Invoices — direct Supabase query to parsed_invoices
// ---------------------------------------------------------------------------

const INVOICE_COLUMNS =
  "id, document_id, created_at, vendor_name, invoice_number, invoice_date, airport_code, tail_number, currency, total, doc_type, review_required, risk_score, line_items, category_override, pinned, pin_note, pinned_by, pinned_at, pin_resolved, resolved_by, resolved_at";

export async function fetchInvoices(params: {
  limit?: number;
  q?: string;
  vendor?: string;
  doc_type?: string;
  airport?: string;
  tail?: string;
  review_required?: "true" | "false";
  min_risk?: number;
} = {}): Promise<InvoiceListResponse> {
  const supa = createServiceClient();
  const limit = params.limit ?? 200;

  let query = supa
    .from("parsed_invoices")
    .select(INVOICE_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (params.q) {
    // Strip characters that act as PostgREST filter operators:
    //   , = condition separator  ( ) = grouping  % = SQL wildcard (we add our own)
    const q = params.q.replace(/[%,()]/g, "").trim();
    if (q.length > 0) {
      const pattern = `%${q}%`;
      query = query.or(
        `vendor_name.ilike.${pattern},invoice_number.ilike.${pattern},airport_code.ilike.${pattern},tail_number.ilike.${pattern}`
      );
    }
  }
  if (params.vendor) query = query.ilike("vendor_name", `%${params.vendor}%`);
  if (params.doc_type) query = query.eq("doc_type", params.doc_type);
  if (params.airport) query = query.ilike("airport_code", `%${params.airport}%`);
  if (params.tail) query = query.ilike("tail_number", `%${params.tail}%`);
  if (params.review_required) query = query.eq("review_required", params.review_required === "true");
  if (typeof params.min_risk === "number") query = query.gte("risk_score", params.min_risk);

  const { data, error } = await query;
  if (error) throw new Error(`fetchInvoices failed: ${error.message}`);

  // Load learned vendor → category rules
  const { data: rules } = await supa
    .from("category_rules")
    .select("vendor_normalized, category");
  const ruleMap = new Map<string, string>();
  for (const r of rules ?? []) {
    ruleMap.set(r.vendor_normalized as string, r.category as string);
  }

  let invoices: InvoiceListItem[] = (data ?? []).map((row) => {
    const vendorNorm = ((row.vendor_name as string) ?? "").trim().toLowerCase();
    return {
      id: row.id as string,
      document_id: row.document_id as string,
      created_at: row.created_at as string,
      vendor_name: row.vendor_name as string | null,
      invoice_number: row.invoice_number as string | null,
      invoice_date: row.invoice_date as string | null,
      airport_code: row.airport_code as string | null,
      tail_number: row.tail_number as string | null,
      currency: row.currency as string | null,
      total: row.total as number | string | null,
      doc_type: row.doc_type as string | null,
      review_required: row.review_required as boolean | null,
      risk_score: row.risk_score as number | null,
      has_line_items: Array.isArray(row.line_items) ? row.line_items.length > 0 : false,
      category_override: row.category_override as string | null,
      learned_category: ruleMap.get(vendorNorm) ?? null,
      pinned: (row.pinned as boolean) ?? false,
      pin_note: row.pin_note as string | null,
      pinned_by: row.pinned_by as string | null,
      pinned_at: row.pinned_at as string | null,
      pin_resolved: (row.pin_resolved as boolean) ?? false,
      resolved_by: row.resolved_by as string | null,
      resolved_at: row.resolved_at as string | null,
    };
  });

  return { ok: true, count: invoices.length, invoices };
}

// ---------------------------------------------------------------------------
// Invoice detail — direct Supabase query (with optional Cloud Run fallback
// for signed PDF URL, plus direct GCS signing)
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function getSignedUrlBase(): string | undefined {
  const parser = process.env.PARSER_API_BASE_URL ?? process.env.INVOICE_PARSER_URL;
  if (parser) return parser;
  if (process.env.INVOICE_API_BASE_URL) return process.env.INVOICE_API_BASE_URL;
  return undefined;
}

const BASE = getSignedUrlBase();

export async function fetchInvoiceDetail(documentId: string): Promise<InvoiceDetailResponse> {
  if (!SAFE_ID_RE.test(documentId)) {
    throw new Error("Invalid document ID");
  }

  const supa = createServiceClient();

  const { data, error } = await supa
    .from("parsed_invoices")
    .select("*")
    .eq("document_id", documentId)
    .order("source_invoice_id", { ascending: true });

  if (error) throw new Error(`fetchInvoiceDetail failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error("fetchInvoiceDetail failed: 404");

  // Load learned vendor → category rules
  const { data: rules } = await supa
    .from("category_rules")
    .select("vendor_normalized, category");
  const ruleMap = new Map<string, string>();
  for (const r of rules ?? []) {
    ruleMap.set(r.vendor_normalized as string, r.category as string);
  }

  // Parse line_items for each invoice row
  const invoices = data.map((row: any) => {
    let lineItems = row.line_items;
    if (typeof lineItems === "string") {
      try {
        lineItems = JSON.parse(lineItems);
      } catch {
        lineItems = [];
      }
    }
    const vendorNorm = ((row.vendor_name as string) ?? "").trim().toLowerCase();
    return {
      ...row,
      line_items: Array.isArray(lineItems) ? lineItems : [],
      learned_category: ruleMap.get(vendorNorm) ?? null,
    };
  });

  // Try to get signed PDF URL from Cloud Run (non-blocking — page loads even if this fails)
  let signedPdfUrl: string | null = null;
  if (BASE) {
    try {
      const res = await cloudRunFetch(`${BASE.replace(/\/$/, "")}/api/invoices/${documentId}/pdf-url`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = await res.json();
        signedPdfUrl = body.signed_pdf_url ?? null;
      }
    } catch {
      // Cloud Run unavailable or no GCP_SA_KEY — fall through to GCS signing
    }
  }

  // Fallback: try direct GCS signing (works in iframes — no redirect)
  if (!signedPdfUrl) {
    const { data: doc } = await supa
      .from("documents")
      .select("gcs_bucket, gcs_path")
      .eq("id", documentId)
      .maybeSingle();

    if (doc?.gcs_bucket && doc?.gcs_path) {
      signedPdfUrl = await signGcsUrl(doc.gcs_bucket, doc.gcs_path);
    }
  }

  // Final fallback: use direct GCS proxy route (bypasses Cloud Run)
  if (!signedPdfUrl) {
    signedPdfUrl = `/api/invoices/${documentId}/pdf`;
  }

  return { ok: true, invoices, signed_pdf_url: signedPdfUrl };
}

// ---------------------------------------------------------------------------
// Alerts — direct Supabase query to invoice_alerts
// ---------------------------------------------------------------------------

export async function fetchAlerts(params: {
  limit?: number;
  q?: string;
  status?: string;
  slack_status?: string;
} = {}): Promise<AlertsResponse> {
  const supa = createServiceClient();
  const limit = params.limit ?? 1000;

  let query = supa
    .from("invoice_alerts")
    .select("id, created_at, document_id, rule_id, status, slack_status, match_payload, acknowledged, acknowledged_by, acknowledged_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (params.status) query = query.eq("status", params.status);
  if (params.slack_status) query = query.eq("slack_status", params.slack_status);

  const { data, error } = await query;
  if (error) throw new Error(`fetchAlerts failed: ${error.message}`);

  // Collect document_ids that need fallback lookups
  const docIds = new Set<string>();
  for (const row of data ?? []) {
    if (row.document_id) docIds.add(row.document_id as string);
  }

  // Batch-fetch parsed_invoices for fallback vendor/tail/airport + pin status
  const invoiceLookup = new Map<string, { vendor_name: string | null; tail_number: string | null; airport_code: string | null; pinned: boolean; pin_note: string | null; pin_resolved: boolean }>();
  if (docIds.size > 0) {
    const { data: invoiceRows } = await supa
      .from("parsed_invoices")
      .select("document_id, vendor_name, tail_number, airport_code, pinned, pin_note, pin_resolved")
      .in("document_id", [...docIds]);

    for (const inv of invoiceRows ?? []) {
      invoiceLookup.set(inv.document_id as string, {
        vendor_name: inv.vendor_name as string | null,
        tail_number: inv.tail_number as string | null,
        airport_code: inv.airport_code as string | null,
        pinned: (inv.pinned as boolean) ?? false,
        pin_note: (inv.pin_note as string) ?? null,
        pin_resolved: (inv.pin_resolved as boolean) ?? false,
      });
    }
  }

  let alerts: AlertRow[] = [];
  for (const row of data ?? []) {
    const mp = (row.match_payload ?? {}) as Record<string, unknown>;
    const items = Array.isArray(mp.matched_line_items) ? mp.matched_line_items : [];
    const first = (items[0] ?? {}) as Record<string, unknown>;

    const feeName = String(first.description ?? "").trim();
    const feeAmount = typeof first.total === "number" ? first.total : null;

    // Only include actionable alerts (has fee name + positive amount)
    if (!feeName || !feeAmount || feeAmount <= 0) continue;

    // Fallback to parsed_invoices for vendor/tail/airport
    const fallback = invoiceLookup.get(row.document_id as string);

    alerts.push({
      id: row.id as string,
      created_at: row.created_at as string,
      document_id: row.document_id as string,
      rule_name: (mp.rule_name as string | undefined) ?? "",
      status: row.status as string | null,
      slack_status: row.slack_status as string | null,
      vendor: (mp.vendor as string | undefined) || fallback?.vendor_name || null,
      tail: (mp.tail as string | undefined) || fallback?.tail_number || null,
      airport_code: (mp.airport_code as string | undefined) || fallback?.airport_code || null,
      fee_name: feeName,
      fee_amount: feeAmount,
      currency: (mp.currency as string | undefined) ?? null,
      pinned: fallback?.pinned ?? false,
      pin_note: fallback?.pin_note ?? null,
      pin_resolved: fallback?.pin_resolved ?? false,
      acknowledged: (row.acknowledged as boolean) ?? false,
      acknowledged_by: (row.acknowledged_by as string) ?? null,
      acknowledged_at: (row.acknowledged_at as string) ?? null,
    });
  }

  // Text search
  if (params.q) {
    const qLower = params.q.toLowerCase();
    alerts = alerts.filter((a) =>
      [a.document_id, a.rule_name, a.vendor, a.airport_code, a.tail, a.fee_name, a.status, a.slack_status]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(qLower)),
    );
  }

  return { ok: true, count: alerts.length, alerts };
}

// ---------------------------------------------------------------------------
// Alert Rules — direct Supabase query to invoice_alert_rules
// ---------------------------------------------------------------------------

export async function fetchAlertRules(): Promise<AlertRule[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("invoice_alert_rules")
    .select(
      "id, name, is_enabled, keywords, min_handling_fee, min_service_fee, min_surcharge, min_total, min_risk_score, min_line_item_amount, require_charged_line_items, vendor_normalized_in, doc_type_in, airport_code_in, require_review_required, slack_channel, slack_channel_id, slack_channel_name, created_at"
    )
    .order("name", { ascending: true });

  if (error) throw new Error(`fetchAlertRules failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    is_enabled: (row.is_enabled as boolean) ?? false,
    keywords: row.keywords as string[] | null,
    min_handling_fee: row.min_handling_fee as number | null,
    min_service_fee: row.min_service_fee as number | null,
    min_surcharge: row.min_surcharge as number | null,
    min_total: row.min_total as number | null,
    min_risk_score: row.min_risk_score as number | null,
    min_line_item_amount: row.min_line_item_amount as number | null,
    require_charged_line_items: (row.require_charged_line_items as boolean) ?? false,
    vendor_normalized_in: row.vendor_normalized_in as string[] | null,
    doc_type_in: row.doc_type_in as string[] | null,
    airport_code_in: row.airport_code_in as string[] | null,
    require_review_required: (row.require_review_required as boolean) ?? false,
    slack_channel: row.slack_channel as string | null,
    slack_channel_id: row.slack_channel_id as string | null,
    slack_channel_name: row.slack_channel_name as string | null,
    created_at: row.created_at as string,
  }));
}

// ---------------------------------------------------------------------------
// Fuel Prices — direct Supabase query to fuel_prices
// ---------------------------------------------------------------------------

const FUEL_PRICE_COLUMNS =
  "id, document_id, airport_code, vendor_name, base_price_per_gallon, effective_price_per_gallon, gallons, fuel_total, invoice_date, tail_number, currency, price_change_pct, previous_price, previous_document_id, alert_sent, data_source, has_additive, created_at";

export async function fetchFuelPrices(params: {
  limit?: number;
  q?: string;
  airport?: string;
  vendor?: string;
} = {}): Promise<FuelPricesResponse> {
  const supa = createServiceClient();
  const limit = params.limit ?? 200;

  // Filter out records with future dates (likely DD/MM vs MM/DD parsing errors)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const maxDate = tomorrow.toISOString().split("T")[0];

  let query = supa
    .from("fuel_prices")
    .select(FUEL_PRICE_COLUMNS)
    .lte("invoice_date", maxDate)
    .order("invoice_date", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (params.airport) query = query.ilike("airport_code", `%${params.airport}%`);
  if (params.vendor) query = query.ilike("vendor_name", `%${params.vendor}%`);

  const { data, error } = await query;
  if (error) throw new Error(`fetchFuelPrices failed: ${error.message}`);

  let fuelPrices: FuelPriceRow[] = (data ?? []).map((row) => ({
    id: row.id as string,
    document_id: row.document_id as string,
    airport_code: row.airport_code as string | null,
    vendor_name: row.vendor_name as string | null,
    base_price_per_gallon: row.base_price_per_gallon as number | null,
    effective_price_per_gallon: row.effective_price_per_gallon as number | null,
    gallons: row.gallons as number | null,
    fuel_total: row.fuel_total as number | null,
    invoice_date: row.invoice_date as string | null,
    tail_number: row.tail_number as string | null,
    currency: row.currency as string | null,
    price_change_pct: row.price_change_pct as number | null,
    previous_price: row.previous_price as number | null,
    previous_document_id: row.previous_document_id as string | null,
    alert_sent: row.alert_sent as boolean | null,
    data_source: (row.data_source as string | null) ?? "invoice",
    has_additive: (row.has_additive as boolean | null) ?? false,
    created_at: row.created_at as string,
  }));

  if (params.q) {
    const qLower = params.q.toLowerCase();
    fuelPrices = fuelPrices.filter((fp) =>
      [fp.airport_code, fp.vendor_name, fp.tail_number, fp.document_id]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(qLower)),
    );
  }

  return { ok: true, count: fuelPrices.length, fuel_prices: fuelPrices };
}

// ---------------------------------------------------------------------------
// Advertised Fuel Prices — fbo_advertised_prices table
// ---------------------------------------------------------------------------

export async function fetchAdvertisedPrices(opts?: { recentWeeks?: number }): Promise<AdvertisedPriceRow[]> {
  const supa = createServiceClient();

  const columns = "id, fbo_vendor, airport_code, volume_tier, product, price, tail_numbers, week_start, upload_batch, created_at";

  // Filter to recent weeks — default 2 weeks (current + prev for WOW)
  const weeks = opts?.recentWeeks ?? 2;
  const cutoff = new Date(Date.now() - weeks * 7 * 86400000).toISOString().split("T")[0];

  // Supabase PostgREST caps results at max-rows (typically 10K).
  // Paginate with .range() to fetch the full dataset.
  const PAGE = 10000;
  const allRows: AdvertisedPriceRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supa
      .from("fbo_advertised_prices")
      .select(columns)
      .gte("week_start", cutoff)
      .order("week_start", { ascending: false })
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`fetchAdvertisedPrices failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      allRows.push({
        id: row.id as number,
        fbo_vendor: row.fbo_vendor as string,
        airport_code: row.airport_code as string,
        volume_tier: row.volume_tier as string,
        product: row.product as string,
        price: Number(row.price),
        tail_numbers: (row.tail_numbers as string | null) ?? null,
        week_start: row.week_start as string,
        upload_batch: (row.upload_batch as string | null) ?? null,
        created_at: row.created_at as string,
      });
    }

    if (data.length < PAGE) break; // Last page
    offset += PAGE;
  }

  return allRows;
}
