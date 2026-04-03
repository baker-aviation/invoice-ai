-- Persistent storage for FlightAware ADS-B track data
-- Used for actual altitude profile analysis vs ForeFlight planned profiles

create table if not exists flightaware_tracks (
  id              bigint generated always as identity primary key,
  fa_flight_id    text not null unique,
  tail_number     text not null,
  origin_icao     text,
  destination_icao text,
  flight_date     date not null,
  positions       jsonb not null,           -- array of {timestamp, altitude, groundspeed, latitude, longitude, heading}
  position_count  integer not null default 0,
  -- Computed from positions for quick queries
  max_altitude    smallint,                 -- highest altitude (FL) recorded
  climb_duration_sec integer,               -- seconds from first movement to max altitude
  total_duration_sec integer,               -- total flight time in seconds
  captured_at     timestamptz default now()
);

create index if not exists idx_fa_tracks_tail_date on flightaware_tracks(tail_number, flight_date);
create index if not exists idx_fa_tracks_date on flightaware_tracks(flight_date);
