-- Published van schedules: Director's finalized schedule sent to van drivers.
-- One row per van per date. Re-publishing upserts (replaces).

CREATE TABLE IF NOT EXISTS van_published_schedules (
  van_id        INTEGER NOT NULL,
  schedule_date DATE NOT NULL,
  flight_ids    UUID[] NOT NULL DEFAULT '{}',
  published_by  UUID,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (van_id, schedule_date)
);

CREATE INDEX idx_van_published_date ON van_published_schedules (schedule_date);

ALTER TABLE van_published_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read published schedules"
  ON van_published_schedules FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can upsert published schedules"
  ON van_published_schedules FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update published schedules"
  ON van_published_schedules FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Service role full access to published schedules"
  ON van_published_schedules FOR ALL
  TO service_role
  USING (true);
