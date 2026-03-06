-- Add document/image attachment columns to pilot_bulletins (PDF, images)
ALTER TABLE pilot_bulletins ADD COLUMN IF NOT EXISTS doc_gcs_bucket TEXT;
ALTER TABLE pilot_bulletins ADD COLUMN IF NOT EXISTS doc_gcs_key TEXT;
ALTER TABLE pilot_bulletins ADD COLUMN IF NOT EXISTS doc_filename TEXT;
