CREATE TABLE IF NOT EXISTS drive_time_cache (
  id SERIAL PRIMARY KEY,
  origin_icao TEXT NOT NULL,
  destination_icao TEXT NOT NULL,
  drive_minutes NUMERIC NOT NULL,
  drive_miles NUMERIC NOT NULL,
  route_geometry TEXT, -- optional: encoded polyline for display
  source TEXT NOT NULL DEFAULT 'osrm', -- 'osrm' or 'haversine'
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(origin_icao, destination_icao)
);

CREATE INDEX idx_drive_time_cache_pair ON drive_time_cache(origin_icao, destination_icao);
