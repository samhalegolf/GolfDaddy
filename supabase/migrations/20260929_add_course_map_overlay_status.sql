-- Draft or ready: whether the mapper may read a course's overlay yet.
--
-- Drawing autosaves, so without this every half-finished session was live the moment it was
-- saved - a mapper run queued from anywhere (Course Database, a sweep) picked up whatever was
-- on the row. A session is now a draft until someone presses "Mark ready" in the Mapping
-- Overlay, and the worker (functions/course-mapper-worker-background.mjs:attachCourseOverlay)
-- merges only a ready overlay. Any change to the shapes puts it back to draft
-- (functions/lib/gd-map-overlay-store.mjs:saveOverlay), so what the mapper reads is always
-- something a person signed off.
--
-- Existing rows were being read by the mapper already, so they start as 'ready' - adding the
-- column changes nothing for them. New rows start as drafts.

alter table if exists public.course_map_overlays
  add column if not exists status text not null default 'ready';

alter table if exists public.course_map_overlays
  alter column status set default 'draft';

alter table if exists public.course_map_overlays
  drop constraint if exists course_map_overlays_status_check;
alter table if exists public.course_map_overlays
  add constraint course_map_overlays_status_check check (status in ('draft', 'ready'));

comment on column public.course_map_overlays.status is
  'draft = still being drawn, the mapper ignores it; ready = signed off, merged into every mapper run. Any shape change resets it to draft.';
