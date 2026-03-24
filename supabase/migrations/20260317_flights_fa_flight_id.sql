ALTER TABLE flights ADD COLUMN IF NOT EXISTS fa_flight_id TEXT;
CREATE INDEX IF NOT EXISTS idx_flights_fa_flight_id ON flights(fa_flight_id);
