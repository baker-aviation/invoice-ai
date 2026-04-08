-- FBO fees reported directly by FBOs (via email responses).
-- Separate from fbo_handling_fees (JetInsight-scraped) so we can
-- compare the two sources side-by-side.

CREATE TABLE IF NOT EXISTS fbo_direct_fees (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  airport_code     TEXT NOT NULL,
  fbo_name         TEXT NOT NULL,
  aircraft_type    TEXT NOT NULL,

  -- Fee fields (same as fbo_handling_fees for 1:1 comparison)
  facility_fee     NUMERIC(10,2),
  gallons_to_waive NUMERIC(10,2),
  security_fee     NUMERIC(10,2),
  landing_fee      NUMERIC(10,2),
  overnight_fee    NUMERIC(10,2),
  parking_info     TEXT DEFAULT '',
  hangar_fee       NUMERIC(10,2),
  gpu_fee          NUMERIC(10,2),
  lavatory_fee     NUMERIC(10,2),
  jet_a_price      NUMERIC(10,4),
  avgas_price      NUMERIC(10,4),
  deice_fee        NUMERIC(10,2),
  afterhours_fee   NUMERIC(10,2),
  customs_fee      NUMERIC(10,2),
  callout_fee      NUMERIC(10,2),
  ramp_fee         NUMERIC(10,2),

  -- Provenance
  source_email     TEXT NOT NULL DEFAULT '',
  source_date      DATE,
  raw_response     TEXT NOT NULL DEFAULT '',
  confidence       TEXT NOT NULL DEFAULT 'manual'
                   CHECK (confidence IN ('manual', 'ai-parsed', 'confirmed')),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(airport_code, fbo_name, aircraft_type)
);

CREATE INDEX idx_fbo_direct_fees_airport ON fbo_direct_fees(airport_code);
CREATE INDEX idx_fbo_direct_fees_lookup  ON fbo_direct_fees(airport_code, aircraft_type);

-- RLS
ALTER TABLE fbo_direct_fees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON fbo_direct_fees
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read" ON fbo_direct_fees
  FOR SELECT TO authenticated USING (true);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_fbo_direct_fees_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fbo_direct_fees_updated_at
  BEFORE UPDATE ON fbo_direct_fees
  FOR EACH ROW EXECUTE FUNCTION update_fbo_direct_fees_updated_at();
