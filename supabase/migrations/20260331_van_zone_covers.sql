-- Allow a van to temporarily cover another van's zone (e.g., Houston van covering Denver)
-- Format: [[coveringVanId, coveredVanId], ...] — e.g. [[10, 14]]
ALTER TABLE van_draft_overrides
  ADD COLUMN IF NOT EXISTS zone_covers jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS vans_in_shop jsonb DEFAULT '[]'::jsonb;
