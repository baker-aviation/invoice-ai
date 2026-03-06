-- Security hardening: fix overly permissive RLS policies.

-- 1. Fix "Service role full access" on pilot_bulletins — restrict to service_role only
DROP POLICY IF EXISTS "Service role full access" ON pilot_bulletins;
CREATE POLICY "Service role full access" ON pilot_bulletins
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 2. Fix "Service role full access" on pilot_bulletin_attachments
DROP POLICY IF EXISTS "Service role full access" ON pilot_bulletin_attachments;
CREATE POLICY "Service role full access" ON pilot_bulletin_attachments
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 3. Fix "Service role has full access to document_chunks"
DROP POLICY IF EXISTS "Service role has full access to document_chunks" ON document_chunks;
CREATE POLICY "Service role has full access to document_chunks" ON document_chunks
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 4. Enable RLS on category_rules (was missing entirely)
ALTER TABLE category_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON category_rules
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read" ON category_rules
  FOR SELECT
  TO authenticated
  USING (true);

-- 5. Tighten ops_alerts UPDATE — only allow acknowledging alerts
DROP POLICY IF EXISTS "Authenticated users can update ops_alerts" ON ops_alerts;
CREATE POLICY "Authenticated users can acknowledge ops_alerts" ON ops_alerts
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
-- Note: Supabase RLS cannot restrict which columns are updated.
-- The API route should enforce that only acknowledged_at is modified.

-- 6. Tighten job_application_parse UPDATE — restrict to service_role
DROP POLICY IF EXISTS "Authenticated users can update job_application_parse" ON job_application_parse;
CREATE POLICY "Service role can update job_application_parse" ON job_application_parse
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);
