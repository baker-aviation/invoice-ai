-- Cached tankering plan data per stop.
-- Written by the tankering-plans cron, read by upcoming-choices API for real gallon estimates.
-- Replaced on each cron run — no history needed.

CREATE TABLE IF NOT EXISTS fuel_plan_cache (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_date       DATE NOT NULL,
  tail_number     TEXT NOT NULL,
  aircraft_type   TEXT,
  leg_index       INT NOT NULL,
  departure_icao  TEXT NOT NULL,
  arrival_icao    TEXT NOT NULL,
  gallons_order   NUMERIC NOT NULL DEFAULT 0,
  price_per_gal   NUMERIC,
  created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(plan_date, tail_number, leg_index)
);

CREATE INDEX idx_fuel_plan_cache_date ON fuel_plan_cache (plan_date);

ALTER TABLE fuel_plan_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY fuel_plan_cache_read ON fuel_plan_cache
  FOR SELECT TO authenticated USING (true);

CREATE POLICY fuel_plan_cache_service ON fuel_plan_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);
