-- MX Events: native maintenance event tracking for Baker Aviation fleet.
-- Replaces ad-hoc AOG/MX tracking with structured events that support
-- scheduling, van assignment, priority triage, and JetInsight/MEL integration.

CREATE TABLE IF NOT EXISTS mx_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tail_number     TEXT NOT NULL,
  airport_icao    TEXT,
  title           TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL DEFAULT 'unscheduled'
                  CHECK (category IN ('scheduled', 'unscheduled', 'aog', 'deferred', 'inspection')),
  priority        TEXT NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'scheduled', 'in_progress', 'awaiting_parts', 'completed', 'cancelled')),
  scheduled_date  DATE,
  scheduled_end   DATE,
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  estimated_hours NUMERIC(5,1),
  assigned_van    INTEGER,
  assigned_to     TEXT,
  work_order_ref  TEXT,
  source          TEXT DEFAULT 'manual'
                  CHECK (source IN ('manual', 'jetinsight', 'mel_escalation')),
  source_alert_id UUID,
  created_by      TEXT,
  completed_by    TEXT,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mx_events IS
  'Tracks maintenance events (scheduled, unscheduled, AOG, deferred, inspections) '
  'for each tail. Supports van assignment, priority triage, and sourcing from '
  'JetInsight sync or MEL escalation.';

-- Indexes

CREATE INDEX IF NOT EXISTS idx_mx_events_tail
  ON mx_events (tail_number);

CREATE INDEX IF NOT EXISTS idx_mx_events_active_status
  ON mx_events (status)
  WHERE status NOT IN ('completed', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_mx_events_scheduled_date
  ON mx_events (scheduled_date)
  WHERE scheduled_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mx_events_assigned_van
  ON mx_events (assigned_van);

-- Auto-update updated_at on row modification

CREATE OR REPLACE FUNCTION update_mx_events_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mx_events_updated_at
  BEFORE UPDATE ON mx_events
  FOR EACH ROW EXECUTE FUNCTION update_mx_events_updated_at();

-- Row Level Security

ALTER TABLE mx_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all"
  ON mx_events FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_all"
  ON mx_events FOR ALL
  TO authenticated
  USING (true) WITH CHECK (true);
