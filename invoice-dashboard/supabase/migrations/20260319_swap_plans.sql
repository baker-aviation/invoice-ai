-- Swap plan persistence & impact tracking
-- Phase 1: Save/load optimizer results so plans survive page refresh
-- Phase 2: Cross-reference flight change alerts against saved plans

-- ─── swap_plans ─────────────────────────────────────────────────────────────

CREATE TABLE swap_plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  swap_date DATE NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  plan_data JSONB NOT NULL,
  swap_assignments JSONB,
  oncoming_pool JSONB,
  strategy TEXT,
  total_cost NUMERIC,
  solved_count INTEGER,
  unsolved_count INTEGER,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT
);

-- Only one active plan per swap date
CREATE UNIQUE INDEX swap_plans_active_idx ON swap_plans (swap_date) WHERE status = 'active';
CREATE INDEX swap_plans_date_idx ON swap_plans (swap_date, version DESC);

ALTER TABLE swap_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on swap_plans"
  ON swap_plans FOR ALL
  USING (true)
  WITH CHECK (true);

-- ─── swap_plan_impacts ──────────────────────────────────────────────────────

CREATE TABLE swap_plan_impacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  swap_plan_id UUID NOT NULL REFERENCES swap_plans(id) ON DELETE CASCADE,
  alert_id UUID NOT NULL REFERENCES swap_leg_alerts(id) ON DELETE CASCADE,
  tail_number TEXT NOT NULL,
  affected_crew JSONB NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(swap_plan_id, alert_id)
);

CREATE INDEX swap_plan_impacts_plan_idx ON swap_plan_impacts (swap_plan_id) WHERE NOT resolved;

ALTER TABLE swap_plan_impacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on swap_plan_impacts"
  ON swap_plan_impacts FOR ALL
  USING (true)
  WITH CHECK (true);
