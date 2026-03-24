-- Cache ForeFlight route analysis results per route pair.
-- Avoids repeated ForeFlight API calls for the same dep/arr combo.
CREATE TABLE intl_route_cache (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dep_icao    TEXT NOT NULL,
  arr_icao    TEXT NOT NULL,
  ff_route    TEXT,                          -- ForeFlight route string (null = FF unavailable/failed)
  overflights JSONB NOT NULL DEFAULT '[]',   -- [{country_name, country_iso, fir_id}]
  method      TEXT NOT NULL DEFAULT 'great_circle',  -- "foreflight+great_circle" or "great_circle"
  tail_used   TEXT,                          -- tail number used for the FF query
  cached_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(dep_icao, arr_icao)
);

ALTER TABLE intl_route_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON intl_route_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read" ON intl_route_cache FOR SELECT TO authenticated USING (true);

CREATE INDEX idx_intl_route_cache_pair ON intl_route_cache (dep_icao, arr_icao);
