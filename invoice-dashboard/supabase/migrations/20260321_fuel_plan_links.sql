-- Shareable fuel plan links (24h expiry, no auth required)
create table if not exists fuel_plan_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  tail_number text not null,
  aircraft_type text,
  date date not null,
  plan_data jsonb not null default '{}',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_fuel_plan_links_token on fuel_plan_links(token);
create index if not exists idx_fuel_plan_links_expires on fuel_plan_links(expires_at);

-- No RLS — these are public links (auth checked via token + expiry)
alter table fuel_plan_links enable row level security;
create policy "Allow all for service role" on fuel_plan_links
  for all using (auth.role() = 'service_role');
create policy "Allow public read by token" on fuel_plan_links
  for select using (true);

-- Add optional slack_channel_id to ics_sources (per-aircraft Slack channel)
alter table ics_sources add column if not exists slack_channel_id text;
