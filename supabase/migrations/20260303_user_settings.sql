-- User settings table: stores per-user tab access and preferences
-- Admin controls which tabs each user can see

create table if not exists user_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null,
  email text not null,
  allowed_tabs jsonb default '["ops","invoices","alerts","jobs","maintenance","vehicles","fuel-prices","fees"]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable RLS
alter table user_settings enable row level security;

-- Service role full access (API routes use service role key)
create policy "service_role_all" on user_settings
  for all using (true) with check (true);

-- Users can read their own settings
create policy "users_read_own" on user_settings
  for select using (auth.uid() = user_id);

-- Set Charlie@airninetwo.com as admin
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role": "admin"}'::jsonb
where lower(email) = 'charlie@airninetwo.com';
