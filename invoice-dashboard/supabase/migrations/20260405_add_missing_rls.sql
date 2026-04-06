-- Add RLS to 8 tables that were previously missing it.
--
-- All API routes use createServiceClient() (service_role), which bypasses RLS.
-- These policies are defense-in-depth: they restrict what an authenticated user
-- can see if they somehow query Supabase directly with the anon key.
--
-- All 8 tables contain shared operational data — authenticated users get
-- read-only SELECT. No INSERT/UPDATE/DELETE policies: only the service client
-- (API routes) should write.

-- ============================================================================
-- pending_diversions
-- ============================================================================
ALTER TABLE pending_diversions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read pending_diversions"
  ON pending_diversions FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- flightaware_tracks
-- ============================================================================
ALTER TABLE flightaware_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read flightaware_tracks"
  ON flightaware_tracks FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- pilot_routes
-- ============================================================================
ALTER TABLE pilot_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read pilot_routes"
  ON pilot_routes FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- duty_alerts
-- ============================================================================
ALTER TABLE duty_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read duty_alerts"
  ON duty_alerts FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- foreflight_waypoints
-- ============================================================================
ALTER TABLE foreflight_waypoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read foreflight_waypoints"
  ON foreflight_waypoints FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- foreflight_flight_phases
-- ============================================================================
ALTER TABLE foreflight_flight_phases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read foreflight_flight_phases"
  ON foreflight_flight_phases FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- motivational_quotes
-- ============================================================================
ALTER TABLE motivational_quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read motivational_quotes"
  ON motivational_quotes FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- drive_time_cache
-- ============================================================================
ALTER TABLE drive_time_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read drive_time_cache"
  ON drive_time_cache FOR SELECT
  TO authenticated
  USING (true);
