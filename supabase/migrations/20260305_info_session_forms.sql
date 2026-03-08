-- =============================================================================
-- Info Session Forms: admin-editable question config + per-candidate tokens
-- =============================================================================

-- 1. Form question configuration (single active row, questions stored as JSON)
CREATE TABLE IF NOT EXISTS info_session_forms (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text NOT NULL DEFAULT 'Info Session Form',
  description text,
  questions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE info_session_forms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access"
  ON info_session_forms FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Per-candidate form tokens (maps URL token to a candidate parse row)
CREATE TABLE IF NOT EXISTS info_session_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token       text NOT NULL UNIQUE,
  parse_id    bigint NOT NULL REFERENCES job_application_parse(id),
  used_at     timestamptz,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ist_token ON info_session_tokens (token);
CREATE INDEX idx_ist_parse_id ON info_session_tokens (parse_id);

ALTER TABLE info_session_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access"
  ON info_session_tokens FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 3. Add JSONB column to job_application_parse for storing form answers
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS info_session_data jsonb;

-- 4. Seed a default form with typical info session questions
INSERT INTO info_session_forms (title, description, questions) VALUES (
  'Pilot Info Session',
  'Please fill out the following information after your info session with Baker Aviation.',
  '[
    {"id": "current_employer", "label": "Current employer", "type": "text", "required": true},
    {"id": "available_start_date", "label": "Earliest available start date", "type": "date", "required": true},
    {"id": "willing_to_relocate", "label": "Are you willing to relocate?", "type": "select", "required": true, "options": ["Yes", "No", "Maybe"]},
    {"id": "salary_expectations", "label": "Salary expectations", "type": "text", "required": false},
    {"id": "additional_type_ratings", "label": "Any additional type ratings not on your resume?", "type": "text", "required": false},
    {"id": "questions_for_us", "label": "Any questions for us?", "type": "textarea", "required": false},
    {"id": "how_did_you_hear", "label": "How did you hear about Baker Aviation?", "type": "text", "required": false}
  ]'::jsonb
);
