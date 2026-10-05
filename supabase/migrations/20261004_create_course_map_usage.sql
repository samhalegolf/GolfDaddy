-- Course map usage counters.
--
-- A rough picture of which mapped courses are actually being used, and from
-- where: phone app (ios / android), browser (web) or the wrist (watch).
--
-- Deliberately anonymous and aggregate-only. Nothing here can identify a
-- player: no account id, guest id, IP or user agent is stored - just a daily
-- tally per course, per event, per origin, per country (the two-letter code
-- Netlify derives from the request; the IP itself is never seen or kept).
--
-- event:
--   download - a device pulled the course's map from the server (first open on
--              that device, or a watch receiving its hole images)
--   play     - a round was opened on the course (counted at most once per
--              course per device per day, deduped on the device)

create table if not exists public.course_map_usage_daily (
  day date not null default current_date,
  course_id text not null,
  event text not null check (event in ('download', 'play')),
  origin text not null check (origin in ('web', 'ios', 'android', 'watch')),
  country text not null default '' check (country ~ '^([A-Z]{2})?$'),
  count integer not null default 1,
  primary key (day, course_id, event, origin, country)
);

create index if not exists course_map_usage_daily_course_idx
on public.course_map_usage_daily (course_id, day desc);

alter table public.course_map_usage_daily enable row level security;

grant select, insert, update, delete on public.course_map_usage_daily to service_role;

drop policy if exists "service role can manage course map usage" on public.course_map_usage_daily;
create policy "service role can manage course map usage"
on public.course_map_usage_daily
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- One atomic +1. Only counts courses that actually exist in course_maps, so a
-- made-up course id posted at the endpoint never becomes a row.
create or replace function public.record_course_map_usage(
  p_course_id text,
  p_event text,
  p_origin text,
  p_country text default ''
) returns void
language sql
set search_path = public
as $$
  insert into public.course_map_usage_daily (day, course_id, event, origin, country, count)
  select current_date, p_course_id, p_event, p_origin, coalesce(p_country, ''), 1
  where exists (select 1 from public.course_maps where course_id = p_course_id)
  on conflict (day, course_id, event, origin, country)
  do update set count = public.course_map_usage_daily.count + 1;
$$;

revoke all on function public.record_course_map_usage(text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_course_map_usage(text, text, text, text) to service_role;

-- The at-a-glance read: one row per course per origin, all time and last 30
-- days. Query it from the Supabase SQL editor, e.g.
--   select * from course_map_usage_summary order by plays_30d desc;
create or replace view public.course_map_usage_summary
with (security_invoker = true) as
select
  u.course_id,
  coalesce(m.course_name, u.course_id) as course_name,
  u.origin,
  sum(u.count) filter (where u.event = 'download') as downloads,
  sum(u.count) filter (where u.event = 'play') as plays,
  sum(u.count) filter (where u.event = 'download' and u.day > current_date - 30) as downloads_30d,
  sum(u.count) filter (where u.event = 'play' and u.day > current_date - 30) as plays_30d,
  string_agg(distinct nullif(u.country, ''), ', ' order by nullif(u.country, '')) as countries,
  max(u.day) as last_seen
from public.course_map_usage_daily u
left join public.course_maps m on m.course_id = u.course_id
group by u.course_id, m.course_name, u.origin;

revoke all on public.course_map_usage_summary from public, anon, authenticated;
grant select on public.course_map_usage_summary to service_role;
