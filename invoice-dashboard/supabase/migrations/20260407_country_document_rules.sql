-- Ticket 1: Create country_document_rules table
-- Routes + UI exist but the table was never created. Document auto-selection is completely broken.

CREATE TABLE country_document_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id      uuid NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  doc_category    text NOT NULL CHECK (doc_category IN ('trip', 'crew', 'aircraft', 'company')),
  match_type      text NOT NULL CHECK (match_type IN ('exact_name', 'name_contains', 'all')),
  match_value     text,  -- null when match_type = 'all'
  is_required     boolean NOT NULL DEFAULT true,
  applies_to      text NOT NULL DEFAULT 'landing' CHECK (applies_to IN ('landing', 'overflight', 'both')),
  notes           text,
  sort_order      integer NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_country_doc_rules_country ON country_document_rules(country_id);
CREATE INDEX idx_country_doc_rules_active ON country_document_rules(country_id, is_active) WHERE is_active = true;

-- RLS
ALTER TABLE country_document_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read document rules"
  ON country_document_rules FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage document rules"
  ON country_document_rules FOR ALL
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin', 'super_admin')
    OR (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'super_admin')
  );
