-- Multi-attachment support for pilot bulletins.
-- New table stores one row per attachment (PDF/image).
-- Video stays as columns on pilot_bulletins (always singular).

CREATE TABLE IF NOT EXISTS pilot_bulletin_attachments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bulletin_id   BIGINT NOT NULL REFERENCES pilot_bulletins(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  gcs_bucket    TEXT NOT NULL,
  gcs_key       TEXT NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulletin_attachments_bulletin
  ON pilot_bulletin_attachments (bulletin_id, sort_order);

-- RLS
ALTER TABLE pilot_bulletin_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON pilot_bulletin_attachments
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read" ON pilot_bulletin_attachments
  FOR SELECT
  TO authenticated
  USING (true);

-- Migrate existing doc_* data into the new table
INSERT INTO pilot_bulletin_attachments (bulletin_id, filename, content_type, gcs_bucket, gcs_key, sort_order)
SELECT
  id,
  doc_filename,
  CASE
    WHEN doc_filename ~* '\.(jpg|jpeg)$' THEN 'image/jpeg'
    WHEN doc_filename ~* '\.png$' THEN 'image/png'
    WHEN doc_filename ~* '\.gif$' THEN 'image/gif'
    WHEN doc_filename ~* '\.webp$' THEN 'image/webp'
    WHEN doc_filename ~* '\.pdf$' THEN 'application/pdf'
    ELSE 'application/octet-stream'
  END,
  doc_gcs_bucket,
  doc_gcs_key,
  0
FROM pilot_bulletins
WHERE doc_gcs_bucket IS NOT NULL
  AND doc_gcs_key IS NOT NULL
  AND doc_filename IS NOT NULL;

-- Mark old columns as deprecated (don't drop yet for safety)
COMMENT ON COLUMN pilot_bulletins.doc_gcs_bucket IS 'DEPRECATED — use pilot_bulletin_attachments';
COMMENT ON COLUMN pilot_bulletins.doc_gcs_key    IS 'DEPRECATED — use pilot_bulletin_attachments';
COMMENT ON COLUMN pilot_bulletins.doc_filename   IS 'DEPRECATED — use pilot_bulletin_attachments';
