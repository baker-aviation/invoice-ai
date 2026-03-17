-- Add global UI state columns to van_draft_overrides
-- These replace per-user localStorage for dismiss/hide/won't-see actions
ALTER TABLE van_draft_overrides
  ADD COLUMN IF NOT EXISTS wont_see_tails jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS dismissed_conflicts jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS hidden_mx_ids jsonb DEFAULT '[]'::jsonb;
