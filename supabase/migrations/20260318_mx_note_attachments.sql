-- MX Note attachments table (mirrors pilot_bulletin_attachments pattern)
CREATE TABLE IF NOT EXISTS mx_note_attachments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id    UUID NOT NULL REFERENCES ops_alerts(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  gcs_bucket  TEXT NOT NULL,
  gcs_key     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mx_note_attachments_alert_id ON mx_note_attachments(alert_id);
