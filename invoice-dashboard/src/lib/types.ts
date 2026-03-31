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
  pinned?: boolean;
  pin_note?: string | null;
  pinned_by?: string | null;
  pinned_at?: string | null;
  pin_resolved?: boolean;
  resolved_by?: string | null;
  resolved_at?: string | null;
  resolve_note?: string | null;
};

export type InvoiceListResponse = {
  ok: boolean;
  count: number;
  invoices: InvoiceListItem[];
};

export type InvoiceDetailResponse = {
  ok: boolean;
  invoices: any[]; // all parsed invoice rows for this document
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
  pinned?: boolean;
  pin_note?: string | null;
  pin_resolved?: boolean;
  acknowledged?: boolean;
  acknowledged_by?: string | null;
  acknowledged_at?: string | null;
};

export type AlertsResponse = {
  ok: boolean;
  count: number;
  alerts: AlertRow[];
};

export type AlertRule = {
  id: string;
  name: string;
  is_enabled: boolean;
  keywords: string[] | null;
  min_handling_fee: number | null;
  min_service_fee: number | null;
  min_surcharge: number | null;
  min_total: number | null;
  min_risk_score: number | null;
  min_line_item_amount: number | null;
  require_charged_line_items: boolean;
  vendor_normalized_in: string[] | null;
  doc_type_in: string[] | null;
  airport_code_in: string[] | null;
  require_review_required: boolean;
  slack_channel: string | null;
  slack_channel_id: string | null;
  slack_channel_name: string | null;
  created_at: string;
};
/* =========================
   Fuel Prices
========================= */

export type FuelPriceRow = {
  id: string;
  document_id: string;
  airport_code: string | null;
  vendor_name: string | null;
  fuel_vendor: string | null;
  base_price_per_gallon: number | null;
  effective_price_per_gallon: number | null;
  gallons: number | null;
  fuel_total: number | null;
  invoice_date: string | null;
  tail_number: string | null;
  currency: string | null;
  price_change_pct: number | null;
  previous_price: number | null;
  previous_document_id: string | null;
  alert_sent: boolean | null;
  data_source: string | null; // 'invoice' | 'jetinsight'
  has_additive: boolean;
  created_at: string;
};

export type FuelPricesResponse = {
  ok: boolean;
  count: number;
  fuel_prices: FuelPriceRow[];
};

export type AdvertisedPriceRow = {
  id: number;
  fbo_vendor: string;
  airport_code: string;
  volume_tier: string;
  product: string;
  price: number;
  tail_numbers: string | null;
  week_start: string;
  upload_batch: string | null;
  created_at: string;
};

/* =========================
   Jobs
========================= */

export type HiringStage =
  | "prd_faa_review"
  | "chief_pilot_review"
  | "screening"
  | "info_session"
  | "tims_review"
  | "interview_pre"
  | "interview_scheduled"
  | "interview_post"
  | "pending_offer"
  | "offer"
  | "hired";

export const PIPELINE_STAGES = ["prd_faa_review", "chief_pilot_review", "screening", "info_session", "tims_review", "interview_pre", "interview_scheduled", "interview_post", "pending_offer", "offer", "hired"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type JobRow = {
  id: number;
  application_id: number;
  created_at: string | null;
  updated_at: string | null;

  hiring_stage?: HiringStage;
  pipeline_stage?: PipelineStage;

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

  has_part_135: boolean | null;
  has_part_121: boolean | null;

  soft_gate_pic_met: boolean | null;
  soft_gate_pic_status: string | null;
  needs_review: boolean | null;

  notes: string | null;
  model: string | null;

  structured_notes?: {
    hr_notes?: string;
    prd_review_notes?: string;
    tims_notes?: string;
    chief_pilot_notes?: string;
  } | null;

  rejected_at?: string | null;
  rejection_reason?: string | null;
  deleted_at?: string | null;

  info_session_data?: Record<string, any> | null;

  info_session_attended?: boolean | null;
  info_session_attended_at?: string | null;

  offer_sent_at?: string | null;
  offer_status?: string | null; // null | "draft" | "sent" | "accepted" | "declined"

  hr_reviewed?: boolean | null;
  previously_rejected?: boolean | null;

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

/* =========================
   Pilots
========================= */

export type PilotProfile = {
  id: number;
  user_id: string | null;
  crew_member_id: string | null;
  application_id: number | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: "PIC" | "SIC";
  home_airports: string[];
  aircraft_types: string[];
  hire_date: string | null;
  employee_id: string | null;
  medical_class: string | null;
  medical_expiry: string | null;
  passport_expiry: string | null;
  onboarding_complete: boolean;
  available_to_fly: boolean;
  created_at: string;
  updated_at: string;
  // joined fields
  onboarding_items?: OnboardingItem[];
  onboarding_progress?: { completed: number; total: number };
};

export type OnboardingItem = {
  id: number;
  pilot_profile_id: number;
  item_key: string;
  item_label: string;
  required_for: "all" | "pic_only";
  completed: boolean;
  completed_at: string | null;
  completed_by: string | null;
  notes: string | null;
};

export type TimeOffRequest = {
  id: number;
  pilot_profile_id: number;
  request_type: "time_off" | "standby";
  start_date: string;
  end_date: string;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  updated_at: string;
  // joined
  pilot_name?: string;
};

