export type InvoiceListItem = {
  id: string;
  document_id: string;
  created_at: string;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  airport_code: string | null;
  tail_number: string | null;
  currency: string | null;
  total: number | string | null;
  doc_type: string | null;
  review_required: boolean | null;
  risk_score: number | null;
  has_line_items?: boolean;
};

export type InvoiceDetailResponse = {
  ok: true;
  invoice: Record<string, any>;
  signed_pdf_url: string | null;
};

function baseUrl() {
  const v = process.env.INVOICE_API_BASE_URL;
  if (!v) throw new Error("Missing INVOICE_API_BASE_URL");
  return v.replace(/\/+$/, "");
}

export async function fetchInvoices(limit = 50) {
  const res = await fetch(
    `${baseUrl()}/api/invoices?limit=${limit}`,
    { cache: "no-store" }
  );

  if (!res.ok) {
    throw new Error(`fetchInvoices failed: ${res.status}`);
  }

  return res.json();
}

export async function fetchInvoice(documentId: string) {
  const res = await fetch(
    `${baseUrl()}/api/invoices/${documentId}`,
    { cache: "no-store" }
  );

  if (!res.ok) {
    throw new Error(`fetchInvoice failed: ${res.status}`);
  }

  return res.json() as Promise<InvoiceDetailResponse>;
}