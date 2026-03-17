-- Performance indexes for ops dashboard at scale
-- Fixes full table scans on flights and ops_alerts under concurrent load

-- flights: time-range queries (fetchFlights uses gte/lte on scheduled_departure)
CREATE INDEX IF NOT EXISTS idx_flights_scheduled_departure
  ON flights (scheduled_departure);

-- ops_alerts: flight join (primary lookup pattern)
CREATE INDEX IF NOT EXISTS idx_ops_alerts_flight_id
  ON ops_alerts (flight_id)
  WHERE flight_id IS NOT NULL;

-- ops_alerts: EDCT orphan query (alert_type + acknowledged_at + created_at)
CREATE INDEX IF NOT EXISTS idx_ops_alerts_edct_orphan
  ON ops_alerts (alert_type, created_at)
  WHERE flight_id IS NULL AND acknowledged_at IS NULL;

-- ops_alerts: airport NOTAM lookups (airport detail page)
CREATE INDEX IF NOT EXISTS idx_ops_alerts_airport_type
  ON ops_alerts (airport_icao, alert_type, created_at DESC);

-- swim_notams: airport + created_at (cleanup job, airport page)
CREATE INDEX IF NOT EXISTS idx_swim_notams_airport_created
  ON swim_notams (airport_icao, created_at DESC);
