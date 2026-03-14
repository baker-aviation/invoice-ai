-- Add atomic refresh lock to flight_cache so only one Vercel instance
-- refreshes FA data at a time (prevents duplicate API calls across instances)
ALTER TABLE flight_cache
  ADD COLUMN IF NOT EXISTS refreshing_since timestamptz;
