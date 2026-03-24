-- Add crew grading system (1-4 scale) and per-crew restrictions
-- Grade: 1=struggling, 2=new but ok, 3=average, 4=rock solid/can train
-- Pairing rule: PIC grade + SIC grade must be >= 4

ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS grade smallint NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS checkairman_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS restrictions jsonb NOT NULL DEFAULT '{}';

-- Add check constraint for valid grade values
ALTER TABLE crew_members
  ADD CONSTRAINT crew_members_grade_range CHECK (grade >= 1 AND grade <= 4);

-- Backfill checkairman_types from is_checkairman + aircraft_types
-- If a crew member is_checkairman and has aircraft_types, copy them as checkairman_types
UPDATE crew_members
SET checkairman_types = aircraft_types
WHERE is_checkairman = true AND array_length(aircraft_types, 1) > 0;

-- Index for grade-based queries (pairing lookups)
CREATE INDEX IF NOT EXISTS idx_crew_members_grade ON crew_members (grade) WHERE active = true;

-- Add a cache table for Google Maps Distance Matrix results
CREATE TABLE IF NOT EXISTS drive_time_cache (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  origin_icao text NOT NULL,
  destination_icao text NOT NULL,
  distance_meters integer,
  duration_seconds integer,
  duration_in_traffic_seconds integer,
  origin_address text,
  destination_address text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (origin_icao, destination_icao)
);

CREATE INDEX IF NOT EXISTS idx_drive_time_cache_pair ON drive_time_cache (origin_icao, destination_icao);
