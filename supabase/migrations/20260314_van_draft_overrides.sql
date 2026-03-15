-- Shared van schedule draft overrides (visible to all admins before publish)
create table if not exists van_draft_overrides (
  date date primary key,
  overrides jsonb not null default '[]',      -- [[flightId, vanId], ...]
  removals jsonb not null default '[]',       -- [flightId, ...]
  unscheduled jsonb not null default '[]',    -- [[tail, vanId], ...]
  leg_notes jsonb not null default '{}',      -- {flightId: note, ...}
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
