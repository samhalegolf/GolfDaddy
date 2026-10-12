-- Whether the mapper reads OpenStreetMap alongside the overlay.
--
-- "include" (every overlay so far): the overlay is merged into what Overpass returns for the
-- ground, as it always was. "exclude": the overlay is the whole picture - no Overpass query is
-- made, and the mapper works from the hand-drawn shapes and the native resolver (the
-- scorecard) alone, so a fully drawn course is not confused by OSM's own, different shapes.
-- Chosen in Studio when the overlay is marked ready (functions/course-map-overlay.mjs); read
-- by the worker with the rest of a ready overlay (attachCourseOverlay).

alter table public.course_map_overlays
  add column if not exists osm text not null default 'include';

alter table public.course_map_overlays
  drop constraint if exists course_map_overlays_osm_check;
alter table public.course_map_overlays
  add constraint course_map_overlays_osm_check check (osm in ('include', 'exclude'));
