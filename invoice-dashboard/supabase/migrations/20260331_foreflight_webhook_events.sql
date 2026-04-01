-- Store ForeFlight webhook events with fetched flight data.
CREATE TABLE foreflight_webhook_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flight_id     TEXT NOT NULL,
  change_type   TEXT NOT NULL,          -- FlightCreated, FlightDeleted, FlightReleased, Flight, Filing
  changed_fields TEXT[] DEFAULT '{}',   -- which fields changed (for Flight type)
  flight_data   JSONB,                  -- full flight detail fetched after webhook
  processed     BOOLEAN DEFAULT false,
  received_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE foreflight_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON foreflight_webhook_events FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read" ON foreflight_webhook_events FOR SELECT TO authenticated USING (true);

CREATE INDEX idx_ff_webhook_flight_id ON foreflight_webhook_events (flight_id);
CREATE INDEX idx_ff_webhook_change_type ON foreflight_webhook_events (change_type);
CREATE INDEX idx_ff_webhook_received ON foreflight_webhook_events (received_at DESC);
