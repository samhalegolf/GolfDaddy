-- Stable identity for a course separated out of a multi-course site.
--
-- When one Overpass sweep finds two courses on one property, the mapper publishes
-- both: the pinned one into the row the job was enqueued against, the rest into
-- rows it creates itself. Those created rows need to survive a rescan.
--
-- A slug cannot do that. Names get edited in OSM, and a course_id derived from a
-- name moves when the name does, orphaning that course's visuals, captured
-- surfaces and shot events behind an id nothing references any more. OSM element
-- ids do not move, so the mapper matches on this first and falls back to the slug
-- only when the row predates the column.
--
-- Format is "<type>/<id>" as OSM writes it - way/123456, relation/789.
-- Nullable by design: every row created before 2026-08-25, and every course that
-- is the only one on its site, has nothing to put here.

alter table course_maps add column if not exists osm_course_ref text;

create index if not exists course_maps_osm_course_ref_idx
  on course_maps (osm_course_ref)
  where osm_course_ref is not null;

comment on column course_maps.osm_course_ref is
  'OSM element the course polygon came from ("way/123" | "relation/456"). Stable identity for courses the mapper separated out of a multi-course site; matched before course_id on rescan so an OSM name edit cannot orphan a course''s visuals and shot history.';
