-- Fix Supabase security linter issues
-- 1. Enable RLS on 8 tables missing it
-- 2. Recreate 3 SECURITY DEFINER views as SECURITY INVOKER

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 1: Enable RLS on tables + add policies
-- ═══════════════════════════════════════════════════════════════════════════════

-- All API routes use the service_role key which bypasses RLS entirely.
-- These policies allow authenticated users (dashboard) read access where needed.

-- job_application_parses
ALTER TABLE public.job_application_parses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read job_application_parses"
  ON public.job_application_parses FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "Service role full access on job_application_parses"
  ON public.job_application_parses FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- invoice_errors
ALTER TABLE public.invoice_errors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read invoice_errors"
  ON public.invoice_errors FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "Service role full access on invoice_errors"
  ON public.invoice_errors FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ingestion_state
ALTER TABLE public.ingestion_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read ingestion_state"
  ON public.ingestion_state FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "Service role full access on ingestion_state"
  ON public.ingestion_state FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- mailbox_processed_messages
ALTER TABLE public.mailbox_processed_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read mailbox_processed_messages"
  ON public.mailbox_processed_messages FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "Service role full access on mailbox_processed_messages"
  ON public.mailbox_processed_messages FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- van_leg_notes
ALTER TABLE public.van_leg_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read van_leg_notes"
  ON public.van_leg_notes FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage van_leg_notes"
  ON public.van_leg_notes FOR ALL
  TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access on van_leg_notes"
  ON public.van_leg_notes FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- crew_members
ALTER TABLE public.crew_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read crew_members"
  ON public.crew_members FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "Service role full access on crew_members"
  ON public.crew_members FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- crew_rotations
ALTER TABLE public.crew_rotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read crew_rotations"
  ON public.crew_rotations FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "Service role full access on crew_rotations"
  ON public.crew_rotations FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- airport_aliases
ALTER TABLE public.airport_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read airport_aliases"
  ON public.airport_aliases FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "Service role full access on airport_aliases"
  ON public.airport_aliases FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 2: Recreate SECURITY DEFINER views as SECURITY INVOKER
-- ═══════════════════════════════════════════════════════════════════════════════

-- These views are not referenced in application code but exist in the database.
-- Switching to SECURITY INVOKER so they respect the querying user's RLS policies.

ALTER VIEW public.latest_parsed_invoices SET (security_invoker = on);
ALTER VIEW public.job_unparsed_files SET (security_invoker = on);
ALTER VIEW public.actionable_alerts SET (security_invoker = on);
