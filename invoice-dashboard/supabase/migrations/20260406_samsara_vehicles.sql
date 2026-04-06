-- Track known Samsara vehicle inventory for change detection
CREATE TABLE IF NOT EXISTS samsara_vehicles (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  samsara_id    text   NOT NULL UNIQUE,
  name          text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  check_engine  boolean NOT NULL DEFAULT false
);

ALTER TABLE samsara_vehicles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON samsara_vehicles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read" ON samsara_vehicles
  FOR SELECT TO authenticated USING (true);
