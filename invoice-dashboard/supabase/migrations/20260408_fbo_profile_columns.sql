-- Add FBO profile columns scraped from JetInsight detail modals
-- (email, URL, services list, JI UUID for incremental scraping)

ALTER TABLE fbo_handling_fees
  ADD COLUMN IF NOT EXISTS email               TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS url                  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS services             TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ji_fbo_uuid          TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ji_source_updated_at TIMESTAMPTZ DEFAULT NULL;

-- Fast lookups by JI UUID (for incremental detail scraping)
CREATE INDEX IF NOT EXISTS idx_fbo_ji_uuid
  ON fbo_handling_fees(ji_fbo_uuid) WHERE ji_fbo_uuid IS NOT NULL;

-- Filter FBOs that have email addresses
CREATE INDEX IF NOT EXISTS idx_fbo_has_email
  ON fbo_handling_fees(airport_code) WHERE email != '';
