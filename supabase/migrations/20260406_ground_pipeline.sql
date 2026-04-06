-- Ground pipeline: add qualifications, evaluations, and manager review columns

-- Ground qualifications (certifications, licenses)
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS ground_qualifications jsonb DEFAULT NULL;
  -- Schema: { ap_cert?: string, ia_authorization?: bool, ase_certs?: string[],
  --           cdl?: bool, cdl_class?: string, hazmat_endorsement?: bool,
  --           years_experience?: number, other_certs?: string[] }

-- Ground evaluation scores/notes
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS ground_evaluations jsonb DEFAULT NULL;
  -- Schema: { technical_assessment?: { score: number, notes: string, completed_at: string },
  --           sales_exercise?: { score: number, notes: string, completed_at: string },
  --           practical_test?: { score: number, notes: string, completed_at: string } }

-- Manager review approval gate
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS manager_review_status text DEFAULT NULL;
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS manager_review_by text DEFAULT NULL;
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS manager_review_at timestamptz DEFAULT NULL;
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS manager_review_notes text DEFAULT NULL;

-- Background check
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS background_check_status text DEFAULT NULL;
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS background_check_at timestamptz DEFAULT NULL;

-- Driving record check (fleet manager)
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS driving_record_status text DEFAULT NULL;
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS driving_record_notes text DEFAULT NULL;

-- Index for ground pipeline queries
CREATE INDEX IF NOT EXISTS idx_jap_ground_pipeline
  ON job_application_parse (pipeline_stage, updated_at DESC)
  WHERE category IN ('maintenance', 'sales', 'admin', 'management', 'line_service', 'other');

-- Seed ground-specific hiring_settings (Calendly URLs start empty)
INSERT INTO hiring_settings (key, value) VALUES
  ('ground_phone_screen_calendly_url', ''),
  ('ground_interview_calendly_url', ''),
  ('ground_phone_screen_email_template', ''),
  ('ground_interview_email_template', ''),
  ('ground_rejection_email_soft', ''),
  ('ground_rejection_email_hard', ''),
  ('ground_rejection_email_left', '')
ON CONFLICT (key) DO NOTHING;
