-- JetInsight portal scraper: config, documents, sync runs
-- Read-only scraper pulls compliance documents from portal.jetinsight.com

-- Key/value config for session cookie and org UUID
CREATE TABLE IF NOT EXISTS jetinsight_config (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  config_key    text NOT NULL UNIQUE,
  config_value  text NOT NULL,
  updated_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jetinsight_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON jetinsight_config
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Seed the org UUID
INSERT INTO jetinsight_config (config_key, config_value)
VALUES ('org_uuid', '534fc2f3-f536-4e33-ad3b-afc4268c3cc6')
ON CONFLICT (config_key) DO NOTHING;

-- Scraped document metadata
CREATE TABLE IF NOT EXISTS jetinsight_documents (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type       text NOT NULL CHECK (entity_type IN ('crew', 'aircraft')),
  entity_id         text NOT NULL,
  jetinsight_uuid   text,
  category          text NOT NULL,
  subcategory       text,
  aircraft_type     text,
  document_name     text NOT NULL,
  uploaded_on       date,
  version_label     text,
  gcs_bucket        text NOT NULL,
  gcs_key           text NOT NULL,
  size_bytes        bigint,
  content_type      text,
  jetinsight_url    text,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE(entity_type, entity_id, jetinsight_uuid)
);

ALTER TABLE jetinsight_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON jetinsight_documents
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Authenticated users can read" ON jetinsight_documents
  FOR SELECT TO authenticated USING (true);

CREATE INDEX idx_ji_docs_entity ON jetinsight_documents (entity_type, entity_id);
CREATE INDEX idx_ji_docs_category ON jetinsight_documents (category);

-- Sync run audit log
CREATE TABLE IF NOT EXISTS jetinsight_sync_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sync_type       text NOT NULL,
  status          text NOT NULL DEFAULT 'running',
  crew_synced     int DEFAULT 0,
  aircraft_synced int DEFAULT 0,
  docs_downloaded int DEFAULT 0,
  docs_skipped    int DEFAULT 0,
  errors          jsonb DEFAULT '[]',
  triggered_by    uuid,
  duration_ms     int,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

ALTER TABLE jetinsight_sync_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON jetinsight_sync_runs
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Authenticated users can read" ON jetinsight_sync_runs
  FOR SELECT TO authenticated USING (true);

-- Link pilot profiles to JetInsight crew UUIDs
ALTER TABLE pilot_profiles ADD COLUMN IF NOT EXISTS jetinsight_uuid text;
CREATE INDEX IF NOT EXISTS idx_pilot_profiles_ji_uuid
  ON pilot_profiles (jetinsight_uuid) WHERE jetinsight_uuid IS NOT NULL;
