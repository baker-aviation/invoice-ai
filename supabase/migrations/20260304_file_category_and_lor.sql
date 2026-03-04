-- Add file_category to distinguish resumes, LORs, cover letters, etc.
ALTER TABLE job_application_files
  ADD COLUMN IF NOT EXISTS file_category text DEFAULT 'resume';

-- Link a file (especially LORs) to a specific parsed candidate profile
-- This is separate from application_id since LORs may come from a different email/application
ALTER TABLE job_application_files
  ADD COLUMN IF NOT EXISTS linked_parse_id bigint;

-- Index for fast LOR lookups
CREATE INDEX IF NOT EXISTS idx_jaf_file_category ON job_application_files (file_category);
CREATE INDEX IF NOT EXISTS idx_jaf_linked_parse_id ON job_application_files (linked_parse_id);
