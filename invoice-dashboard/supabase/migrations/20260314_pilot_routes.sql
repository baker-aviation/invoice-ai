-- Pre-computed route pool for crew swap optimizer
-- Instead of searching flights at optimizer runtime (causing timeouts),
-- routes are computed in advance and stored here for instant lookup.

CREATE TABLE pilot_routes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  crew_member_id  uuid NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
  swap_date       date NOT NULL,
  destination_icao text NOT NULL,          -- the FBO/swap airport

  -- Route details
  route_type      text NOT NULL,           -- 'commercial', 'uber', 'rental_car', 'drive'
  origin_iata     text NOT NULL,           -- pilot's home airport (IATA)
  via_commercial  text,                    -- commercial airport near FBO (IATA), null for direct drive
  flight_number   text,                    -- e.g. 'DL3697', null for drive
  flight_data     jsonb,                   -- full HasData response for this flight option

  -- Timing
  depart_at       timestamptz,
  arrive_at       timestamptz,
  fbo_arrive_at   timestamptz,             -- when they'd arrive at the actual FBO
  duty_on_at      timestamptz,
  duration_minutes integer,

  -- Cost & scoring
  cost_estimate   numeric NOT NULL DEFAULT 0,
  score           integer NOT NULL DEFAULT 0,  -- 0-100 from scoreCandidate()
  is_direct       boolean DEFAULT false,
  connection_count integer DEFAULT 0,
  has_backup      boolean DEFAULT false,
  backup_flight   text,                    -- backup flight number if available

  -- Metadata
  searched_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pilot_routes_uq ON pilot_routes(crew_member_id, swap_date, destination_icao, route_type, COALESCE(flight_number, ''));
CREATE INDEX pilot_routes_lookup ON pilot_routes(swap_date, destination_icao);
CREATE INDEX pilot_routes_crew ON pilot_routes(crew_member_id, swap_date);

-- Airport commercial tier for crew difficulty scoring
ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS home_airport_tier text DEFAULT 'unknown';

-- Add check constraint separately so it doesn't fail if column already exists
DO $$
BEGIN
  ALTER TABLE crew_members
    ADD CONSTRAINT crew_members_home_airport_tier_check
    CHECK (home_airport_tier IN ('major_hub', 'large_hub', 'medium_hub', 'small_hub', 'regional', 'fbo_only', 'unknown'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
