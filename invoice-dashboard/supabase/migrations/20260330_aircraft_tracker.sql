CREATE TABLE IF NOT EXISTS aircraft_tracker (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tail_number text NOT NULL UNIQUE,
  aircraft_type text,
  part_135_flying text,
  wb_date text,
  wb_on_jet_insight text,
  foreflight_wb_built text,
  starlink_on_wb text,
  initial_foreflight_build text,
  foreflight_subscription text,
  foreflight_config_built text,
  validation_complete text,
  beta_tested text,
  go_live_approved text,
  genesis_removed text,
  overall_status text,
  notes text,
  kow_callsign text,
  jet_insight_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE aircraft_tracker ENABLE ROW LEVEL SECURITY;

-- Service role (API routes) gets full access
CREATE POLICY "service_role_all" ON aircraft_tracker FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated admins can read
CREATE POLICY "admin_read" ON aircraft_tracker FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_aircraft_tracker_tail ON aircraft_tracker (tail_number);
CREATE INDEX IF NOT EXISTS idx_aircraft_tracker_status ON aircraft_tracker (overall_status);
