-- Ticket 2: Seed country document rules from International Handling 101 spreadsheet
-- Mexico, Bermuda, Bahamas, Canada, CARICOM countries, Antigua

-- Helper: get country IDs by iso_code
DO $$
DECLARE
  mx_id uuid;
  bm_id uuid;
  bs_id uuid;
  ca_id uuid;
  ag_id uuid;  -- Antigua
  bb_id uuid;  -- Barbados
  jm_id uuid;  -- Jamaica
  tt_id uuid;  -- Trinidad & Tobago
  dm_id uuid;  -- Dominica (may not exist yet)
  gd_id uuid;  -- Grenada (may not exist yet)
  gy_id uuid;  -- Guyana (may not exist yet)
  vc_id uuid;  -- St. Vincent (may not exist yet)
BEGIN
  SELECT id INTO mx_id FROM countries WHERE iso_code = 'MX';
  SELECT id INTO bm_id FROM countries WHERE iso_code = 'BM';
  SELECT id INTO bs_id FROM countries WHERE iso_code = 'BS';
  SELECT id INTO ca_id FROM countries WHERE iso_code = 'CA';
  SELECT id INTO ag_id FROM countries WHERE iso_code = 'AG';
  SELECT id INTO bb_id FROM countries WHERE iso_code = 'BB';
  SELECT id INTO jm_id FROM countries WHERE iso_code = 'JM';
  SELECT id INTO tt_id FROM countries WHERE iso_code = 'TT';

  -- Insert CARICOM countries that may not exist yet
  INSERT INTO countries (name, iso_code, icao_prefixes, overflight_permit_required, landing_permit_required)
  VALUES
    ('Dominica', 'DM', '{"TD"}', false, false),
    ('Grenada', 'GD', '{"TG"}', false, false),
    ('Guyana', 'GY', '{"SY"}', false, false),
    ('St. Vincent & the Grenadines', 'VC', '{"TV"}', false, false)
  ON CONFLICT (iso_code) DO NOTHING;

  SELECT id INTO dm_id FROM countries WHERE iso_code = 'DM';
  SELECT id INTO gd_id FROM countries WHERE iso_code = 'GD';
  SELECT id INTO gy_id FROM countries WHERE iso_code = 'GY';
  SELECT id INTO vc_id FROM countries WHERE iso_code = 'VC';

  -- ── Mexico ──────────────────────────────────────────────────────────
  IF mx_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (mx_id, 'crew',     'name_contains', 'license',        true, 'landing', 'Pilot licenses required for Mexico', 1),
      (mx_id, 'crew',     'name_contains', 'medical',        true, 'landing', 'Pilot medicals required for Mexico', 2),
      (mx_id, 'trip',     'name_contains', 'gendec',         true, 'landing', 'GenDecs (in + out) required for Mexico', 3),
      (mx_id, 'aircraft', 'name_contains', 'airworthiness',  true, 'landing', 'Certificate of Airworthiness', 4),
      (mx_id, 'aircraft', 'name_contains', 'registration',   true, 'landing', 'Certificate of Registration', 5),
      (mx_id, 'aircraft', 'name_contains', 'insurance',      true, 'landing', 'Mexican insurance policy required', 6),
      (mx_id, 'trip',     'name_contains', 'lopa',           true, 'landing', 'LOPA diagram', 7),
      (mx_id, 'trip',     'name_contains', 'flight plan',    true, 'landing', 'ICAO flight plan', 8),
      (mx_id, 'trip',     'name_contains', 'fuel release',   false,'landing', 'Fuel release (if applicable)', 9);
  END IF;

  -- ── Bermuda ─────────────────────────────────────────────────────────
  IF bm_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (bm_id, 'trip',     'name_contains', 'pop',            true, 'landing', 'POP for permit application', 1),
      (bm_id, 'aircraft', 'name_contains', 'registration',   true, 'landing', 'Certificate of Registration', 2),
      (bm_id, 'aircraft', 'name_contains', 'airworthiness',  true, 'landing', 'Certificate of Airworthiness', 3),
      (bm_id, 'company',  'name_contains', 'fcc',            true, 'landing', 'FCC Radio License', 4),
      (bm_id, 'company',  'name_contains', 'insurance',      true, 'landing', 'Fleet insurance certificate', 5),
      (bm_id, 'company',  'name_contains', 'ops spec',       true, 'landing', 'International Ops Specs', 6),
      (bm_id, 'crew',     'name_contains', 'medical',        true, 'landing', 'Crew medicals', 7),
      (bm_id, 'crew',     'name_contains', 'certificate',    true, 'landing', 'Crew certificates', 8),
      (bm_id, 'aircraft', 'name_contains', 'noise',          true, 'landing', 'Noise certificate', 9),
      (bm_id, 'trip',     'name_contains', 'bcaa',           false,'landing', 'BCAA application form (if available)', 10);
  END IF;

  -- ── Bahamas ─────────────────────────────────────────────────────────
  IF bs_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (bs_id, 'trip',     'name_contains', 'gendec',         true, 'landing', 'GenDecs — email directly to FBO', 1);
  END IF;

  -- ── Canada ──────────────────────────────────────────────────────────
  IF ca_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (ca_id, 'trip',     'name_contains', 'gendec',         true, 'landing', 'GenDecs — required for FBO slot request', 1);
  END IF;

  -- ── CARICOM countries: gendecs + CARICOM eAPIS confirmation ────────
  -- Antigua, Barbados, Dominica, Grenada, Guyana, Jamaica, St. Vincent, Trinidad
  IF ag_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (ag_id, 'trip', 'name_contains', 'gendec',  true, 'landing', 'GenDecs required', 1),
      (ag_id, 'trip', 'name_contains', 'eapis',   true, 'landing', 'CARICOM eAPIS confirmation', 2),
      (ag_id, 'trip', 'name_contains', 'arrival',  true, 'landing', 'Passenger arrival form for Antigua', 3);
  END IF;

  IF bb_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (bb_id, 'trip', 'name_contains', 'gendec', true, 'landing', 'GenDecs required', 1),
      (bb_id, 'trip', 'name_contains', 'eapis',  true, 'landing', 'CARICOM eAPIS confirmation', 2);
  END IF;

  IF dm_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (dm_id, 'trip', 'name_contains', 'gendec', true, 'landing', 'GenDecs required', 1),
      (dm_id, 'trip', 'name_contains', 'eapis',  true, 'landing', 'CARICOM eAPIS confirmation', 2);
  END IF;

  IF gd_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (gd_id, 'trip', 'name_contains', 'gendec', true, 'landing', 'GenDecs required', 1),
      (gd_id, 'trip', 'name_contains', 'eapis',  true, 'landing', 'CARICOM eAPIS confirmation', 2);
  END IF;

  IF gy_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (gy_id, 'trip', 'name_contains', 'gendec', true, 'landing', 'GenDecs required', 1),
      (gy_id, 'trip', 'name_contains', 'eapis',  true, 'landing', 'CARICOM eAPIS confirmation', 2);
  END IF;

  IF jm_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (jm_id, 'trip', 'name_contains', 'gendec', true, 'landing', 'GenDecs required', 1),
      (jm_id, 'trip', 'name_contains', 'eapis',  true, 'landing', 'CARICOM eAPIS confirmation', 2);
  END IF;

  IF vc_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (vc_id, 'trip', 'name_contains', 'gendec', true, 'landing', 'GenDecs required', 1),
      (vc_id, 'trip', 'name_contains', 'eapis',  true, 'landing', 'CARICOM eAPIS confirmation', 2);
  END IF;

  IF tt_id IS NOT NULL THEN
    INSERT INTO country_document_rules (country_id, doc_category, match_type, match_value, is_required, applies_to, notes, sort_order) VALUES
      (tt_id, 'trip', 'name_contains', 'gendec', true, 'landing', 'GenDecs required', 1),
      (tt_id, 'trip', 'name_contains', 'eapis',  true, 'landing', 'CARICOM eAPIS confirmation', 2);
  END IF;

END $$;
