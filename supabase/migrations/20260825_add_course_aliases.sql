-- Every name a course has been known by.
--
-- A course arrives named whatever the scan could work out. For a multi-course site
-- that is often provisional - "Te Arai Links - Course 1" - because the loops are
-- separated before anything knows which is the North and which is the South.
--
-- A name is a label, not an identity: it can be missing, generic, wrong, or simply
-- change (Craigtoun was the Duke's until January 2026). So the row keeps its id and
-- its geometry, the display name is free to improve later, and the name it used to
-- have is kept here rather than thrown away - a search or a stored reference under
-- the old name still resolves.
--
-- The course picker reads course_name only and is unaffected. This column exists for
-- server-side lookup and for not losing history.

alter table course_maps add column if not exists course_aliases text[] default '{}';

create index if not exists course_maps_aliases_idx on course_maps using gin (course_aliases);

comment on column course_maps.course_aliases is
  'Every name this course has been known by, excluding the current course_name. Renaming appends the old name rather than losing it. The picker reads course_name only; this is for lookup and history.';
