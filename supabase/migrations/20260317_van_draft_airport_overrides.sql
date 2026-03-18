-- Make airport overrides global (shared across all admin sessions)
ALTER TABLE van_draft_overrides
  ADD COLUMN IF NOT EXISTS airport_overrides jsonb DEFAULT '[]'::jsonb;
