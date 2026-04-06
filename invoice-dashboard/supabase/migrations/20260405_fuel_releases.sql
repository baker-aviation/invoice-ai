-- Fuel release tracking table.
-- Records every fuel release request (automated or manual) with full audit trail.

CREATE TABLE IF NOT EXISTS fuel_releases (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Who submitted
  submitted_by        TEXT NOT NULL,
  submitted_by_email  TEXT,

  -- Flight context
  tail_number         TEXT NOT NULL,
  airport_code        TEXT NOT NULL,
  fbo_name            TEXT,
  departure_date      DATE NOT NULL,

  -- Fuel details
  vendor_id           TEXT NOT NULL,             -- 'evo', 'wfs', 'avfuel', 'manual'
  vendor_name         TEXT NOT NULL,             -- human-readable name
  gallons_requested   NUMERIC NOT NULL,
  quoted_price        NUMERIC,                   -- price/gal at time of request
  actual_price        NUMERIC,                   -- price/gal actually charged
  actual_gallons      NUMERIC,                   -- gallons actually delivered

  -- Status
  status              TEXT NOT NULL DEFAULT 'pending',
  vendor_confirmation TEXT,
  status_history      JSONB DEFAULT '[]'::JSONB,

  -- Link to plan
  plan_link_token     TEXT,
  plan_leg_index      INT,

  -- Notes
  notes               TEXT,
  cancellation_reason TEXT
);

CREATE INDEX idx_fuel_releases_tail_date ON fuel_releases (tail_number, departure_date);
CREATE INDEX idx_fuel_releases_status ON fuel_releases (status) WHERE status IN ('pending', 'confirmed');
CREATE INDEX idx_fuel_releases_created ON fuel_releases (created_at DESC);

ALTER TABLE fuel_releases ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read
CREATE POLICY fuel_releases_read ON fuel_releases
  FOR SELECT TO authenticated USING (true);

-- Service role has full access (API routes use service client)
CREATE POLICY fuel_releases_service ON fuel_releases
  FOR ALL TO service_role USING (true) WITH CHECK (true);
