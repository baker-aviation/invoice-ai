-- Post-flight data imported from JetInsight CSV exports.
-- Primary use: shutdown fuel (fuel_end_lbs on last leg) feeds the tankering optimizer.

CREATE TABLE IF NOT EXISTS post_flight_data (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tail_number    TEXT NOT NULL,
  aircraft_type  TEXT NOT NULL,          -- 'CE-750' or 'CL-30'
  origin         TEXT NOT NULL,          -- ICAO code
  destination    TEXT NOT NULL,          -- ICAO code
  flight_date    DATE NOT NULL,
  segment_number INTEGER DEFAULT 1,     -- leg order within the day
  flight_hrs     NUMERIC(6,2),
  block_hrs      NUMERIC(6,2),
  fuel_start_lbs NUMERIC(10,1),
  fuel_end_lbs   NUMERIC(10,1),
  fuel_burn_lbs  NUMERIC(10,1),
  fuel_burn_lbs_hour NUMERIC(8,1),
  takeoff_wt_lbs NUMERIC(10,1),
  pax            INTEGER,
  nautical_miles NUMERIC(10,1),
  gals_pre       NUMERIC(10,1),
  gals_post      NUMERIC(10,1),
  pic            TEXT,
  sic            TEXT,
  trip_id        TEXT,
  upload_batch   TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tail_number, origin, destination, flight_date, segment_number)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_post_flight_tail_date ON post_flight_data (tail_number, flight_date DESC);
CREATE INDEX IF NOT EXISTS idx_post_flight_batch ON post_flight_data (upload_batch);

-- RLS
ALTER TABLE post_flight_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read post_flight_data"
  ON post_flight_data FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role full access to post_flight_data"
  ON post_flight_data FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
