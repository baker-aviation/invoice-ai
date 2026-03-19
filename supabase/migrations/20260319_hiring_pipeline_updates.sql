-- Add hr_reviewed and previously_rejected columns to job_application_parse
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS hr_reviewed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS previously_rejected boolean DEFAULT false;

-- Create hiring_settings table for configurable values (e.g. Calendly URL)
CREATE TABLE IF NOT EXISTS hiring_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE hiring_settings ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read settings
CREATE POLICY "Authenticated users can read hiring_settings"
  ON hiring_settings FOR SELECT
  TO authenticated
  USING (true);

-- Allow admin users to update settings
CREATE POLICY "Admin users can manage hiring_settings"
  ON hiring_settings FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Seed the Calendly interview URL
INSERT INTO hiring_settings (key, value)
VALUES ('interview_calendly_url', 'https://calendly.com/pilot-interviews-baker-aviation/45min?month=2026-03')
ON CONFLICT (key) DO NOTHING;

-- Index for faster previously-rejected lookups
CREATE INDEX IF NOT EXISTS idx_jap_rejected_email ON job_application_parse (email) WHERE rejected_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jap_rejected_phone ON job_application_parse (phone) WHERE rejected_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jap_rejected_name ON job_application_parse (candidate_name) WHERE rejected_at IS NOT NULL AND deleted_at IS NULL;
