-- Per-user preferences (map toggles, etc.)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

-- Users can read/write their own preferences
CREATE POLICY "Users manage own preferences"
  ON user_preferences FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role full access
CREATE POLICY "Service role full access"
  ON user_preferences FOR ALL TO service_role
  USING (true) WITH CHECK (true);
