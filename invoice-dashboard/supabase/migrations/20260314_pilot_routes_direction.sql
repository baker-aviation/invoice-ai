-- Add direction column to distinguish oncoming vs offgoing routes
ALTER TABLE pilot_routes
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'oncoming';

-- Update unique index to include direction
DROP INDEX IF EXISTS pilot_routes_uq;
CREATE UNIQUE INDEX pilot_routes_uq
  ON pilot_routes(crew_member_id, swap_date, destination_icao, direction, route_type, COALESCE(flight_number, ''));
