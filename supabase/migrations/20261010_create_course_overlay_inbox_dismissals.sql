-- The Mapping Overlay inbox: courses players asked the app to map (course_mapper_jobs,
-- kind automap, requested_by user:... or guest:...), listed in Studio so an admin can fix a
-- failed map or upgrade a thin one by hand. A course leaves the inbox when its overlay is
-- marked ready after the request, or when an admin dismisses it here. One row per course;
-- a newer request than dismissed_at brings the course back.
-- Written and read by /api/course-map-overlay (functions/course-map-overlay.mjs) only.

create table if not exists public.course_overlay_inbox_dismissals (
  course_id text primary key,
  dismissed_at timestamptz not null default now(),
  dismissed_by text
);

alter table public.course_overlay_inbox_dismissals enable row level security;

grant select, insert, update, delete on public.course_overlay_inbox_dismissals to service_role;

drop policy if exists "service role can manage course overlay inbox dismissals" on public.course_overlay_inbox_dismissals;
create policy "service role can manage course overlay inbox dismissals"
on public.course_overlay_inbox_dismissals
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
