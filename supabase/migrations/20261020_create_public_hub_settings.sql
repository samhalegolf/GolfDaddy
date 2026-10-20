-- Studio > Marketing > Public Facing Hub: the rules that decide which courses land in the hub
-- (to get their header snapshots) and which are published to /courses/<course_id>
-- automatically, plus the courses an admin has held back by hand. One row, id 'rules'.
--
-- The rule shapes and their defaults live in functions/lib/gd-public-hub-rules.mjs; no row
-- here means the defaults. Written and read only through /api/public-hub (admin only).
-- course_maps.page_public stays the one switch the page itself reads.

create table if not exists public.public_hub_settings (
  id text primary key,
  rules jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.public_hub_settings enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.public_hub_settings to service_role;

drop policy if exists "service role can manage public hub settings" on public.public_hub_settings;
create policy "service role can manage public hub settings"
on public.public_hub_settings
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
