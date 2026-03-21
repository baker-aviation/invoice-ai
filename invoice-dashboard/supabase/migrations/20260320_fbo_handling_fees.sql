-- FBO handling/facility fees per airport, FBO, and aircraft type.
-- Source: JetInsight CRM screenshots, manually entered.
-- Used by fuel planning/tankering optimizer to determine fee waiver thresholds.

CREATE TABLE IF NOT EXISTS fbo_handling_fees (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  airport_code     TEXT NOT NULL,               -- FAA/IATA code (e.g. TEB, JFK)
  fbo_name         TEXT NOT NULL,               -- FBO name as shown in JetInsight
  chain            TEXT NOT NULL DEFAULT '',     -- Parent chain (e.g. "Signature Flight Support")
  aircraft_type    TEXT NOT NULL,               -- "Challenger 300" or "Citation X"
  facility_fee     NUMERIC(10,2),              -- Ground handling fee ($) — waivable with fuel purchase
  gallons_to_waive NUMERIC(10,2),              -- Gallons needed to waive facility_fee
  security_fee     NUMERIC(10,2),              -- Security / Infrastructure / Ramp fee ($)
  landing_fee      NUMERIC(10,2),              -- Airport landing fee ($)
  overnight_fee    NUMERIC(10,2),              -- Overnight / Parking fee ($)
  parking_info     TEXT DEFAULT '',             -- Parking fee details (e.g. "1 night / 400 gals")
  hangar_fee       NUMERIC(10,2),
  gpu_fee          NUMERIC(10,2),
  lavatory_fee     NUMERIC(10,2),
  source           TEXT DEFAULT 'jetinsight',   -- Data source
  updated_at       TIMESTAMPTZ DEFAULT now(),
  created_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(airport_code, fbo_name, aircraft_type)
);

-- Indexes for common lookups
CREATE INDEX idx_fbo_handling_fees_airport ON fbo_handling_fees(airport_code);
CREATE INDEX idx_fbo_handling_fees_chain   ON fbo_handling_fees(chain);
CREATE INDEX idx_fbo_handling_fees_lookup  ON fbo_handling_fees(airport_code, aircraft_type);

-- RLS
ALTER TABLE fbo_handling_fees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON fbo_handling_fees
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read" ON fbo_handling_fees
  FOR SELECT TO authenticated USING (true);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_fbo_handling_fees_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fbo_handling_fees_updated_at
  BEFORE UPDATE ON fbo_handling_fees
  FOR EACH ROW EXECUTE FUNCTION update_fbo_handling_fees_updated_at();
