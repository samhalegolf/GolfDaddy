-- Live progress for the Watch map bake.
--
-- The bake is one synchronous POST (see functions/course-watch-maps.mjs's header on why it is
-- not a job queue), so there is no jobs table to read a percentage out of the way the visual
-- pipeline has. This column is where the bake writes how far through it is, per hole, while it
-- runs; Studio polls the normal report endpoint and draws the same progress bar every other
-- long action on that screen uses.
--
-- Deliberately its own column rather than reusing status/ready_hole_count. Those describe the
-- STORED package, which stays live and deliverable to the wrist throughout a re-bake - a
-- regenerate must not make the existing package look half-built while the new one is still
-- being made. Nulled by the generator on success, so a finished package carries no progress.
--
-- Shape: {stage, holeCount, startedAt, updatedAt}. `stage` matches the watch_map phase table
-- in scripts/gd-progress-core.js ("reading-course", "baking-hole-7-of-18", "saving-package").
alter table public.course_watch_maps
  add column if not exists progress jsonb;

comment on column public.course_watch_maps.progress is
  'Live bake progress {stage, holeCount, startedAt, updatedAt}; null when no bake is running.';
