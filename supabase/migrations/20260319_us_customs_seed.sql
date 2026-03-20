-- Seed US customs airport data for Baker Aviation common international arrival airports
-- Source: AirNav.com airport pages, scraped 2026-03-19

INSERT INTO us_customs_airports (icao, airport_name, customs_type, hours_open, hours_close, timezone, advance_notice_hours, overtime_available, restrictions, notes, difficulty)
VALUES
  ('KFLL', 'Fort Lauderdale-Hollywood Intl', 'AOE', '00:00', '23:59', 'America/New_York', NULL, true, NULL, '24/7 customs at Sheltair. National Jets 24/7 with 30-min quick turn.', 'easy'),
  ('KPBI', 'Palm Beach Intl', 'AOE', '00:00', '23:59', 'America/New_York', NULL, true, NULL, '24-hour AOE.', 'easy'),
  ('KJFK', 'John F Kennedy Intl', 'AOE', '00:00', '23:59', 'America/New_York', NULL, true, NULL, 'Major AOE. Modern Aviation FBO handles GA customs.', 'easy'),
  ('KEWR', 'Newark Liberty Intl', 'AOE', '00:00', '23:59', 'America/New_York', NULL, true, NULL, 'Major international AOE.', 'easy'),
  ('KIAD', 'Washington Dulles Intl', 'AOE', '00:00', '23:59', 'America/New_York', NULL, true, NULL, 'Major international AOE.', 'easy'),
  ('KIAH', 'George Bush Intercontinental', 'AOE', '00:00', '23:59', 'America/Chicago', NULL, true, NULL, 'Major international AOE. Atlantic Aviation FBO.', 'easy'),
  ('KTPA', 'Tampa Intl', 'AOE', '00:00', '23:59', 'America/New_York', NULL, true, NULL, 'Sheltair FBO offers customs, IS-BAH registered.', 'easy'),
  ('KMCO', 'Orlando Intl', 'AOE', '00:00', '23:59', 'America/New_York', NULL, true, NULL, 'Major international AOE.', 'easy'),
  ('KBOS', 'Boston Logan Intl', 'AOE', '00:00', '23:59', 'America/New_York', NULL, true, NULL, 'Major international AOE.', 'easy'),
  ('KMIA', 'Miami Intl', 'AOE', '00:00', '23:59', 'America/New_York', 3, true, 'GA Center ramp requires 3-hour PPR for all arrivals.', 'Major AOE. GA ramp PPR required.', 'moderate'),
  ('KAPF', 'Naples Municipal', 'AOE', '10:30', '19:00', 'America/New_York', NULL, false, 'PPR required. 7 days/week but limited afternoon/evening window.', 'PPR: 239-430-9321.', 'moderate'),
  ('KOPF', 'Opa-Locka Executive', 'LRA', NULL, NULL, 'America/New_York', NULL, false, NULL, 'Multiple FBOs offer customs (Atlantic Aviation, Embassair, Fontainebleau Aviation).', 'moderate'),
  ('KFXE', 'Fort Lauderdale Executive', 'LRA', '08:00', '23:59', 'America/New_York', NULL, false, 'Customs ramp closed 0000-0800. Customs ramp at TWY G7.', 'Good hours (0800-2359) but no overnight arrivals.', 'moderate'),
  ('KTEB', 'Teterboro', 'LRA', NULL, NULL, 'America/New_York', NULL, false, NULL, 'Customs landing rights. Contact FBO for customs protocols.', 'moderate'),
  ('KHPN', 'Westchester County', 'LRA', NULL, NULL, 'America/New_York', NULL, false, NULL, 'Million Air and Atlantic Aviation both offer customs service.', 'moderate'),
  ('KHOU', 'William P Hobby', 'LRA', NULL, NULL, 'America/Chicago', NULL, false, NULL, 'Customs landing rights. Contact airport for procedures.', 'moderate'),
  ('KISP', 'Long Island MacArthur', 'LRA', NULL, NULL, 'America/New_York', NULL, false, NULL, 'Modern Aviation and NY Jet both handle customs.', 'moderate'),
  ('KRSW', 'Southwest Florida Intl', 'UserFee', NULL, NULL, 'America/New_York', NULL, false, NULL, 'User Fee airport. Contact 239-590-4810.', 'moderate'),
  ('KSWF', 'Stewart Intl', 'UserFee', NULL, NULL, 'America/New_York', NULL, false, 'User fee charged to all international flights.', NULL, 'moderate'),
  ('KDAL', 'Dallas Love Field', 'UserFee', NULL, NULL, 'America/Chicago', NULL, false, NULL, 'User Fee airport. Contact 214-670-5683.', 'moderate'),
  ('KADS', 'Addison', 'UserFee', '10:00', '21:00', 'America/Chicago', NULL, false, 'Mon-Fri only.', 'CBP: 214-208-3636. Million Air and Galaxy FBOs.', 'moderate'),
  ('KORL', 'Orlando Executive', 'UserFee', NULL, NULL, 'America/New_York', NULL, false, 'CBP box on east ramp restricted. PPR required.', 'CBP: 407-825-5102.', 'moderate'),
  ('KBED', 'Hanscom Field', 'UserFee', NULL, NULL, 'America/New_York', NULL, false, NULL, 'User Fee airport. Passenger manifest required for inbound.', 'moderate'),
  ('KDCA', 'Reagan National', 'LRA', NULL, NULL, 'America/New_York', NULL, false, 'Heavy security/TFR restrictions. Not practical for international GA.', 'Avoid for international GA arrivals.', 'hard'),
  ('KBCT', 'Boca Raton', 'UserFee', '10:30', '18:30', 'America/New_York', NULL, true, 'Thu-Mon only. After-hours requires on-request approval + additional fee.', 'Very limited hours. After-hours: 561-665-5842.', 'hard'),
  ('KSRQ', 'Sarasota/Bradenton', 'UserFee', '08:30', '16:30', 'America/New_York', NULL, false, 'No intl diversions accepted. Mon-Fri only.', 'Very restrictive. CBP: 813-634-1369.', 'hard'),
  ('KJAX', 'Jacksonville Intl', 'LRA', NULL, NULL, 'America/New_York', 6, false, '6-hour PPR required for intl GA arrivals.', 'Sheltair FBO, Bahamas Gateway. PPR: 904-741-2020.', 'hard'),
  ('KFRG', 'Republic (Farmingdale)', 'LRA', NULL, NULL, 'America/New_York', NULL, false, 'Must not enter terminal ramp until FBO personnel present. Customs parking on main terminal ramp.', 'Must coordinate with FBO before entering ramp.', 'hard'),
  ('KPNE', 'Northeast Philadelphia', 'LRA', NULL, NULL, 'America/New_York', 24, false, '24-hour advance PPR required.', 'CBP: 215-594-4272. Must arrange well in advance.', 'hard'),
  ('KFMY', 'Page Field', 'None', NULL, NULL, 'America/New_York', NULL, false, 'No customs service. Must clear at KRSW or KAPF first.', 'No customs available.', NULL)
ON CONFLICT (icao) DO NOTHING;
