-- International Operations tracking tables
-- Permits, handlers, customs, documents, and alerts for international flights

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. countries — country profiles with permit requirements
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS countries (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                         TEXT NOT NULL,
  iso_code                     TEXT NOT NULL UNIQUE,
  icao_prefixes                TEXT[] DEFAULT '{}',
  overflight_permit_required   BOOLEAN NOT NULL DEFAULT false,
  landing_permit_required      BOOLEAN NOT NULL DEFAULT false,
  permit_lead_time_days        INTEGER,
  permit_lead_time_working_days BOOLEAN NOT NULL DEFAULT false,
  treat_as_international       BOOLEAN NOT NULL DEFAULT false,
  notes                        TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_countries_iso ON countries (iso_code);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. country_requirements — per-country checklist templates (grows over time)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS country_requirements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id          UUID NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  requirement_type    TEXT NOT NULL CHECK (requirement_type IN ('overflight', 'landing', 'customs', 'handling')),
  name                TEXT NOT NULL,
  description         TEXT,
  required_documents  TEXT[] DEFAULT '{}',
  sort_order          INTEGER NOT NULL DEFAULT 0,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_country_req_country ON country_requirements (country_id);
CREATE INDEX idx_country_req_active ON country_requirements (country_id, is_active)
  WHERE is_active = true;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. intl_leg_permits — per-flight permit tracking
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS intl_leg_permits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_id         UUID NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  country_id        UUID NOT NULL REFERENCES countries(id) ON DELETE RESTRICT,
  permit_type       TEXT NOT NULL CHECK (permit_type IN ('overflight', 'landing')),
  status            TEXT NOT NULL DEFAULT 'not_started'
                      CHECK (status IN ('not_started', 'drafted', 'submitted', 'approved')),
  deadline          DATE,
  submitted_at      TIMESTAMPTZ,
  approved_at       TIMESTAMPTZ,
  approved_by       TEXT,
  reference_number  TEXT,
  notes             TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_intl_permits_flight ON intl_leg_permits (flight_id);
CREATE INDEX idx_intl_permits_country ON intl_leg_permits (country_id);
CREATE INDEX idx_intl_permits_pending ON intl_leg_permits (deadline)
  WHERE status NOT IN ('approved');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. intl_leg_handlers — per-leg ground handling
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS intl_leg_handlers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_id         UUID NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  handler_name      TEXT NOT NULL,
  handler_contact   TEXT,
  airport_icao      TEXT NOT NULL,
  requested         BOOLEAN NOT NULL DEFAULT false,
  approved          BOOLEAN NOT NULL DEFAULT false,
  requested_at      TIMESTAMPTZ,
  approved_at       TIMESTAMPTZ,
  notes             TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_intl_handlers_flight ON intl_leg_handlers (flight_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. intl_documents — reusable document library
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS intl_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  document_type     TEXT NOT NULL CHECK (document_type IN (
                      'airworthiness', 'medical', 'certificate', 'passport', 'insurance', 'other'
                    )),
  entity_type       TEXT NOT NULL CHECK (entity_type IN ('aircraft', 'crew', 'company')),
  entity_id         TEXT NOT NULL,
  gcs_bucket        TEXT NOT NULL,
  gcs_key           TEXT NOT NULL,
  filename          TEXT NOT NULL,
  content_type      TEXT NOT NULL DEFAULT 'application/pdf',
  expiration_date   DATE,
  is_current        BOOLEAN NOT NULL DEFAULT true,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_intl_docs_entity ON intl_documents (entity_type, entity_id);
CREATE INDEX idx_intl_docs_current ON intl_documents (entity_type, entity_id, is_current)
  WHERE is_current = true;
CREATE INDEX idx_intl_docs_expiring ON intl_documents (expiration_date)
  WHERE expiration_date IS NOT NULL AND is_current = true;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. us_customs_airports — US customs port information
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS us_customs_airports (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  icao                  TEXT NOT NULL UNIQUE,
  airport_name          TEXT NOT NULL,
  customs_type          TEXT NOT NULL CHECK (customs_type IN ('AOE', 'LRA', 'UserFee', 'None')),
  hours_open            TIME,
  hours_close           TIME,
  timezone              TEXT,
  advance_notice_hours  INTEGER,
  overtime_available    BOOLEAN NOT NULL DEFAULT false,
  restrictions          TEXT,
  notes                 TEXT,
  difficulty            TEXT CHECK (difficulty IN ('easy', 'moderate', 'hard')),
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. intl_leg_alerts — alerts for international legs
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS intl_leg_alerts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_id           UUID REFERENCES flights(id) ON DELETE CASCADE,
  alert_type          TEXT NOT NULL CHECK (alert_type IN (
                        'deadline_approaching', 'permit_resubmit', 'customs_conflict', 'tail_change'
                      )),
  severity            TEXT NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('critical', 'warning', 'info')),
  message             TEXT NOT NULL,
  related_country_id  UUID REFERENCES countries(id) ON DELETE SET NULL,
  related_permit_id   UUID REFERENCES intl_leg_permits(id) ON DELETE SET NULL,
  acknowledged        BOOLEAN NOT NULL DEFAULT false,
  acknowledged_by     TEXT,
  acknowledged_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_intl_alerts_flight ON intl_leg_alerts (flight_id);
CREATE INDEX idx_intl_alerts_unacked ON intl_leg_alerts (acknowledged, created_at DESC)
  WHERE acknowledged = false;

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE countries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_countries" ON countries FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_countries" ON countries FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service_countries" ON countries FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE country_requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_country_req" ON country_requirements FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_country_req" ON country_requirements FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service_country_req" ON country_requirements FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE intl_leg_permits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_intl_permits" ON intl_leg_permits FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_intl_permits" ON intl_leg_permits FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service_intl_permits" ON intl_leg_permits FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE intl_leg_handlers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_intl_handlers" ON intl_leg_handlers FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_intl_handlers" ON intl_leg_handlers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service_intl_handlers" ON intl_leg_handlers FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE intl_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_intl_docs" ON intl_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_intl_docs" ON intl_documents FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service_intl_docs" ON intl_documents FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE us_customs_airports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_customs" ON us_customs_airports FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_customs" ON us_customs_airports FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service_customs" ON us_customs_airports FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE intl_leg_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_intl_alerts" ON intl_leg_alerts FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_intl_alerts" ON intl_leg_alerts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service_intl_alerts" ON intl_leg_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);
