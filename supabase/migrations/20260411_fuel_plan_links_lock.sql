-- Phase 3e: daily lock state for fuel plans
-- When a plan is "locked" (midnight snapshot for next-day releases),
-- the legs at lock time are stored so later JI schedule changes can be
-- detected and flagged on the Aircraft Fuel Plans view.
ALTER TABLE fuel_plan_links
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_legs JSONB;
