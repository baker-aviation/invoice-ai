-- Pending diversions table for delayed verification of FlightAware diversion alerts.
-- Instead of firing Slack alerts immediately (which causes false positives when FA
-- sends spurious diversion events), we hold them for ~5 min and re-verify.

CREATE TABLE IF NOT EXISTS pending_diversions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fa_flight_id text NOT NULL,
  registration text NOT NULL,
  origin_icao text,
  destination_icao text,          -- FA's reported diversion destination
  original_destination text,      -- original planned destination from ICS flights table
  flight_id uuid REFERENCES flights(id),
  diversion_message text NOT NULL,
  source text NOT NULL DEFAULT 'webhook',  -- 'webhook' or 'run-checks'
  distance_suspect boolean DEFAULT false,  -- true if distance check flagged it as borderline
  created_at timestamptz DEFAULT now(),
  verified_at timestamptz,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'suppressed')),
  UNIQUE(fa_flight_id, flight_id)
);

CREATE INDEX idx_pending_diversions_pending ON pending_diversions(status, created_at)
  WHERE status = 'pending';
