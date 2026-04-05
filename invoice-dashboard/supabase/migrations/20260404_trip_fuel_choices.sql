-- Trip fuel choices — what the sales rep actually picked (scraped from JetInsight trip notes)
CREATE TABLE IF NOT EXISTS trip_fuel_choices (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jetinsight_trip_id  TEXT NOT NULL,
  airport_code        TEXT NOT NULL,           -- ICAO code where fuel was ordered
  fbo_name            TEXT NOT NULL,           -- FBO the rep picked (e.g. "Jet Aviation")
  fuel_vendor         TEXT NOT NULL,           -- Fuel vendor (e.g. "WFS", "Avfuel")
  volume_tier         TEXT NOT NULL DEFAULT '1+', -- Volume tier (e.g. "1+", "200+")
  price_per_gallon    NUMERIC(10,5) NOT NULL,  -- Price rep got
  salesperson         TEXT,                     -- Sales rep who made the choice
  tail_number         TEXT,                     -- Aircraft tail
  flight_date         DATE,                     -- Date of the flight
  -- Computed comparison fields (filled by review logic)
  best_price_at_fbo   NUMERIC(10,5),           -- Cheapest vendor at that FBO
  best_vendor_at_fbo  TEXT,                     -- Who offered the best price
  best_price_at_airport NUMERIC(10,5),         -- Cheapest vendor at any FBO at the airport
  best_vendor_at_airport TEXT,
  overpay_per_gallon  NUMERIC(10,5),           -- price_per_gallon - best_price_at_fbo
  created_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE(jetinsight_trip_id, airport_code)
);

CREATE INDEX idx_trip_fuel_choices_airport ON trip_fuel_choices (airport_code);
CREATE INDEX idx_trip_fuel_choices_trip ON trip_fuel_choices (jetinsight_trip_id);
CREATE INDEX idx_trip_fuel_choices_created ON trip_fuel_choices (created_at DESC);

-- RLS
ALTER TABLE trip_fuel_choices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read trip fuel choices"
  ON trip_fuel_choices FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access on trip fuel choices"
  ON trip_fuel_choices FOR ALL TO service_role USING (true) WITH CHECK (true);
