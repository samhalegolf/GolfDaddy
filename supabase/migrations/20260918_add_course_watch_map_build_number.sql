-- The Watch package's own publish counter, so a Watch map can be named the way a phone
-- map is: W-v1.0, W-v1.1, W-v2.0.
--
-- recipe_version was the closest thing already stored, and it is the wrong number for
-- this: it moves when the RECIPE changes, so a course regenerated three times on
-- recipe v3 would call all three packages W-v3, and "which asset am I looking at" would
-- have no answer. watch_package_version is epoch milliseconds - correct for ordering,
-- unreadable as a name.
--
-- Deliberately mirrors course_visuals.bake_number / bake_objects_revision rather than
-- inventing a second scheme, so the one shared formatter
-- (scripts/gd-course-version-label.js) renders phone and Watch packages with the same
-- rule and only the W- prefix differs.

alter table public.course_watch_maps
  add column if not exists watch_build_number integer not null default 0,
  add column if not exists source_objects_revision integer;

update public.course_watch_maps
   set watch_build_number = 1
 where watch_build_number = 0
   and status is distinct from 'failed';

update public.course_watch_maps w
   set source_objects_revision = m.objects_revision
  from public.course_maps m
 where m.course_id = w.course_id
   and w.source_objects_revision is null;
