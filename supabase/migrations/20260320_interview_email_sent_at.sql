ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS interview_email_sent_at TIMESTAMPTZ;
