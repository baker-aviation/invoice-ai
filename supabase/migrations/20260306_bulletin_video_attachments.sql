-- Migrate existing video_* data into pilot_bulletin_attachments.
-- Videos now use the same attachments system as PDFs/images.

INSERT INTO pilot_bulletin_attachments (bulletin_id, filename, content_type, gcs_bucket, gcs_key, sort_order)
SELECT
  id,
  video_filename,
  CASE
    WHEN video_filename ~* '\.mp4$' THEN 'video/mp4'
    WHEN video_filename ~* '\.m4v$' THEN 'video/x-m4v'
    WHEN video_filename ~* '\.mov$' THEN 'video/quicktime'
    ELSE 'video/mp4'
  END,
  video_gcs_bucket,
  video_gcs_key,
  -1  -- sort before doc attachments (which start at 0)
FROM pilot_bulletins
WHERE video_gcs_bucket IS NOT NULL
  AND video_gcs_key IS NOT NULL
  AND video_filename IS NOT NULL;

COMMENT ON COLUMN pilot_bulletins.video_gcs_bucket IS 'DEPRECATED — use pilot_bulletin_attachments';
COMMENT ON COLUMN pilot_bulletins.video_gcs_key    IS 'DEPRECATED — use pilot_bulletin_attachments';
COMMENT ON COLUMN pilot_bulletins.video_filename   IS 'DEPRECATED — use pilot_bulletin_attachments';
