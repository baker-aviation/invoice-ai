-- Move interview_pre candidates to interview_scheduled
UPDATE job_application_parse
SET pipeline_stage = 'interview_scheduled', updated_at = now()
WHERE pipeline_stage = 'interview_pre';

-- Add interview email status column
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS interview_email_status text;
