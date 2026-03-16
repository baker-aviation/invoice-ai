-- Per-flight FlightAware state table.
-- Replaces the single-row JSON blob in flight_cache with individual rows
-- that can be updated independently by webhooks and targeted polling.

CREATE TABLE IF NOT EXISTS fa_flights (
  fa_flight_id TEXT PRIMARY KEY,
  tail TEXT NOT NULL,
  ident TEXT,
  origin_icao TEXT,
  origin_name TEXT,
  destination_icao TEXT,
  destination_name TEXT,
  status TEXT,                       -- Scheduled, En Route, Landed, Arrived, Diverted, Cancelled, Filed
  progress_percent INTEGER,
  -- Times (ISO 8601 UTC)
  departure_time TIMESTAMPTZ,        -- best available: actual_out ?? estimated_out ?? scheduled_out
  arrival_time TIMESTAMPTZ,          -- ETA: estimated_on ?? scheduled_on
  scheduled_arrival TIMESTAMPTZ,     -- scheduled_on
  actual_departure TIMESTAMPTZ,      -- actual_out ?? actual_off
  actual_arrival TIMESTAMPTZ,        -- actual_in ?? actual_on
  -- Route
  route TEXT,
  route_distance_nm INTEGER,
  filed_altitude INTEGER,
  -- Flags
  diverted BOOLEAN DEFAULT false,
  cancelled BOOLEAN DEFAULT false,
  -- Aircraft
  aircraft_type TEXT,
  -- Live position
  latitude NUMERIC,
  longitude NUMERIC,
  altitude INTEGER,
  groundspeed INTEGER,
  heading INTEGER,
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Query patterns: by tail, by status, by recency
CREATE INDEX idx_fa_flights_tail ON fa_flights(tail);
CREATE INDEX idx_fa_flights_status ON fa_flights(status) WHERE status IN ('En Route', 'Diverted', 'Scheduled', 'Filed');
CREATE INDEX idx_fa_flights_updated ON fa_flights(updated_at DESC);

-- Track last discovery poll time per tail (avoids re-polling recently checked tails)
CREATE TABLE IF NOT EXISTS fa_poll_state (
  key TEXT PRIMARY KEY,              -- 'last_discovery' or 'last_enroute'
  value TIMESTAMPTZ DEFAULT now()
);
INSERT INTO fa_poll_state (key, value) VALUES ('last_discovery', now()), ('last_enroute', now())
ON CONFLICT (key) DO NOTHING;
