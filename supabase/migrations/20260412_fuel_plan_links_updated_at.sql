-- Multi-user awareness: track when a plan was last recalculated so
-- other viewers can detect stale state and show a "reload" banner.
ALTER TABLE fuel_plan_links
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
