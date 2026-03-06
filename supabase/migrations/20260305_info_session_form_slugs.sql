-- Add slug column to info_session_forms for multiple form types
ALTER TABLE info_session_forms
  ADD COLUMN IF NOT EXISTS slug text;

-- Set slug on existing form
UPDATE info_session_forms SET slug = 'regular' WHERE slug IS NULL;

-- Make slug NOT NULL and unique among active forms
ALTER TABLE info_session_forms ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_isf_slug_active
  ON info_session_forms (slug) WHERE is_active = true;

-- Add form_type to tokens so each link opens the correct form
ALTER TABLE info_session_tokens
  ADD COLUMN IF NOT EXISTS form_type text NOT NULL DEFAULT 'regular';

-- Insert SkillBridge form
INSERT INTO info_session_forms (title, description, slug, questions) VALUES (
  'SkillBridge Info Session',
  'Please fill out the following information after your SkillBridge info session with Baker Aviation.',
  'skillbridge',
  '[
    {"id": "current_branch", "label": "Branch of service", "type": "select", "required": true, "options": ["Army", "Navy", "Air Force", "Marines", "Coast Guard", "Space Force"]},
    {"id": "current_rank", "label": "Current rank", "type": "text", "required": true},
    {"id": "ets_date", "label": "ETS / separation date", "type": "date", "required": true},
    {"id": "skillbridge_start", "label": "Earliest SkillBridge start date", "type": "date", "required": true},
    {"id": "duty_station", "label": "Current duty station / location", "type": "text", "required": true},
    {"id": "willing_to_relocate", "label": "Are you willing to relocate?", "type": "select", "required": true, "options": ["Yes", "No", "Maybe"]},
    {"id": "flight_experience", "label": "Any civilian or military flight experience?", "type": "textarea", "required": false},
    {"id": "certifications", "label": "FAA certificates or ratings held", "type": "text", "required": false},
    {"id": "questions_for_us", "label": "Any questions for us?", "type": "textarea", "required": false},
    {"id": "how_did_you_hear", "label": "How did you hear about Baker Aviation?", "type": "text", "required": false}
  ]'::jsonb
);
