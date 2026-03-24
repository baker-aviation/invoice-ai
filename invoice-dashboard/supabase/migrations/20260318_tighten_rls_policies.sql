-- Tighten RLS SELECT policies on sensitive tables.
--
-- All API routes use createServiceClient() (service_role), which bypasses RLS.
-- These policies are defense-in-depth: they restrict what an authenticated user
-- can see if they somehow query Supabase directly with the anon key.
--
-- Tables with sensitive PII get admin-only SELECT. Operational/cache tables
-- keep USING (true) since they contain public or shared operational data.

-- ============================================================================
-- pilot_profiles — medical data, passport expiry, personal info
-- ============================================================================
DROP POLICY IF EXISTS "authenticated_read_pilot_profiles" ON pilot_profiles;
CREATE POLICY "admin_or_own_read_pilot_profiles"
  ON pilot_profiles FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- ============================================================================
-- pilot_time_off_requests — scheduling intent is private
-- ============================================================================
DROP POLICY IF EXISTS "authenticated_read_pilot_time_off_requests" ON pilot_time_off_requests;
CREATE POLICY "admin_or_own_read_pilot_time_off_requests"
  ON pilot_time_off_requests FOR SELECT
  TO authenticated
  USING (
    pilot_profile_id IN (
      SELECT id FROM pilot_profiles WHERE user_id = auth.uid()
    )
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- ============================================================================
-- job_applications — applicant PII (contact info, resume content)
-- ============================================================================
DROP POLICY IF EXISTS "authenticated_read_job_applications" ON job_applications;
CREATE POLICY "admin_read_job_applications"
  ON job_applications FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- ============================================================================
-- job_application_files — resume files (GCS refs)
-- ============================================================================
DROP POLICY IF EXISTS "authenticated_read_job_application_files" ON job_application_files;
CREATE POLICY "admin_read_job_application_files"
  ON job_application_files FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- ============================================================================
-- job_application_parses — extracted resume data
-- ============================================================================
DROP POLICY IF EXISTS "authenticated_read_job_application_parses" ON job_application_parses;
CREATE POLICY "admin_read_job_application_parses"
  ON job_application_parses FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- ============================================================================
-- Tables that KEEP broad read access (shared operational / public data):
--   crew_members, crew_rotations, flights, ops_alerts, documents,
--   parsed_invoices, invoice_alerts, commercial_flight_cache,
--   hasdata_flight_cache, swap_leg_alerts, volunteer_responses,
--   airport_aliases, aircraft_tags, van_leg_notes
-- ============================================================================
-- No changes — these are intentionally readable by all authenticated users
-- because pilots, van drivers, and ops staff need shared visibility.
