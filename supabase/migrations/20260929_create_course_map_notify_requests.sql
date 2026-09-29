-- "Email me when this course is ready." A player whose course scan failed asks to be told when
-- the map exists; one row per player per course. Written by /api/course-map-notify
-- (functions/course-map-notify.mjs) for a verified signed-in user only, and read by the
-- course-mapper sweeper, which emails every pending row whose course now has a playable map
-- and stamps notified_at. A player asking again after being notified re-arms their row.
-- Service role is the only reader or writer.

create table if not exists public.course_map_notify_requests (
  id uuid primary key default gen_random_uuid(),
  course_id text not null,
  course_name text,
  user_id uuid not null,
  email text not null,
  recipient_name text,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (course_id, user_id)
);

create index if not exists course_map_notify_requests_pending_idx
on public.course_map_notify_requests (created_at)
where notified_at is null;

alter table public.course_map_notify_requests enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_map_notify_requests to service_role;

drop policy if exists "service role can manage course map notify requests" on public.course_map_notify_requests;
create policy "service role can manage course map notify requests"
on public.course_map_notify_requests
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
