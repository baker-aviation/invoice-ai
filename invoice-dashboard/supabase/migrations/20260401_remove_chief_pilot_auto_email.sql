-- Move chief_pilot_review candidates to screening
UPDATE job_application_parse
SET pipeline_stage = 'screening', updated_at = now()
WHERE pipeline_stage = 'chief_pilot_review';

-- Add info session email status column
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS info_session_email_status text;

-- Set existing info_session candidates with sent_at to 'sent' status
UPDATE job_application_parse
SET info_session_email_status = 'sent'
WHERE pipeline_stage = 'info_session'
  AND info_session_email_sent_at IS NOT NULL
  AND info_session_email_status IS NULL;
