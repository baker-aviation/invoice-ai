-- FBO fees scraped from FBO chain websites (Atlantic, Signature, etc.)
-- Third source alongside JetInsight (fbo_handling_fees) and Direct email (fbo_direct_fees).

CREATE TABLE IF NOT EXISTS fbo_website_fees (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  airport_code     TEXT NOT NULL,
  fbo_name         TEXT NOT NULL,
  chain            TEXT NOT NULL DEFAULT '',
  aircraft_type    TEXT NOT NULL,

  -- Fee fields
  facility_fee     NUMERIC(10,2),
  handling_fee     NUMERIC(10,2),
  gallons_to_waive NUMERIC(10,2),
  security_fee     NUMERIC(10,2),
  infrastructure_fee NUMERIC(10,2),
  landing_fee      NUMERIC(10,2),
  overnight_fee    NUMERIC(10,2),
  parking_info     TEXT DEFAULT '',
  hangar_fee       NUMERIC(10,2),
  hangar_info      TEXT DEFAULT '',
  gpu_fee          NUMERIC(10,2),
  lavatory_fee     NUMERIC(10,2),
  water_fee        NUMERIC(10,2),

  -- Fuel
  jet_a_price      NUMERIC(10,4),
  jet_a_additive_price NUMERIC(10,4),
  avgas_price      NUMERIC(10,4),
  saf_price        NUMERIC(10,4),

  -- Contact
  phone            TEXT DEFAULT '',
  email            TEXT DEFAULT '',

  -- Location (from website data)
  icao             TEXT DEFAULT '',
  city             TEXT DEFAULT '',
  state            TEXT DEFAULT '',
  country          TEXT DEFAULT '',

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(airport_code, fbo_name, aircraft_type)
);

CREATE INDEX idx_fbo_website_fees_airport ON fbo_website_fees(airport_code);
CREATE INDEX idx_fbo_website_fees_lookup  ON fbo_website_fees(airport_code, aircraft_type);

ALTER TABLE fbo_website_fees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON fbo_website_fees
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read" ON fbo_website_fees
  FOR SELECT TO authenticated USING (true);
