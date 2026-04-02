-- Store ForeFlight predicted fuel data for comparison against post-flight actuals
CREATE TABLE IF NOT EXISTS foreflight_predictions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  foreflight_id     text NOT NULL,
  tail_number       text NOT NULL,
  departure_icao    text NOT NULL,
  destination_icao  text NOT NULL,
  departure_time    timestamptz,
  arrival_time      timestamptz,
  -- Fuel predictions (lbs)
  fuel_to_dest_lbs  numeric(10,1),
  total_fuel_lbs    numeric(10,1),
  flight_fuel_lbs   numeric(10,1),
  taxi_fuel_lbs     numeric(10,1),
  reserve_fuel_lbs  numeric(10,1),
  -- Weights (lbs)
  ramp_weight       numeric(10,1),
  takeoff_weight    numeric(10,1),
  landing_weight    numeric(10,1),
  zero_fuel_weight  numeric(10,1),
  -- Performance
  time_to_dest_min  numeric(6,1),
  route_nm          numeric(8,1),
  gc_nm             numeric(8,1),
  wind_component    numeric(6,1),
  isa_deviation     numeric(6,1),
  cruise_profile    text,
  -- Matching
  callsign          text,
  flight_date       date NOT NULL,
  synced_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE(foreflight_id)
);

ALTER TABLE foreflight_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON foreflight_predictions
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Authenticated can read" ON foreflight_predictions
  FOR SELECT TO authenticated USING (true);

CREATE INDEX idx_ff_pred_tail_date ON foreflight_predictions (tail_number, flight_date);
CREATE INDEX idx_ff_pred_route ON foreflight_predictions (departure_icao, destination_icao, flight_date);
