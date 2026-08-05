-- 20260731_add_course_map_geometry_version.sql declared this column `integer`, but every
-- consumer (course-mapper-worker-background.mjs, course-mapper-jobs.mjs, course-package.mjs,
-- gd-course-package-shape.mjs, and every dev/*.test.js fixture) treats it as an opaque version
-- STRING compared with `===` against MAPPER_VERSION ("v1"). The type mismatch made every save
-- of resolved geometry fail with Postgres error 22P02 since the column was created - confirmed
-- against production data: all course_maps rows had geometry_version = null, and
-- course_mapper_jobs showed repeated "invalid input syntax for type integer: \"v1\"" failures.
-- This is the pipeline-breaking bug the course scan pipeline has had since it moved server-side.
--
-- Applied directly to production on 2026-08-05 (all rows were null, so the ALTER was a clean
-- type change with nothing to convert); this file brings the migration history in the repo back
-- in sync with the live schema.
alter table public.course_maps
alter column geometry_version type text using geometry_version::text;
