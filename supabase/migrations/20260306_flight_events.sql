-- FlightAware webhook alert events
-- Stores push notifications from AeroAPI alerts (departure, arrival, etc.)
CREATE TABLE IF NOT EXISTS flight_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id      integer,
  event_code    text NOT NULL,                -- filed, departure, arrival, cancelled, diverted
  fa_flight_id  text,
  ident         text,                         -- callsign e.g. "KOW102"
  registration  text,                         -- tail number e.g. "N102VR"
  aircraft_type text,
  origin        text,                         -- ICAO airport code
  destination   text,                         -- ICAO airport code
  summary       text,
  description   text,
  raw_payload   jsonb,                        -- full webhook payload for debugging
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed     boolean NOT NULL DEFAULT false
);

-- Index for quick lookups by tail and recency
CREATE INDEX IF NOT EXISTS idx_flight_events_registration ON flight_events (registration, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_flight_events_event_code ON flight_events (event_code, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_flight_events_unprocessed ON flight_events (processed) WHERE NOT processed;

-- RLS: service role only (webhook receiver uses service client)
ALTER TABLE flight_events ENABLE ROW LEVEL SECURITY;

-- FlightAware alert registrations (track active alerts for cleanup)
CREATE TABLE IF NOT EXISTS fa_alert_registrations (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tail          text NOT NULL,
  alert_id      integer NOT NULL,             -- FA alert ID returned from POST /alerts
  created_at    timestamptz NOT NULL DEFAULT now(),
  active        boolean NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_alert_reg_tail ON fa_alert_registrations (tail) WHERE active;

ALTER TABLE fa_alert_registrations ENABLE ROW LEVEL SECURITY;
