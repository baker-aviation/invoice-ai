-- Run this in the Supabase SQL editor to create the ops tables.

create table if not exists flights (
  id                   uuid primary key default gen_random_uuid(),
  ics_uid              text unique not null,
  tail_number          text,
  departure_icao       text,
  arrival_icao         text,
  scheduled_departure  timestamptz,
  scheduled_arrival    timestamptz,
  summary              text,
  flight_type          text,           -- Revenue | Positioning | Owner | Maintenance | Training | Ferry/Cargo | etc.
  pic                  text,           -- Pilot in Command name (from ICS DESCRIPTION)
  sic                  text,           -- Second in Command name (from ICS DESCRIPTION)
  pax_count            integer,        -- Passenger count (from ICS DESCRIPTION)
  jetinsight_url       text,           -- Link back to JetInsight trip portal
  updated_at           timestamptz default now(),
  created_at           timestamptz default now()
);

-- Migration: add new columns to existing tables
-- alter table flights add column if not exists flight_type text;
-- alter table flights add column if not exists pic text;
-- alter table flights add column if not exists sic text;
-- alter table flights add column if not exists pax_count integer;
-- alter table flights add column if not exists jetinsight_url text;

create index if not exists flights_scheduled_departure_idx on flights (scheduled_departure);
create index if not exists flights_airports_idx on flights (departure_icao, arrival_icao);

-- Crew roster for crew swap planning
create table if not exists crew_members (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  role                 text not null,           -- PIC | SIC
  home_airports        text[] not null,         -- e.g. {"IAH","HOU"} or {"DFW","DAL"}
  aircraft_types       text[] default '{}',     -- e.g. {"citation_x","challenger"} or {"dual"}
  is_checkairman       boolean default false,
  is_skillbridge       boolean default false,
  priority             integer default 0,       -- higher = more priority for rotation
  active               boolean default true,
  notes                text,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create index if not exists crew_members_role_idx on crew_members (role);
create index if not exists crew_members_active_idx on crew_members (active) where active = true;

-- Crew swap rotation tracking
create table if not exists crew_rotations (
  id                   uuid primary key default gen_random_uuid(),
  crew_member_id       uuid references crew_members(id) on delete cascade,
  tail_number          text not null,
  rotation_start       date not null,           -- Wednesday they come on
  rotation_end         date,                    -- Wednesday they go off (null = current)
  is_early_volunteer   boolean default false,   -- Available Tuesday start
  is_late_volunteer    boolean default false,    -- Willing to stay Thursday
  standby              boolean default false,
  standby_count        integer default 0,       -- Times forced onto standby (for rotation fairness)
  created_at           timestamptz default now()
);

create index if not exists crew_rotations_crew_idx on crew_rotations (crew_member_id);
create index if not exists crew_rotations_tail_idx on crew_rotations (tail_number, rotation_start);

-- Airport aliases for crew swap (commercial airport → FBO airport mappings)
create table if not exists airport_aliases (
  id                   uuid primary key default gen_random_uuid(),
  fbo_icao             text not null,           -- e.g. "KVNY"
  commercial_icao      text not null,           -- e.g. "KBUR"
  preferred            boolean default false,   -- preferred commercial airport
  notes                text
);

create index if not exists airport_aliases_fbo_idx on airport_aliases (fbo_icao);

create table if not exists ops_alerts (
  id                      uuid primary key default gen_random_uuid(),
  flight_id               uuid references flights(id) on delete set null,
  alert_type              text not null,   -- EDCT | NOTAM_RUNWAY | NOTAM_TAXIWAY | NOTAM_TFR | NOTAM_AERODROME | NOTAM_OTHER
  severity                text not null default 'warning',  -- critical | warning | info
  airport_icao            text,
  departure_icao          text,
  arrival_icao            text,
  tail_number             text,
  subject                 text,
  body                    text,
  edct_time               text,
  original_departure_time text,
  source_message_id       text unique,
  raw_data                jsonb,
  acknowledged_at         timestamptz,
  created_at              timestamptz default now()
);

create index if not exists ops_alerts_flight_id_idx on ops_alerts (flight_id);
create index if not exists ops_alerts_created_at_idx on ops_alerts (created_at desc);
create index if not exists ops_alerts_unacked_idx on ops_alerts (acknowledged_at) where acknowledged_at is null;
