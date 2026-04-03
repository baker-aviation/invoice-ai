-- ForeFlight navlog waypoints — stores planned altitude profile per flight
-- Used to analyze climb/cruise/descent phases and compare pilot technique

create table if not exists foreflight_waypoints (
  id              bigint generated always as identity primary key,
  foreflight_id   text not null references foreflight_predictions(foreflight_id) on delete cascade,
  seq             smallint not null,          -- 0-based waypoint order
  identifier      text not null,              -- waypoint name (KBNA, -TOC-, -TOD-, KTEB)
  altitude_fl     smallint not null,          -- flight level (e.g. 410 = FL410)
  time_over       timestamptz,               -- planned time over waypoint
  latitude        double precision,
  longitude       double precision,
  airway          text,                       -- airway identifier (DCT, J20, SID name, STAR name)
  airway_type     text,                       -- SID, STAR, AIRWAY, DCT
  is_toc          boolean not null default false,  -- top of climb
  is_tod          boolean not null default false,  -- top of descent
  created_at      timestamptz default now(),

  unique (foreflight_id, seq)
);

-- Computed phase summary per flight (materialized from waypoints)
create table if not exists foreflight_flight_phases (
  id              bigint generated always as identity primary key,
  foreflight_id   text not null unique references foreflight_predictions(foreflight_id) on delete cascade,
  climb_min       numeric(6,1),              -- minutes from departure to TOC
  cruise_min      numeric(6,1),              -- minutes from TOC to TOD
  descent_min     numeric(6,1),              -- minutes from TOD to arrival
  total_min       numeric(6,1),              -- total flight time
  climb_pct       numeric(4,1),              -- climb as % of total
  cruise_pct      numeric(4,1),              -- cruise as % of total
  descent_pct     numeric(4,1),              -- descent as % of total
  initial_alt_fl  smallint,                  -- altitude at TOC
  max_alt_fl      smallint,                  -- highest altitude reached
  final_cruise_fl smallint,                  -- altitude at TOD
  step_climbs     smallint default 0,        -- number of altitude changes during cruise
  cruise_profile  text,                      -- ForeFlight cruise profile name
  created_at      timestamptz default now()
);

create index if not exists idx_ff_waypoints_flight on foreflight_waypoints(foreflight_id);
create index if not exists idx_ff_phases_flight on foreflight_flight_phases(foreflight_id);
