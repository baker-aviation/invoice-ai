-- Crew name alias table for cross-system name resolution.
-- Maps alternate names from different systems (sheet, jetinsight, slack)
-- to a single crew_member record. Replaces hardcoded maps in source code.

CREATE TABLE IF NOT EXISTS crew_name_aliases (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  crew_member_id UUID NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('sheet', 'jetinsight', 'slack', 'manual')),
  alias_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  confirmed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_aliases_member ON crew_name_aliases(crew_member_id);
CREATE INDEX IF NOT EXISTS idx_aliases_lookup ON crew_name_aliases(normalized_name, source);

-- Enable RLS
ALTER TABLE crew_name_aliases ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read
CREATE POLICY "Allow authenticated read" ON crew_name_aliases
  FOR SELECT USING (auth.role() = 'authenticated');

-- Allow service role to manage
CREATE POLICY "Allow service role all" ON crew_name_aliases
  FOR ALL USING (auth.role() = 'service_role');
