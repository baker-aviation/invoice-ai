-- Store vendor reply email attachments (PDF confirmations) on fuel_releases.
-- Each entry is { name, gcs_key, gcs_bucket, content_type, size, uploaded_at, message_id }.
-- Populated by /api/cron/fuel-release-replies when a matched vendor reply
-- arrives with non-inline attachments.
ALTER TABLE fuel_releases
  ADD COLUMN IF NOT EXISTS reply_attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
