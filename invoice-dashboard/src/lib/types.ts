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

export type InvoiceListResponse = {
  ok: boolean;
  count: number;
  invoices: InvoiceListItem[];
};

export type InvoiceDetailResponse = {
  ok: boolean;
  invoice: any; // full parsed row
  signed_pdf_url: string | null;
};

export type AlertRow = {
  id: string;
  created_at: string;
  document_id: string;
  rule_name: string;
  status: string | null;
  slack_status: string | null;
  vendor: string | null;
  tail: string | null;
  airport_code: string | null;
  fee_name: string | null;
  fee_amount: number | null;
  currency: string | null;
};

export type AlertsResponse = {
  ok: boolean;
  count: number;
  alerts: AlertRow[];
};