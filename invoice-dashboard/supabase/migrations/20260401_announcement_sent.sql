ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS announcement_sent_at timestamptz;
