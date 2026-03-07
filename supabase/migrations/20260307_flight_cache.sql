-- Single-row flight cache: stores latest FA snapshot so cold starts are instant
create table if not exists flight_cache (
  id int primary key default 1 check (id = 1),  -- enforce single row
  data jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Seed the single row
insert into flight_cache (id, data, updated_at)
values (1, '[]'::jsonb, now())
on conflict (id) do nothing;

-- RLS: only service role touches this
alter table flight_cache enable row level security;
