-- "Email me when my Garmin map is ready." A player whose Garmin asked for a course while its
-- Garmin package was still being built (course_garmin_maps, usually about a minute after a
-- course is first mapped) is offered an email. Written by
-- POST /api/course-map-notify {kind: "garmin"} (functions/course-map-notify.mjs) only when
-- the server confirms a build is under way, and read by the course-mapper sweeper, which
-- emails every pending row whose course now has a usable Garmin package and stamps
-- notified_at. Asking again after being told re-arms the row.
--
-- Its own table rather than a kind column on course_map_notify_requests: that table's
-- (course_id, email) unique key is what the course-ready upsert conflicts on, so changing it
-- would break those requests for as long as old code and the new key overlapped.
-- Service role is the only reader or writer.

create table if not exists public.garmin_map_notify_requests (
  id uuid primary key default gen_random_uuid(),
  course_id text not null,
  course_name text,
  user_id uuid,
  email text not null,
  recipient_name text,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (course_id, email)
);

create index if not exists garmin_map_notify_requests_pending_idx
on public.garmin_map_notify_requests (created_at)
where notified_at is null;

alter table public.garmin_map_notify_requests enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.garmin_map_notify_requests to service_role;

drop policy if exists "service role can manage garmin map notify requests" on public.garmin_map_notify_requests;
create policy "service role can manage garmin map notify requests"
on public.garmin_map_notify_requests
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
