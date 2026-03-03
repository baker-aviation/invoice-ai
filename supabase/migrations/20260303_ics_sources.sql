-- ics_sources: manages JetInsight ICS feed URLs per aircraft
-- Replaces the JETINSIGHT_ICS_URLS env var so URLs can be added
-- from the admin settings page without redeploying ops-monitor.

CREATE TABLE IF NOT EXISTS ics_sources (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label       text    NOT NULL,             -- human name, e.g. "N936BA" or "Fleet CL-350"
  url         text    NOT NULL,             -- full ICS URL (with token)
  enabled     boolean NOT NULL DEFAULT true,
  last_sync_at   timestamptz,              -- updated by ops-monitor after each sync
  last_sync_ok   boolean,                  -- true = success, false = fetch error
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS: service role only (backend + admin API use service_role_key)
ALTER TABLE ics_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON ics_sources
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
