-- Profile enhancement: structured notes, rejection workflow, soft-delete
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS structured_notes JSONB,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Fast lookup for "previously rejected" by email
CREATE INDEX IF NOT EXISTS idx_jap_email_rejected
  ON job_application_parse (email, rejected_at)
  WHERE rejected_at IS NOT NULL;
