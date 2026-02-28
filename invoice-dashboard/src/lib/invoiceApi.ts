import { createServiceClient } from "@/lib/supabase/service";
import type { AlertRow, AlertsResponse, InvoiceDetailResponse, InvoiceListItem, InvoiceListResponse } from "@/lib/types";

// ---------------------------------------------------------------------------
// Invoices — direct Supabase query to parsed_invoices
// ---------------------------------------------------------------------------

const INVOICE_COLUMNS =
  "id, document_id, created_at, vendor_name, invoice_number, invoice_date, airport_code, tail_number, currency, total, doc_type, review_required, risk_score, line_items";

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

  if (params.vendor) query = query.ilike("vendor_name", `%${params.vendor}%`);
  if (params.doc_type) query = query.eq("doc_type", params.doc_type);
  if (params.airport) query = query.ilike("airport_code", `%${params.airport}%`);
  if (params.tail) query = query.ilike("tail_number", `%${params.tail}%`);
  if (params.review_required) query = query.eq("review_required", params.review_required === "true");
  if (typeof params.min_risk === "number") query = query.gte("risk_score", params.min_risk);

  const { data, error } = await query;
  if (error) throw new Error(`fetchInvoices failed: ${error.message}`);

  let invoices: InvoiceListItem[] = (data ?? []).map((row) => ({
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
  }));

  // Client-side text search (matches backend behavior)
  if (params.q) {
    const qLower = params.q.toLowerCase();
    invoices = invoices.filter((inv) =>
      [inv.vendor_name, inv.invoice_number, inv.airport_code, inv.tail_number, inv.document_id]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(qLower)),
    );
  }

  return { ok: true, count: invoices.length, invoices };
}

// ---------------------------------------------------------------------------
// Invoice detail — direct Supabase query
// PDF URL points to internal API route (handles GCS signing + Cloud Run)
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export async function fetchInvoiceDetail(documentId: string): Promise<InvoiceDetailResponse> {
  if (!SAFE_ID_RE.test(documentId)) {
    throw new Error("Invalid document ID");
  }

  const supa = createServiceClient();

  const { data, error } = await supa
    .from("parsed_invoices")
    .select(INVOICE_COLUMNS)
    .eq("document_id", documentId)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`fetchInvoiceDetail failed: ${error.message}`);
  if (!data) throw new Error("Invoice not found");

  // Check if a PDF exists in GCS for this document
  const { data: doc } = await supa
    .from("documents")
    .select("gcs_bucket, gcs_path")
    .eq("id", documentId)
    .maybeSingle();

  // Point to our internal API route which handles GCS signing or Cloud Run proxy
  const signed_pdf_url = doc?.gcs_path ? `/api/invoices/${documentId}` : null;

  return { ok: true, invoice: data, signed_pdf_url };
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
  const limit = params.limit ?? 200;

  let query = supa
    .from("invoice_alerts")
    .select("id, created_at, document_id, rule_id, status, slack_status, match_payload")
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

  // Batch-fetch parsed_invoices for fallback vendor/tail/airport
  const invoiceLookup = new Map<string, { vendor_name: string | null; tail_number: string | null; airport_code: string | null }>();
  if (docIds.size > 0) {
    const { data: invoiceRows } = await supa
      .from("parsed_invoices")
      .select("document_id, vendor_name, tail_number, airport_code")
      .in("document_id", [...docIds]);

    for (const inv of invoiceRows ?? []) {
      invoiceLookup.set(inv.document_id as string, {
        vendor_name: inv.vendor_name as string | null,
        tail_number: inv.tail_number as string | null,
        airport_code: inv.airport_code as string | null,
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
