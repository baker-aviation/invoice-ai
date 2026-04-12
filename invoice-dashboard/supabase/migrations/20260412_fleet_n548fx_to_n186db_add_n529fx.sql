-- N548FX replaced by N186DB, add new tail N529FX
-- Resolves: JetInsight unmapped tails alert for N186DB and N529FX

-- 1. Rename N548FX → N186DB in ics_sources (reuse existing row)
UPDATE ics_sources SET
  label    = 'N186DB',
  url      = 'https://portal.jetinsight.com/schedule/00256885-a3f2-4df8-977d-961dbb677778/943f5d40-70b5-4592-9446-93afd505fbc0.ics',
  callsign = 'KOW186',
  updated_at = now()
WHERE label = 'N548FX';

-- 2. Insert N529FX as new ics_source
INSERT INTO ics_sources (label, url, callsign, aircraft_type, enabled)
VALUES (
  'N529FX',
  'https://portal.jetinsight.com/schedule/00256885-a3f2-4df8-977d-961dbb677778/0638b327-25ec-4733-a3fe-383f2315377b.ics',
  'KOW529',
  'CL350',
  true
);

-- 3. Rename N548FX → N186DB in aircraft_tracker (if row exists)
UPDATE aircraft_tracker SET
  tail_number = 'N186DB',
  slack_channel_id = 'C0ALFEE5M0F'  -- keep the same channel
WHERE tail_number = 'N548FX';

-- 4. Insert N529FX into aircraft_tracker (no Slack channel yet)
INSERT INTO aircraft_tracker (tail_number)
VALUES ('N529FX')
ON CONFLICT DO NOTHING;
