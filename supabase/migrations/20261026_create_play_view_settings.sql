-- How GPS Play draws a hole, as set in Clarity Studio. One row per setting; the first is
-- 'hybrid': the illustrated map blended over the photo, saved from Studio > Courses > 3D
-- Course Viewer and shown by Play's Auto map style on holes that meet the watch maps' criteria.
--
-- The settings' shape and defaults live in scripts/gd-hybrid-look.js (normalize); no row means
-- the defaults. Written and read only through /api/play-view: anyone may read, only an admin
-- may save. Service role only here.

create table if not exists public.play_view_settings (
  id text primary key,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.play_view_settings enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.play_view_settings to service_role;

drop policy if exists "service role can manage play view settings" on public.play_view_settings;
create policy "service role can manage play view settings"
on public.play_view_settings
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
