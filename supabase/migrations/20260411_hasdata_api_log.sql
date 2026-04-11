-- Phase 7a: HasData API usage log.
-- Instruments src/lib/hasdata.ts searchFlights() to track how often the
-- scraper is called, from where, and with what latency.
CREATE TABLE IF NOT EXISTS hasdata_api_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  called_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  endpoint        TEXT NOT NULL,
  origin          TEXT,
  destination     TEXT,
  flight_date     DATE,
  adults          INTEGER,
  result_count    INTEGER NOT NULL DEFAULT 0,
  status_code     INTEGER,
  http_ok         BOOLEAN NOT NULL DEFAULT false,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  caller          TEXT,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_hasdata_api_log_called_at ON hasdata_api_log(called_at DESC);
CREATE INDEX IF NOT EXISTS idx_hasdata_api_log_caller ON hasdata_api_log(caller);

ALTER TABLE hasdata_api_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON hasdata_api_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read" ON hasdata_api_log
  FOR SELECT TO authenticated USING (true);
