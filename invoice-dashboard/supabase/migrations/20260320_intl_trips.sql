-- International trip tracking: trip-centric view with clearance statuses
-- A trip is US departure → N international stops → US return

create table if not exists intl_trips (
  id uuid primary key default gen_random_uuid(),
  tail_number text not null,
  route_icaos text[] not null default '{}',   -- ordered list: [US_dep, intl_1, ..., US_return]
  flight_ids text[] not null default '{}',     -- ordered flight IDs for each leg
  trip_date date not null,                      -- departure date of first leg
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists intl_trip_clearances (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references intl_trips(id) on delete cascade,
  clearance_type text not null check (clearance_type in ('outbound_clearance', 'landing_permit', 'inbound_clearance', 'overflight_permit')),
  airport_icao text not null,
  status text not null default 'not_started' check (status in ('not_started', 'submitted', 'approved')),
  sort_order int not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_intl_trips_tail on intl_trips(tail_number);
create index if not exists idx_intl_trips_date on intl_trips(trip_date);
create index if not exists idx_intl_trip_clearances_trip on intl_trip_clearances(trip_id);

-- Unique constraint: one trip per tail + flight combo
create unique index if not exists idx_intl_trips_unique on intl_trips(tail_number, trip_date, route_icaos);

-- RLS
alter table intl_trips enable row level security;
alter table intl_trip_clearances enable row level security;

create policy "Allow all for authenticated users" on intl_trips
  for all using (auth.role() = 'authenticated' or auth.role() = 'service_role');

create policy "Allow all for authenticated users" on intl_trip_clearances
  for all using (auth.role() = 'authenticated' or auth.role() = 'service_role');
