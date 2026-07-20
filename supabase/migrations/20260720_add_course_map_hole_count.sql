-- Cheap hole count for the course library manifest.
--
-- The manifest endpoint exists so a device can check whether its downloaded
-- library is stale without pulling any course payloads. Deriving the hole count
-- from holes_json would defeat that: those columns run to tens of kilobytes per
-- course, so the server would read megabytes to answer a freshness question.
--
-- Stored as a column, written on publish. Null on rows published before this
-- migration - the manifest reports null rather than guessing, and the value
-- fills in the next time each course is published.

alter table if exists public.course_maps
  add column if not exists hole_count integer;

comment on column public.course_maps.hole_count is
  'Number of holes in holes_json at publish time. Denormalised so /api/course-library can answer without reading payload columns. Null means published before the column existed.';

-- Backfill what is already there; cheap at this size and saves waiting for a
-- republish of every existing course.
update public.course_maps
set hole_count = (
  select count(*)
  from jsonb_object_keys(coalesce(holes_json, '{}'::jsonb))
)
where hole_count is null
  and holes_json is not null
  and jsonb_typeof(holes_json) = 'object';
