-- Per-flight acknowledgments for shared NOTAM alerts (flight_id IS NULL on the alert row).
-- Allows acking a NOTAM on one flight card without hiding it from other flights.
CREATE TABLE IF NOT EXISTS notam_flight_acks (
  alert_id UUID NOT NULL REFERENCES ops_alerts(id) ON DELETE CASCADE,
  flight_id TEXT NOT NULL,   -- flights.id (text UUID, not FK to allow orphan cleanup)
  user_id UUID NOT NULL,
  acked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, flight_id)
);

-- RLS: authenticated users can read/write their own acks
ALTER TABLE notam_flight_acks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read notam_flight_acks"
  ON notam_flight_acks FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert notam_flight_acks"
  ON notam_flight_acks FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can delete their own notam_flight_acks"
  ON notam_flight_acks FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Service role gets full access
CREATE POLICY "Service role full access on notam_flight_acks"
  ON notam_flight_acks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Index for fast lookups by flight
CREATE INDEX idx_notam_flight_acks_flight ON notam_flight_acks(flight_id);
