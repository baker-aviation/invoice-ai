-- Vehicle registry: type, role, zone, loadout for every Samsara vehicle
CREATE TABLE IF NOT EXISTS vehicle_registry (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  samsara_id    text   NOT NULL UNIQUE REFERENCES samsara_vehicles(samsara_id),
  name          text,

  -- Classification
  vehicle_type  text   NOT NULL DEFAULT 'unknown'
    CHECK (vehicle_type IN ('van','truck','crew_car','personal','cleaning','unknown')),
  vehicle_role  text   NOT NULL DEFAULT 'unassigned'
    CHECK (vehicle_role IN ('aog_response','parts_transport','crew_shuttle','utility','unassigned')),

  -- Zone assignment (nullable = unassigned)
  zone_id       int,
  zone_name     text,

  -- What's on board (free-form for MX to populate over time)
  loadout       text[] NOT NULL DEFAULT '{}',
  notes         text,

  -- Metadata
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vehicle_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON vehicle_registry
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read" ON vehicle_registry
  FOR SELECT TO authenticated USING (true);

-- Transfer log: every zone reassignment gets tracked
CREATE TABLE IF NOT EXISTS vehicle_transfers (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  samsara_id    text   NOT NULL REFERENCES samsara_vehicles(samsara_id),
  vehicle_name  text,
  from_zone_id  int,
  from_zone_name text,
  to_zone_id    int,
  to_zone_name  text,
  transferred_by text,
  transferred_at timestamptz NOT NULL DEFAULT now(),
  reason        text
);

ALTER TABLE vehicle_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON vehicle_transfers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read" ON vehicle_transfers
  FOR SELECT TO authenticated USING (true);
