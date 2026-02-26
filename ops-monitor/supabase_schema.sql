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
  updated_at           timestamptz default now(),
  created_at           timestamptz default now()
);

create index if not exists flights_scheduled_departure_idx on flights (scheduled_departure);
create index if not exists flights_airports_idx on flights (departure_icao, arrival_icao);

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
