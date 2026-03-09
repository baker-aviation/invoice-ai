-- Migration: switch trip_salespersons from trip-level to per-leg data
-- Run in Supabase SQL Editor

-- 1. Drop old data and constraints
TRUNCATE trip_salespersons;
ALTER TABLE trip_salespersons DROP CONSTRAINT IF EXISTS trip_salespersons_trip_id_key;

-- 2. Drop old columns
ALTER TABLE trip_salespersons DROP COLUMN IF EXISTS trip_start;
ALTER TABLE trip_salespersons DROP COLUMN IF EXISTS trip_end;

-- 3. Add new columns for Zulu departure/arrival times
ALTER TABLE trip_salespersons ADD COLUMN scheduled_departure timestamptz;
ALTER TABLE trip_salespersons ADD COLUMN scheduled_arrival timestamptz;

-- 4. New unique constraint: one row per leg (trip + tail + origin + dest)
ALTER TABLE trip_salespersons
  ADD CONSTRAINT trip_salespersons_leg_key
  UNIQUE (trip_id, tail_number, origin_icao, destination_icao);
