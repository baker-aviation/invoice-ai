-- Intra-van aircraft reordering: stores custom sort order per van
ALTER TABLE van_draft_overrides
  ADD COLUMN IF NOT EXISTS sort_overrides jsonb DEFAULT '[]'::jsonb;
