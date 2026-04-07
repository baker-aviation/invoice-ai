-- Fix 1: Add handler_status column to intl_trip_clearances
-- The parse-cbp-replies route writes to this column but it was never created.
-- CBP reply data has been silently lost on every update.
ALTER TABLE intl_trip_clearances ADD COLUMN IF NOT EXISTS handler_status jsonb;

-- Fix 2: Drop unique constraint on jetinsight_trip_id
-- JetInsight reuses trip IDs across tails and dates. The unique constraint
-- blocks trip creation and causes cascading failures (missing trips → missing
-- crew → missing passengers → missing CBP matches).
DROP INDEX IF EXISTS idx_intl_trips_ji_trip;
ALTER TABLE intl_trips DROP CONSTRAINT IF EXISTS intl_trips_jetinsight_trip_id_key;
-- Replace with a non-unique index for lookup performance
CREATE INDEX IF NOT EXISTS idx_intl_trips_ji_trip ON intl_trips(jetinsight_trip_id) WHERE jetinsight_trip_id IS NOT NULL;
