CREATE TABLE fbo_advertised_prices (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fbo_vendor   TEXT NOT NULL,
  airport_code TEXT NOT NULL,
  volume_tier  TEXT NOT NULL DEFAULT '1+',   -- e.g. "1+", "5,001-10,000"
  product      TEXT NOT NULL DEFAULT 'Jet-A',
  price        NUMERIC(10,5) NOT NULL,
  tail_numbers TEXT,                          -- NULL = all tails, else comma-separated
  week_start   DATE NOT NULL,                -- Monday of that week
  upload_batch TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(fbo_vendor, airport_code, volume_tier, tail_numbers, week_start)
);

ALTER TABLE fbo_advertised_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON fbo_advertised_prices FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read" ON fbo_advertised_prices FOR SELECT TO authenticated USING (true);
