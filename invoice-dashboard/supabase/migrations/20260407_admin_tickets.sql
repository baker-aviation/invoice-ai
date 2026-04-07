-- Admin tickets / task tracker with priority and Claude prompts
create table if not exists admin_tickets (
  id            bigint generated always as identity primary key,
  title         text not null,
  body          text,                              -- markdown description
  priority      smallint not null default 50,      -- 1 = highest, 100 = lowest
  status        text not null default 'open'       -- open, in_progress, done, wont_fix
    check (status in ('open', 'in_progress', 'done', 'wont_fix')),
  claude_prompt text,                              -- pre-written prompt for Claude
  github_issue  int,                               -- optional GitHub issue number
  labels        text[] not null default '{}',      -- tags like 'bug', 'crew-swap', etc.
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- RLS: only admins
alter table admin_tickets enable row level security;

create policy "admin_tickets_select"
  on admin_tickets for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
    or (auth.jwt() -> 'user_metadata' ->> 'role') in ('admin', 'super_admin')
  );

create policy "admin_tickets_insert"
  on admin_tickets for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
    or (auth.jwt() -> 'user_metadata' ->> 'role') in ('admin', 'super_admin')
  );

create policy "admin_tickets_update"
  on admin_tickets for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
    or (auth.jwt() -> 'user_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
    or (auth.jwt() -> 'user_metadata' ->> 'role') in ('admin', 'super_admin')
  );

create policy "admin_tickets_delete"
  on admin_tickets for delete
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
    or (auth.jwt() -> 'user_metadata' ->> 'role') in ('admin', 'super_admin')
  );
