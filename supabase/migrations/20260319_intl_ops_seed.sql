-- Seed countries and known requirements for Baker Aviation international ops

-- ═══════════════════════════════════════════════════════════════════════════════
-- Countries — Caribbean, Central America, and common Baker destinations
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO countries (name, iso_code, icao_prefixes, overflight_permit_required, landing_permit_required, permit_lead_time_days, permit_lead_time_working_days, treat_as_international, notes)
VALUES
  -- Overflight permit required
  ('Cuba',       'CU', '{"MU"}',   true,  true,  NULL, false, false, 'Overflight and landing permits required. Restricted airspace — coordinate early.'),
  ('Nicaragua',  'NI', '{"MN"}',   true,  true,  NULL, false, false, 'Overflight permit required for transit through Managua FIR.'),
  ('Panama',     'PA', '{"MP"}',   true,  true,  NULL, false, false, 'Overflight permit required. Landing at MPTO requires separate landing permit.'),
  ('Costa Rica', 'CR', '{"MR"}',   true,  true,  NULL, false, false, 'Overflight permit required.'),

  -- 4 working days advance submission
  ('Bermuda',    'BM', '{"TX"}',   false, true,  4, true,  false, 'Permits must be submitted at least 4 working days in advance.'),
  ('Barbados',   'BB', '{"TB"}',   false, true,  4, true,  false, 'Permits must be submitted at least 4 working days in advance.'),
  ('Jamaica',    'JM', '{"MK"}',   false, true,  4, true,  false, 'Permits must be submitted at least 4 working days in advance.'),

  -- Treat as international (US territories needing customs workflow)
  ('U.S. Virgin Islands', 'VI', '{"TI"}', false, false, NULL, false, true, 'US territory but treated as international for customs purposes. Includes St. Thomas (TIST) and St. Croix (TISX).'),

  -- Common Baker international destinations
  ('Bahamas',           'BS', '{"MY"}',   false, true,  NULL, false, false, 'Common Baker destination. Nassau (MYNN), Eleuthera (MYEH).'),
  ('Mexico',            'MX', '{"MM"}',   false, true,  NULL, false, false, 'Landing permit required. Common destination: Monterrey (MMMY).'),
  ('Cayman Islands',    'KY', '{"MW"}',   false, true,  NULL, false, false, 'Grand Cayman (MWCR).'),
  ('Dominican Republic','DO', '{"MD"}',   false, true,  NULL, false, false, 'La Romana (MDLR).'),
  ('Antigua & Barbuda', 'AG', '{"TA"}',   false, true,  NULL, false, false, 'V.C. Bird International (TAPA).'),
  ('Aruba',             'AW', '{"TN"}',   false, true,  NULL, false, false, 'Reina Beatrix (TNCA).'),
  ('Puerto Rico',       'PR', '{"TJ"}',   false, false, NULL, false, true, 'US territory — treated as international for customs purposes. SJU.'),
  ('Canada',            'CA', '{"C"}',    false, false, NULL, false, false, 'No overflight permit needed. eAPIS required.'),
  ('Colombia',          'CO', '{"SK"}',   false, true,  NULL, false, false, 'Landing permit required.'),
  ('Honduras',          'HN', '{"MH"}',   false, true,  NULL, false, false, 'Landing permit required.'),
  ('Guatemala',         'GT', '{"MG"}',   false, true,  NULL, false, false, 'Landing permit may be required.'),
  ('Turks & Caicos',    'TC', '{"MB"}',   false, true,  NULL, false, false, 'Common Caribbean destination.')

ON CONFLICT (iso_code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Country Requirements — known checklist items
-- ═══════════════════════════════════════════════════════════════════════════════

-- Cuba requirements
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'overflight', 'Cuba Overflight Permit', 'Submit overflight permit application to Cuban aviation authority (IACC)', '{"insurance_certificate"}', 1
FROM countries c WHERE c.iso_code = 'CU';

INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'landing', 'Cuba Landing Permit', 'Landing authorization from IACC', '{"airworthiness_certificate","insurance_certificate","crew_passports"}', 2
FROM countries c WHERE c.iso_code = 'CU';

-- Nicaragua requirements
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'overflight', 'Nicaragua Overflight Permit', 'Submit overflight permit to INAC', '{"insurance_certificate"}', 1
FROM countries c WHERE c.iso_code = 'NI';

-- Panama requirements
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'overflight', 'Panama Overflight Permit', 'Overflight authorization from AAC Panama', '{"insurance_certificate"}', 1
FROM countries c WHERE c.iso_code = 'PA';

INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'landing', 'Panama Landing Permit', 'Landing authorization from AAC Panama', '{"airworthiness_certificate","insurance_certificate","crew_passports","crew_medical_certificates"}', 2
FROM countries c WHERE c.iso_code = 'PA';

-- Costa Rica requirements
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'overflight', 'Costa Rica Overflight Permit', 'Submit overflight permit to DGAC Costa Rica', '{"insurance_certificate"}', 1
FROM countries c WHERE c.iso_code = 'CR';

INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'landing', 'Costa Rica Landing Permit', 'Landing authorization from DGAC Costa Rica', '{"airworthiness_certificate","insurance_certificate","crew_passports"}', 2
FROM countries c WHERE c.iso_code = 'CR';

-- Bermuda requirements (4 working days)
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'landing', 'Bermuda Landing Permit', 'Must be submitted at least 4 working days in advance to Bermuda Dept of Airport Operations', '{"airworthiness_certificate","insurance_certificate","crew_passports"}', 1
FROM countries c WHERE c.iso_code = 'BM';

-- Barbados requirements (4 working days)
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'landing', 'Barbados Landing Permit', 'Must be submitted at least 4 working days in advance to Barbados Civil Aviation Dept', '{"airworthiness_certificate","insurance_certificate","crew_passports"}', 1
FROM countries c WHERE c.iso_code = 'BB';

-- Jamaica requirements (4 working days)
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'landing', 'Jamaica Landing Permit', 'Must be submitted at least 4 working days in advance to JCAA', '{"airworthiness_certificate","insurance_certificate","crew_passports"}', 1
FROM countries c WHERE c.iso_code = 'JM';

-- Bahamas requirements
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'landing', 'Bahamas Landing Permit', 'Submit to Bahamas Civil Aviation Authority', '{"airworthiness_certificate","insurance_certificate","crew_passports"}', 1
FROM countries c WHERE c.iso_code = 'BS';

INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'customs', 'Bahamas Customs Declaration', 'Complete customs/immigration forms prior to arrival', '{"crew_passports"}', 2
FROM countries c WHERE c.iso_code = 'BS';

-- USVI requirements
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'customs', 'USVI Customs Clearance', 'eAPIS submission required. CBP notification for arrival.', '{"crew_passports"}', 1
FROM countries c WHERE c.iso_code = 'VI';

-- General eAPIS requirement for all international destinations
INSERT INTO country_requirements (country_id, requirement_type, name, description, required_documents, sort_order)
SELECT c.id, 'customs', 'eAPIS Submission', 'Submit eAPIS manifest to CBP at least 60 minutes prior to departure', '{"crew_passports"}', 10
FROM countries c WHERE c.iso_code NOT IN ('US')
ON CONFLICT DO NOTHING;
