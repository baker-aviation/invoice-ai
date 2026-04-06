-- Add snapshot_type to distinguish pre-flight (dispatch plan) vs post-flight (actual) predictions
-- Pre-flight: synced from ForeFlight before the flight departs (fuel planning data)
-- Post-flight: synced after flight completes (actual performance for efficiency analysis)

ALTER TABLE foreflight_predictions
  ADD COLUMN IF NOT EXISTS snapshot_type text NOT NULL DEFAULT 'post_flight'
    CHECK (snapshot_type IN ('pre_flight', 'post_flight'));

-- Post-flight rows keep the original unique constraint on foreflight_id (FKs from
-- foreflight_waypoints and foreflight_flight_phases depend on it).
-- Pre-flight rows get a separate partial unique index so upserts work.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ff_pred_preflight_id ON foreflight_predictions (foreflight_id)
  WHERE snapshot_type = 'pre_flight';

-- Pre-flight lookup index for generate endpoint
CREATE INDEX IF NOT EXISTS idx_ff_pred_preflight ON foreflight_predictions (tail_number, flight_date, snapshot_type)
  WHERE snapshot_type = 'pre_flight';
