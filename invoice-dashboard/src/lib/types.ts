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
/* =========================
   Jobs
========================= */

export const PIPELINE_STAGES = ["new", "screening", "interview", "offer", "hired", "rejected"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type JobRow = {
  id: number;
  application_id: number;
  created_at: string | null;
  updated_at: string | null;

  pipeline_stage: PipelineStage;

  category: string | null;
  employment_type: string | null;

  candidate_name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;

  total_time_hours: number | null;
  turbine_time_hours: number | null;
  pic_time_hours: number | null;
  sic_time_hours: number | null;

  has_citation_x: boolean | null;
  has_challenger_300_type_rating: boolean | null;
  type_ratings: string[] | null;

  soft_gate_pic_met: boolean | null;
  soft_gate_pic_status: string | null;
  needs_review: boolean | null;

  notes: string | null;
  model: string | null;

  confidence?: any;
  raw_extraction?: any;
};

export type JobsListResponse = {
  ok: boolean;
  count: number;
  jobs: JobRow[];
};

export type JobFile = {
  id: number;
  filename?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  created_at?: string | null;
  signed_url?: string | null;
};

export type JobDetailResponse = {
  ok: boolean;
  job: JobRow;
  files: JobFile[];
};

