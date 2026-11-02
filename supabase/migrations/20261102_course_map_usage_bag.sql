-- Rounds by bag: whether the player had their own bag set when a round finished.
--
-- A 'round' row (20261102_course_map_usage_round_results.sql) says how an opened round
-- went. This adds whether the player had set their own bag by then, so the Studio can
-- show whether the players who set a bag are the ones who keep playing:
--
--   bag:  own      their own distances, or a quick set from their own 7-iron
--         not-set  no clubs, the stock distances, or a quick set left at the default 7-iron
--         ''       not recorded (every other event, and older app builds)
--
-- Worked out on the phone from the distances themselves (scripts/gd-bag-status.js), the
-- same rule the Studio Users screen uses. Still anonymous: one word about the bag, never
-- the clubs.

alter table public.course_map_usage_daily
  add column if not exists bag text not null default '';

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_bag_check;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_bag_check
  check (bag in ('', 'own', 'not-set'));

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_pkey;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_pkey
  primary key (day, course_id, event, origin, country, map_type, outcome, version, bag);

-- Replaced, not overloaded: one function, one rule. Calls that leave p_bag out (the
-- endpoint until it is redeployed) still resolve here through its default.
drop function if exists public.record_course_map_usage(text, text, text, text, text, text, text, bigint, text);

create or replace function public.record_course_map_usage(
  p_course_id text,
  p_event text,
  p_origin text,
  p_country text default '',
  p_map_type text default '',
  p_outcome text default '',
  p_version text default '',
  p_wait_ms bigint default 0,
  p_course_name text default null,
  p_bag text default ''
) returns void
language sql
set search_path = public
as $$
  insert into public.course_map_usage_daily
    (day, course_id, event, origin, country, map_type, outcome, version, bag, count, wait_ms, course_name)
  values
    (current_date, p_course_id, p_event, p_origin, coalesce(p_country, ''), coalesce(p_map_type, ''),
     coalesce(p_outcome, ''), coalesce(p_version, ''), coalesce(p_bag, ''), 1, greatest(coalesce(p_wait_ms, 0), 0),
     nullif(left(coalesce(p_course_name, ''), 120), ''))
  on conflict (day, course_id, event, origin, country, map_type, outcome, version, bag)
  do update set
    count = public.course_map_usage_daily.count + 1,
    wait_ms = public.course_map_usage_daily.wait_ms + excluded.wait_ms,
    course_name = coalesce(excluded.course_name, public.course_map_usage_daily.course_name);
$$;

revoke all on function public.record_course_map_usage(text, text, text, text, text, text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.record_course_map_usage(text, text, text, text, text, text, text, bigint, text, text) to service_role;

-- The report's rows gain the bag; everything else is as 20261022_course_map_usage_detail.sql.
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
        select course_id, event, origin, map_type, outcome, version, bag,
               sum(count) as count, sum(wait_ms) as wait_ms, max(day) as last_seen,
               string_agg(distinct nullif(country, ''), ',') as countries
        from usage
        group by course_id, event, origin, map_type, outcome, version, bag
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
