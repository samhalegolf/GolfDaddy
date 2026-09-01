-- Refinement state for the "Refine Shapes" maintenance action
-- (functions/course-mapper-worker-background.mjs:runShapeRefineJob).
--
-- Sibling of object_collection (20260901_add_course_map_object_collection.sql) and shaped the
-- same way, for the same reason: one jsonb holding one operation's state, rather than a spray
-- of loose revision/timestamp/status columns that later get compared against each other. See
-- that migration's comment for the bug that argument comes from.
--
-- Kept SEPARATE from object_collection rather than nested inside it because they are different
-- operations with different preconditions: collection needs OSM, refinement needs published
-- frames, and a course can very reasonably have had one and not the other. A sweep asking
-- "which courses still have raw OSM geometry" wants `shape_refinement is null` on its own.
--
-- Shape:
--   {
--     "revision": 1,
--     "status": "complete",
--     "refinerVersion": "s1",
--     "refinedAt": "2026-09-01T...Z",
--     "counts": { "refined": 31, "skipped": 2, "noFrame": 0 }
--   }
--
-- Null means refinement has never run for this course.

alter table if exists public.course_maps
  add column if not exists shape_refinement jsonb;

comment on column public.course_maps.shape_refinement is
  'Refine Shapes state: {revision, status, refinerVersion, refinedAt, counts}. Null = never run.';
