-- baker_ppr_airports: airports requiring Baker PPR (Prior Permission Required)
-- Managed from admin settings; consumed by the ops board to show PPR alerts.

CREATE TABLE IF NOT EXISTS baker_ppr_airports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  icao        text    NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS: allow authenticated users to read, service role for writes
ALTER TABLE baker_ppr_airports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read"
  ON baker_ppr_airports
  FOR SELECT
  USING (auth.role() IN ('authenticated', 'service_role'));

CREATE POLICY "Service role full access"
  ON baker_ppr_airports
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Seed with current hardcoded airports
INSERT INTO baker_ppr_airports (icao) VALUES
  ('KNUQ'),
  ('KSAN'),
  ('KLAS'),
  ('KSNA'),
  ('KJAC'),
  ('KMKY')
ON CONFLICT (icao) DO NOTHING;
