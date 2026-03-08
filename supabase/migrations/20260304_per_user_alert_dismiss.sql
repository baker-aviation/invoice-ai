-- =============================================================================
-- Per-user alert dismissals
-- Replaces the global acknowledged_at column on ops_alerts with a separate
-- table so each user has their own dismiss state.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ops_alert_dismissals (
  alert_id    UUID NOT NULL REFERENCES ops_alerts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  dismissed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (alert_id, user_id)
);

CREATE INDEX idx_ops_alert_dismissals_user
  ON ops_alert_dismissals (user_id);

-- RLS
ALTER TABLE ops_alert_dismissals ENABLE ROW LEVEL SECURITY;

-- Users can read their own dismissals
CREATE POLICY "Users can read own dismissals"
  ON ops_alert_dismissals FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Users can insert their own dismissals
CREATE POLICY "Users can dismiss alerts"
  ON ops_alert_dismissals FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Service role has full access (for API routes using service client)
CREATE POLICY "Service role full access"
  ON ops_alert_dismissals FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
