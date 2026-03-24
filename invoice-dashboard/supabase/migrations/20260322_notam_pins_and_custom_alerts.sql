-- Pinned NOTAMs: users can pin specific NOTAMs for closer tracking
create table if not exists notam_pins (
  id          bigint generated always as identity primary key,
  alert_id    uuid not null references ops_alerts(id) on delete cascade,
  pinned_by   uuid not null,
  note        text,
  created_at  timestamptz not null default now(),
  unique(alert_id)
);

create index if not exists idx_notam_pins_alert on notam_pins(alert_id);

alter table notam_pins enable row level security;

create policy "Allow all for authenticated" on notam_pins
  for all using (auth.role() = 'authenticated' or auth.role() = 'service_role');

-- Custom NOTAM alerts: user-generated alerts that show alongside FAA NOTAMs
create table if not exists custom_notam_alerts (
  id              uuid primary key default gen_random_uuid(),
  airport_icao    text,
  severity        text not null default 'info' check (severity in ('critical', 'warning', 'info')),
  subject         text not null,
  body            text,
  created_by      uuid not null,
  created_by_name text,
  expires_at      timestamptz,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_custom_notam_airport on custom_notam_alerts(airport_icao);
create index if not exists idx_custom_notam_active on custom_notam_alerts(archived_at) where archived_at is null;

alter table custom_notam_alerts enable row level security;

create policy "Allow all for authenticated" on custom_notam_alerts
  for all using (auth.role() = 'authenticated' or auth.role() = 'service_role');
