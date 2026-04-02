-- Enrich flights table with data from JetInsight JSON schedule endpoint
-- These fields are populated by the 10-min schedule sync cron, not the ICS sync

ALTER TABLE flights ADD COLUMN IF NOT EXISTS flight_number text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS jetinsight_trip_id text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS origin_fbo text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS destination_fbo text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS international_leg boolean;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS trip_stage text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS release_complete boolean;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS crew_complete boolean;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS pax_complete boolean;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS faa_part text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS jetinsight_event_uuid text;

CREATE INDEX IF NOT EXISTS idx_flights_ji_trip_id
  ON flights (jetinsight_trip_id) WHERE jetinsight_trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flights_ji_event_uuid
  ON flights (jetinsight_event_uuid) WHERE jetinsight_event_uuid IS NOT NULL;

-- Allow 'trip' entity type in jetinsight_documents
ALTER TABLE jetinsight_documents DROP CONSTRAINT IF EXISTS jetinsight_documents_entity_type_check;
ALTER TABLE jetinsight_documents ADD CONSTRAINT jetinsight_documents_entity_type_check
  CHECK (entity_type IN ('crew', 'aircraft', 'trip'));

-- Trip passenger names (just names, no sensitive PII)
CREATE TABLE IF NOT EXISTS jetinsight_trip_passengers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jetinsight_trip_id text NOT NULL,
  passenger_name text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(jetinsight_trip_id, passenger_name)
);

ALTER TABLE jetinsight_trip_passengers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON jetinsight_trip_passengers
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Authenticated can read" ON jetinsight_trip_passengers
  FOR SELECT TO authenticated USING (true);
