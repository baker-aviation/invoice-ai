-- Add swap_day column to support multi-day swap plans.
-- NULL = legacy single-day plan (backwards compatible).

ALTER TABLE swap_plans ADD COLUMN IF NOT EXISTS swap_day TEXT;

-- Comment for clarity
COMMENT ON COLUMN swap_plans.swap_day IS 'Day of the week for this plan (e.g., "tuesday", "wednesday"). NULL for legacy plans.';
