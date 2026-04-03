-- Add PRD (Pilot Records Database) parsing columns to job_application_parse
-- Run this in the Supabase SQL Editor

ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS prd_flags jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prd_summary text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prd_type_ratings text[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prd_sic_limitations text[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prd_parsed_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prd_certificate_type text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prd_certificate_number text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prd_medical_class text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prd_medical_date text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prd_medical_limitations text DEFAULT NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'job_application_parse'
  AND column_name LIKE 'prd_%'
ORDER BY column_name;
