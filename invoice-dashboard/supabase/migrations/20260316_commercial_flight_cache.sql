-- Commercial flight schedule cache
-- Pre-loaded from FlightAware AeroAPI for all relevant US airports on swap day.
-- Replaces per-route HasData scraping for route discovery.
-- HasData is only used for pricing on top candidates.

CREATE TABLE commercial_flight_cache (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cache_date DATE NOT NULL,                    -- the Wednesday (or target date)
  origin_icao TEXT NOT NULL,
  origin_iata TEXT NOT NULL,
  destination_icao TEXT NOT NULL,
  destination_iata TEXT NOT NULL,
  flight_number TEXT NOT NULL,                 -- e.g. "AA1489"
  airline_iata TEXT NOT NULL,                  -- e.g. "AA"
  scheduled_departure TIMESTAMPTZ NOT NULL,
  scheduled_arrival TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL,
  aircraft_type TEXT,
  estimated_price INTEGER,                     -- estimated from duration+carrier, NULL until HasData fills in
  hasdata_price INTEGER,                       -- real price from HasData (filled lazily for top candidates)
  is_direct BOOLEAN NOT NULL DEFAULT true,
  fa_flight_id TEXT,                           -- FlightAware flight ID for tracking
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(cache_date, flight_number, scheduled_departure)
);

-- Fast lookups: optimizer queries by date + origin + destination
CREATE INDEX flight_cache_route_idx ON commercial_flight_cache (cache_date, origin_iata, destination_iata);
CREATE INDEX flight_cache_origin_idx ON commercial_flight_cache (cache_date, origin_iata);
CREATE INDEX flight_cache_date_idx ON commercial_flight_cache (cache_date);

-- RLS
ALTER TABLE commercial_flight_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read flight cache"
  ON commercial_flight_cache FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access to flight cache"
  ON commercial_flight_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
