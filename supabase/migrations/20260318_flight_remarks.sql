-- Ops flight remarks: day-of notes attached to individual legs
create table if not exists flight_remarks (
  id uuid primary key default gen_random_uuid(),
  flight_id text not null,              -- flights.id (ICS leg)
  remark text not null,
  created_by text,                      -- user email
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active remark per flight (latest wins in queries, but allow history)
create index idx_flight_remarks_flight_id on flight_remarks (flight_id, created_at desc);
