-- MX director notes attached to individual flight legs for AOG van drivers
create table if not exists van_leg_notes (
  id uuid primary key default gen_random_uuid(),
  flight_id text not null unique,
  date date not null,
  tail_number text,
  note text not null,
  author text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_van_leg_notes_date on van_leg_notes(date);
create index if not exists idx_van_leg_notes_flight on van_leg_notes(flight_id);
