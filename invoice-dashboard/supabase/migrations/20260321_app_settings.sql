-- Simple key-value settings table for app-wide toggles
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT 'true',
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON app_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read" ON app_settings FOR SELECT TO authenticated USING (true);

-- Default: Slack enabled
INSERT INTO app_settings (key, value) VALUES ('slack_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
