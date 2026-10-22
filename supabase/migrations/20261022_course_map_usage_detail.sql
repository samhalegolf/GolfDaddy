-- Course map usage, with the detail that says how each open actually went.
--
-- 20261004_create_course_map_usage.sql counted downloads and rounds per course.
-- That left the most useful questions unanswered: did the map arrive straight
-- away, after a wait, or not at all? Full map or lite? Which version? Did an
-- update reach the phone? Did the watch get its maps? And a course with no map
-- was never counted at all, because record_course_map_usage only counted course
-- ids already in course_maps - so the courses most worth knowing about were
-- exactly the ones that vanished.
--
-- Still anonymous and aggregate-only: a daily tally, no account, guest id, IP or
-- user agent. The new columns describe the MAP and the OPEN, never the player.
--
-- event:
--   download         - a map reached a device that did not have this course
--   update           - a newer version replaced the copy a device already had
--   play             - a round was opened (once per course per device per day)
--   delivery-failed  - a watch could not be given this course's maps
-- origin adds apple-watch and garmin; plain 'watch' stays for rows (and older
-- app installs) from before the split.
-- map_type:  full | lite | live (round on the live map, no prepared map) | ''
-- outcome:   for a play - cached, ready, prepared, not-mapped, failed, timeout,
--            unreachable, signup-required, server-busy, account-error;
--            for a delivery-failed - why (no-package, report-unavailable,
--            assets-failed, error). '' when not recorded (older app installs).
-- version:   the course version label the device got or played (v1.4, W-v1.0)
-- wait_ms:   total time spent waiting for the map across the rows counted, so
--            wait_ms / count is the average wait

alter table public.course_map_usage_daily
  add column if not exists map_type text not null default '',
  add column if not exists outcome text not null default '',
  add column if not exists version text not null default '',
  add column if not exists wait_ms bigint not null default 0,
  add column if not exists course_name text;

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_event_check;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_event_check
  check (event in ('download', 'update', 'play', 'delivery-failed'));

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_origin_check;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_origin_check
  check (origin in ('web', 'ios', 'android', 'watch', 'apple-watch', 'garmin'));

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_map_type_check;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_map_type_check
  check (map_type in ('', 'full', 'lite', 'live'));

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_outcome_check;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_outcome_check
  check (outcome ~ '^[a-z-]{0,24}$');

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_version_check;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_version_check
  check (version ~ '^((W-)?v[0-9]{1,6}\.[0-9]{1,6})?$');

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_pkey;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_pkey
  primary key (day, course_id, event, origin, country, map_type, outcome, version);

-- The old four-argument counter is replaced, not overloaded: one function, one rule.
drop function if exists public.record_course_map_usage(text, text, text, text);

-- One atomic +1. Counts any course id - a course with no map is the case worth
-- seeing - with junk bounded by the endpoint's enums and the checks above.
create or replace function public.record_course_map_usage(
  p_course_id text,
  p_event text,
  p_origin text,
  p_country text default '',
  p_map_type text default '',
  p_outcome text default '',
  p_version text default '',
  p_wait_ms bigint default 0,
  p_course_name text default null
) returns void
language sql
set search_path = public
as $$
  insert into public.course_map_usage_daily
    (day, course_id, event, origin, country, map_type, outcome, version, count, wait_ms, course_name)
  values
    (current_date, p_course_id, p_event, p_origin, coalesce(p_country, ''), coalesce(p_map_type, ''),
     coalesce(p_outcome, ''), coalesce(p_version, ''), 1, greatest(coalesce(p_wait_ms, 0), 0),
     nullif(left(coalesce(p_course_name, ''), 120), ''))
  on conflict (day, course_id, event, origin, country, map_type, outcome, version)
  do update set
    count = public.course_map_usage_daily.count + 1,
    wait_ms = public.course_map_usage_daily.wait_ms + excluded.wait_ms,
    course_name = coalesce(excluded.course_name, public.course_map_usage_daily.course_name);
$$;

revoke all on function public.record_course_map_usage(text, text, text, text, text, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.record_course_map_usage(text, text, text, text, text, text, text, bigint, text) to service_role;

-- The summary view only ever served the old card; the report below replaces it.
drop view if exists public.course_map_usage_summary;

-- Everything the Studio Course Usage page reads, in one call and one JSON value
-- (so PostgREST's row cap never trims it). p_days null or <= 0 means all time.
--   rows:    per course x event x origin x map type x outcome x version
--   daily:   per day x event x origin, for the trend line
--   courses: per course - its name, whether it is in the Course Database, and
--            the columns its current version label is worked out from
create or replace function public.course_map_usage_report(p_days integer default 30)
returns jsonb
language sql
stable
set search_path = public
as $$
  with usage as (
    select * from public.course_map_usage_daily
    where p_days is null or p_days <= 0 or day > current_date - p_days
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(r) from (
        select course_id, event, origin, map_type, outcome, version,
               sum(count) as count, sum(wait_ms) as wait_ms, max(day) as last_seen,
               string_agg(distinct nullif(country, ''), ',') as countries
        from usage
        group by course_id, event, origin, map_type, outcome, version
      ) r), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(d order by d.day) from (
        select day, event, origin, sum(count) as count
        from usage
        group by day, event, origin
      ) d), '[]'::jsonb),
    'courses', coalesce((
      select jsonb_agg(c) from (
        select ids.course_id,
               coalesce(m.course_name, ids.course_name, ids.course_id) as course_name,
               (m.course_id is not null) as in_database,
               m.objects_revision,
               v.bake_number,
               v.bake_objects_revision,
               v.published_version
        from (
          select course_id, max(course_name) as course_name from usage group by course_id
        ) ids
        left join lateral (
          select course_id, course_name, objects_revision
          from public.course_maps
          where course_id = ids.course_id
          order by published desc nulls last, updated_at desc nulls last
          limit 1
        ) m on true
        left join lateral (
          select bake_number, bake_objects_revision, published_version
          from public.course_visuals
          where course_id = ids.course_id
          limit 1
        ) v on true
      ) c), '[]'::jsonb)
  );
$$;

revoke all on function public.course_map_usage_report(integer) from public, anon, authenticated;
grant execute on function public.course_map_usage_report(integer) to service_role;
