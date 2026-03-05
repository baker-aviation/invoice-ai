-- Pilot bulletins: formal bulletins (PDFs + optional video) organized by category.
-- Admins publish; pilots browse read-only.

CREATE TABLE IF NOT EXISTS pilot_bulletins (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         TEXT NOT NULL,
  summary       TEXT,
  category      TEXT NOT NULL CHECK (category IN ('chief_pilot', 'operations', 'tims', 'maintenance')),
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES auth.users(id),
  pdf_gcs_bucket TEXT,
  pdf_gcs_key   TEXT,
  pdf_filename  TEXT,
  video_url     TEXT,
  slack_ts      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pilot_bulletins_category ON pilot_bulletins (category);
CREATE INDEX IF NOT EXISTS idx_pilot_bulletins_published ON pilot_bulletins (published_at DESC);

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_pilot_bulletins_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pilot_bulletins_timestamp
  BEFORE UPDATE ON pilot_bulletins
  FOR EACH ROW
  EXECUTE FUNCTION update_pilot_bulletins_timestamp();

-- RLS
ALTER TABLE pilot_bulletins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON pilot_bulletins
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read" ON pilot_bulletins
  FOR SELECT
  TO authenticated
  USING (true);
