-- Fuel vendors registry
-- Stores all fuel vendors with their contact details and release method.
-- Used by the fuel release system to determine how to request fuel (email, card, or API).

CREATE TABLE fuel_vendors (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  contact_email TEXT,
  release_type TEXT NOT NULL DEFAULT 'email' CHECK (release_type IN ('email', 'card', 'api')),
  is_international BOOLEAN NOT NULL DEFAULT false,
  requires_destination BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_fuel_vendors_active ON fuel_vendors (active) WHERE active = true;
CREATE INDEX idx_fuel_vendors_slug ON fuel_vendors (slug);

-- RLS
ALTER TABLE fuel_vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read fuel vendors"
  ON fuel_vendors FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role full access"
  ON fuel_vendors FOR ALL TO service_role USING (true);

-- Seed data from Jawad's vendor list (2026-04-10)
INSERT INTO fuel_vendors (name, slug, contact_email, release_type, is_international, requires_destination, notes) VALUES
  -- Domestic fuel releases
  ('Everest',       'everest',      'fuelmanagement@everest-fuel.com', 'email', false, false, NULL),
  ('EVO',           'evo',          'orderfuel@flyevo.com',            'email', false, false, NULL),
  ('AEG',           'aeg',          'dispatch@aegfuels.com',           'email', false, false, NULL),
  ('World Fuels',   'wfs',          'fuel24@wfscorp.com',              'email', false, false, NULL),
  -- International releases
  ('AvFuel',        'avfuel',       'contractfuel@avfuel.com',         'email', true,  true,  'They will also want destination'),
  ('Everest (Intl)','everest-intl', 'fuelmanagement@everest-fuel.com', 'email', true,  true,  'They will also want destination'),
  ('EVO (Intl)',    'evo-intl',     'orderfuel@flyevo.com',            'email', true,  false, NULL),
  ('AEG (Intl)',    'aeg-intl',     'dispatch@aegfuels.com',           'email', true,  false, NULL),
  ('World Fuels (Intl)', 'wfs-intl','fuel24@wfscorp.com',             'email', true,  false, NULL),
  ('Titan (Intl)',  'titan-intl',   'eudispatch@titanfuels.aero',      'email', true,  false, NULL),
  -- Physical card vendors (no email release)
  ('Signature',     'signature',    NULL,                              'card',  false, false, 'Use Physical Horizon Card'),
  ('Retail',        'retail',       NULL,                              'card',  false, false, 'Use Physical Horizon Card');

-- ─── Email log for reply dedup ───────────────────────────────────────────────

CREATE TABLE fuel_release_email_log (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  graph_message_id TEXT NOT NULL UNIQUE,
  release_id UUID NOT NULL,
  ref_code TEXT NOT NULL,
  from_email TEXT,
  subject TEXT,
  status_resolved TEXT,
  received_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fuel_release_email_log_release ON fuel_release_email_log (release_id);
CREATE INDEX idx_fuel_release_email_log_ref ON fuel_release_email_log (ref_code);

ALTER TABLE fuel_release_email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on email log"
  ON fuel_release_email_log FOR ALL TO service_role USING (true);

-- ─── Updated_at trigger ─────────────────────────────────────────────────────

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_fuel_vendors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fuel_vendors_updated_at
  BEFORE UPDATE ON fuel_vendors
  FOR EACH ROW EXECUTE FUNCTION update_fuel_vendors_updated_at();
