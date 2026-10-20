-- Public course pages (/courses/<course_id>, functions/course-page.mjs).
--
-- A course gets a public, indexable page only when an admin says so. Being
-- published, having a visual and a scorecard are necessary but not sufficient:
-- a half-finished map must never go public by accident, so the switch is
-- explicit and defaults to off. Flipped per course from the Studio course row.

alter table public.course_maps
  add column if not exists page_public boolean not null default false;

create index if not exists course_maps_page_public_idx
  on public.course_maps (page_public) where page_public;
