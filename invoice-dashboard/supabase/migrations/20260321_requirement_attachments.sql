-- Add attachment support to country requirements
ALTER TABLE country_requirements
  ADD COLUMN IF NOT EXISTS attachment_url TEXT,
  ADD COLUMN IF NOT EXISTS attachment_filename TEXT;
