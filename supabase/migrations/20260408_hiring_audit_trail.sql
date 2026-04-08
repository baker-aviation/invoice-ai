-- Add user tracking columns for hiring pipeline actions
-- Tracks who sent emails, changed stages, created tokens, and rejected candidates

-- Track who sent interview/info-session emails
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS interview_email_sent_by TEXT,
  ADD COLUMN IF NOT EXISTS info_session_email_sent_by TEXT,
  ADD COLUMN IF NOT EXISTS rejected_by TEXT;

-- Track who created form tokens
ALTER TABLE info_session_tokens
  ADD COLUMN IF NOT EXISTS created_by TEXT;
