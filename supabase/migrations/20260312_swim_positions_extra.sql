-- Add extra fields from TFMS messages to swim_positions
ALTER TABLE swim_positions ADD COLUMN IF NOT EXISTS aircraft_type text;        -- C750, CL30, etc.
ALTER TABLE swim_positions ADD COLUMN IF NOT EXISTS flight_status text;        -- PLANNED, ACTIVE, COMPLETED
ALTER TABLE swim_positions ADD COLUMN IF NOT EXISTS etd timestamptz;           -- estimated time of departure
ALTER TABLE swim_positions ADD COLUMN IF NOT EXISTS eta timestamptz;           -- estimated time of arrival
