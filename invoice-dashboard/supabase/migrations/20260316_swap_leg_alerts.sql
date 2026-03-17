-- Swap leg change alerts (Phase 4)
-- Tracks changes to Wednesday flights that may affect crew swap points.
-- Populated by ops-monitor when sync_schedule detects changes.

CREATE TABLE swap_leg_alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  flight_id UUID REFERENCES flights(id) ON DELETE SET NULL,
  tail_number TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('added', 'cancelled', 'time_change', 'airport_change')),
  old_value JSONB,
  new_value JSONB,
  swap_date DATE NOT NULL,
  detected_at TIMESTAMPTZ DEFAULT now(),
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX swap_leg_alerts_date_idx ON swap_leg_alerts (swap_date) WHERE NOT acknowledged;
CREATE INDEX swap_leg_alerts_tail_idx ON swap_leg_alerts (tail_number, swap_date);

-- RLS
ALTER TABLE swap_leg_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read swap_leg_alerts"
  ON swap_leg_alerts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access to swap_leg_alerts"
  ON swap_leg_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);
