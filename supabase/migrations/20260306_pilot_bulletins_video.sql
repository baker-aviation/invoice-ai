-- Switch pilot_bulletins from PDF-based to video-based (.mov uploads).
-- PDF columns replaced with video GCS columns; video_url removed.

ALTER TABLE pilot_bulletins ADD COLUMN IF NOT EXISTS video_gcs_bucket TEXT;
ALTER TABLE pilot_bulletins ADD COLUMN IF NOT EXISTS video_gcs_key TEXT;
ALTER TABLE pilot_bulletins ADD COLUMN IF NOT EXISTS video_filename TEXT;

ALTER TABLE pilot_bulletins DROP COLUMN IF EXISTS pdf_gcs_bucket;
ALTER TABLE pilot_bulletins DROP COLUMN IF EXISTS pdf_gcs_key;
ALTER TABLE pilot_bulletins DROP COLUMN IF EXISTS pdf_filename;
ALTER TABLE pilot_bulletins DROP COLUMN IF EXISTS video_url;
