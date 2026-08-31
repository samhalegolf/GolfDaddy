-- Enrichment state for the "Collect Extra Objects" maintenance action
-- (functions/course-mapper-worker-background.mjs:runObjectCollectionJob).
--
-- One jsonb column rather than four parallel revision/timestamp/status/version columns.
-- The course package already carries two different notions of "version" - geometry_version
-- (the mapper ALGORITHM version, a string like "v2") and objectsVersion (a TIMESTAMP derived
-- from published_at/updated_at) - and comparing one against the other is what once made every
-- course with a null geometry_version read as permanently "Update available"
-- (see functions/lib/gd-course-package-shape.mjs:objectsVersion). Adding four more loose
-- version-ish columns is four more chances to reintroduce that. One object, one meaning.
--
-- Shape:
--   {
--     "revision": 3,                       -- bumped per successful collection run
--     "status": "complete",                -- never_run implied by the column being null
--     "collectorVersion": "s1",            -- SURFACE_MAPPER_VERSION at the time of the run
--     "collectedAt": "2026-09-01T...Z",
--     "counts": { "fairway_area": 18, "bunker": 41, "water": 6 }
--   }
--
-- Null means the enrichment has never run for this course, which is the query a library-wide
-- retro-fit sweep is built on: `where object_collection is null`.
--
-- Deliberately NOT nested inside objects_json: that column is rewritten wholesale by every
-- mapper run, and this must survive one.

alter table if exists public.course_maps
  add column if not exists object_collection jsonb;

comment on column public.course_maps.object_collection is
  'Collect Extra Objects state: {revision, status, collectorVersion, collectedAt, counts}. Null = never run.';
