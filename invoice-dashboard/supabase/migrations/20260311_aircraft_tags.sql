-- Aircraft tags (e.g. "Conformity") for long-term maintenance tracking
CREATE TABLE IF NOT EXISTS aircraft_tags (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tail_number     TEXT NOT NULL,
  tag             TEXT NOT NULL,
  note            TEXT,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tail_number, tag)
);

ALTER TABLE aircraft_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read aircraft_tags"
  ON aircraft_tags FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert aircraft_tags"
  ON aircraft_tags FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can delete aircraft_tags"
  ON aircraft_tags FOR DELETE TO authenticated USING (true);

-- Service role full access
CREATE POLICY "Service role full access on aircraft_tags"
  ON aircraft_tags FOR ALL TO service_role USING (true) WITH CHECK (true);
