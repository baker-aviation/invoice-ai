-- =============================================================================
-- Hiring pipeline — adds stage tracking to job applications
-- =============================================================================

-- Add hiring_stage column to the parse table (where all candidate data lives).
-- Default 'new' for existing and freshly parsed applicants.
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS hiring_stage TEXT NOT NULL DEFAULT 'new';

-- Index for pipeline queries (filter by stage, sort by updated_at)
CREATE INDEX IF NOT EXISTS idx_jap_hiring_stage
  ON job_application_parse (hiring_stage, updated_at DESC);
