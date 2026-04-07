-- Combined migration for Tickets 3-8

-- ── Ticket 3: CBP contact info on us_customs_airports ─────────────────────
ALTER TABLE us_customs_airports ADD COLUMN IF NOT EXISTS cbp_email text;
ALTER TABLE us_customs_airports ADD COLUMN IF NOT EXISTS cbp_phone text;

-- Seed known CBP contact info from the International Handling 101 spreadsheet
UPDATE us_customs_airports SET cbp_email = 'MTCBPAirports@cbp.dhs.gov' WHERE icao IN ('KGAI', 'KMSO', 'KBIL');
UPDATE us_customs_airports SET cbp_email = 'SLCPrivateAir@cbp.dhs.gov' WHERE icao = 'KSLC';
UPDATE us_customs_airports SET cbp_email = 'SFOcargodesk@cbp.dhs.gov' WHERE icao = 'KSFO';
UPDATE us_customs_airports SET cbp_email = 'HOUlandingrights@cbp.dhs.gov' WHERE icao = 'KHOU';
UPDATE us_customs_airports SET cbp_email = 'scottsdalecbp@cbp.dhs.gov' WHERE icao = 'KSDL';
UPDATE us_customs_airports SET cbp_email = 'desmoines3513@cbp.dhs.gov' WHERE icao = 'KDSM';
UPDATE us_customs_airports SET cbp_email = 'charlestonairport@cbp.dhs.gov' WHERE icao = 'KCHS';
UPDATE us_customs_airports SET cbp_email = 'PortsmouthNHPOE@cbp.dhs.gov' WHERE icao = 'KPSM';
UPDATE us_customs_airports SET cbp_email = 'PATRICK.E.LANE@CBP.DHS.GOV' WHERE icao = 'KPSP';
UPDATE us_customs_airports SET cbp_email = 'Michael.J.Oniell@cbp.dhs.gov' WHERE icao = 'KCOS';

-- SJU / SAT have phone numbers
UPDATE us_customs_airports SET cbp_phone = '787-253-4570' WHERE icao = 'TJSJ';
UPDATE us_customs_airports SET cbp_phone = '210-335-2211' WHERE icao = 'KSAT';

-- ── Ticket 4: Section column on admin_tickets ─────────────────────────────
ALTER TABLE admin_tickets ADD COLUMN IF NOT EXISTS section text NOT NULL DEFAULT 'general'
  CHECK (section IN ('general', 'crew-swap', 'international', 'current-ops', 'duty', 'notams', 'hiring', 'invoices'));

-- Update existing seed tickets (all from crew swap video review)
UPDATE admin_tickets SET section = 'crew-swap' WHERE labels @> ARRAY['crew-swap'];

-- ── Ticket 5: Default handler fields on countries ─────────────────────────
ALTER TABLE countries ADD COLUMN IF NOT EXISTS default_handler_name text;
ALTER TABLE countries ADD COLUMN IF NOT EXISTS default_handler_contact text;
ALTER TABLE countries ADD COLUMN IF NOT EXISTS default_handler_email text;
ALTER TABLE countries ADD COLUMN IF NOT EXISTS default_handler_notes text;

-- Seed handler data
UPDATE countries SET
  default_handler_name = 'Pegasus Universal Aviation',
  default_handler_email = 'Operations@fly2mex.com',
  default_handler_contact = '469-986-0250 x1',
  default_handler_notes = 'Standard handler for all Mexico operations. Contact for permits, fuel, handling.'
WHERE iso_code = 'MX';

UPDATE countries SET
  default_handler_name = 'Vortex CMS',
  default_handler_notes = 'Standard handler for Bermuda. Handle permit applications and ground handling.'
WHERE iso_code = 'BM';

UPDATE countries SET
  default_handler_notes = 'Email gendecs directly to the FBO. No dedicated handler needed.'
WHERE iso_code = 'BS';

-- ── Ticket 6: Crew restriction checks ─────────────────────────────────────
ALTER TABLE countries ADD COLUMN IF NOT EXISTS crew_restrictions jsonb DEFAULT '[]';

-- Bermuda: no pilots over 65
UPDATE countries SET crew_restrictions = '[{"type": "max_age", "value": 65, "description": "No pilots over 65 years old allowed"}]'
WHERE iso_code = 'BM';

-- ── Ticket 7: eAPIS fields on countries ───────────────────────────────────
ALTER TABLE countries ADD COLUMN IF NOT EXISTS eapis_required boolean NOT NULL DEFAULT false;
ALTER TABLE countries ADD COLUMN IF NOT EXISTS eapis_provider text;

-- Flag CARICOM countries
UPDATE countries SET eapis_required = true, eapis_provider = 'caricom'
WHERE iso_code IN ('AG', 'BB', 'DM', 'GD', 'GY', 'JM', 'VC', 'TT');

-- US eAPIS is always required but handled separately
UPDATE countries SET eapis_required = true, eapis_provider = 'us'
WHERE iso_code IN ('US', 'VI', 'PR');

-- ── Add canpass + eapis_filing clearance types ────────────────────────────
ALTER TABLE intl_trip_clearances DROP CONSTRAINT IF EXISTS intl_trip_clearances_clearance_type_check;
ALTER TABLE intl_trip_clearances ADD CONSTRAINT intl_trip_clearances_clearance_type_check
  CHECK (clearance_type IN ('outbound_clearance', 'landing_permit', 'inbound_clearance', 'overflight_permit', 'canpass', 'eapis_filing'));

-- ── Update intl_leg_alerts check constraint for new alert types ───────────
ALTER TABLE intl_leg_alerts DROP CONSTRAINT IF EXISTS intl_leg_alerts_alert_type_check;
ALTER TABLE intl_leg_alerts ADD CONSTRAINT intl_leg_alerts_alert_type_check
  CHECK (alert_type IN ('deadline_approaching', 'permit_resubmit', 'customs_conflict', 'tail_change', 'schedule_change', 'delay', 'diversion', 'scraper_stale', 'crew_restriction', 'eapis_missing', 'canpass_due', 'clearance_timing'));

-- ── Ticket 11: Outbound clearance timing fields on us_customs_airports ────
ALTER TABLE us_customs_airports ADD COLUMN IF NOT EXISTS clearance_advance_min_hours integer;
ALTER TABLE us_customs_airports ADD COLUMN IF NOT EXISTS clearance_advance_max_hours integer;

-- OPF won't clear more than 24hr ahead
UPDATE us_customs_airports SET clearance_advance_max_hours = 24
WHERE icao = 'KOPF';

-- LAS and SAT need >24hr notice
UPDATE us_customs_airports SET clearance_advance_min_hours = 24
WHERE icao IN ('KLAS', 'KSAT');
