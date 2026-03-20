-- Add baker_confirmed flag to us_customs_airports and countries
-- When ops team verifies data is accurate, they toggle this on

ALTER TABLE us_customs_airports ADD COLUMN IF NOT EXISTS baker_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE us_customs_airports ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE us_customs_airports ADD COLUMN IF NOT EXISTS confirmed_by TEXT;

ALTER TABLE countries ADD COLUMN IF NOT EXISTS baker_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE countries ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE countries ADD COLUMN IF NOT EXISTS confirmed_by TEXT;
