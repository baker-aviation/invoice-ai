-- =============================================================================
-- Enable Row Level Security on all application tables
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
--
-- After running, the public anon key can no longer read/write these tables
-- directly. Only the service_role key (used by backend services) bypasses RLS.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enable RLS on every table
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS parsed_invoices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS invoice_alerts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS invoice_alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS invoice_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS job_applications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS job_application_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS job_application_parse ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS flights             ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ops_alerts          ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Read-only policies for authenticated dashboard users
--    These let logged-in users SELECT data through the anon key / session.
--    INSERT/UPDATE/DELETE is reserved for service_role (backend services).
-- ---------------------------------------------------------------------------

-- documents
CREATE POLICY "Authenticated users can read documents"
  ON documents FOR SELECT
  TO authenticated
  USING (true);

-- parsed_invoices
CREATE POLICY "Authenticated users can read parsed_invoices"
  ON parsed_invoices FOR SELECT
  TO authenticated
  USING (true);

-- invoice_alerts
CREATE POLICY "Authenticated users can read invoice_alerts"
  ON invoice_alerts FOR SELECT
  TO authenticated
  USING (true);

-- invoice_alert_rules
CREATE POLICY "Authenticated users can read invoice_alert_rules"
  ON invoice_alert_rules FOR SELECT
  TO authenticated
  USING (true);

-- invoice_alert_events
CREATE POLICY "Authenticated users can read invoice_alert_events"
  ON invoice_alert_events FOR SELECT
  TO authenticated
  USING (true);

-- job_applications
CREATE POLICY "Authenticated users can read job_applications"
  ON job_applications FOR SELECT
  TO authenticated
  USING (true);

-- job_application_files
CREATE POLICY "Authenticated users can read job_application_files"
  ON job_application_files FOR SELECT
  TO authenticated
  USING (true);

-- job_application_parse
CREATE POLICY "Authenticated users can read job_application_parse"
  ON job_application_parse FOR SELECT
  TO authenticated
  USING (true);

-- flights
CREATE POLICY "Authenticated users can read flights"
  ON flights FOR SELECT
  TO authenticated
  USING (true);

-- ops_alerts (read)
CREATE POLICY "Authenticated users can read ops_alerts"
  ON ops_alerts FOR SELECT
  TO authenticated
  USING (true);

-- ops_alerts (update — for acknowledge button in dashboard)
CREATE POLICY "Authenticated users can update ops_alerts"
  ON ops_alerts FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
