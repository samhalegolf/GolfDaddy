-- Courses the mapper separated from one scan of one site.
--
-- When a sweep finds more than one of each hole number, the loops are separated and
-- each publishes as its own course. The mapper knows at that moment that they share
-- a property - one job, one Overpass payload, N loops. Writing that down is cheaper
-- and more certain than making the picker re-derive it from distance later, which is
-- a guess with a threshold that can be wrong in both directions.
--
-- This is NOT the facility record the 2026-08-19 plan rejected. That proposal
-- invented a parent from proximity and rendered it as hierarchy; the rule there -
-- "render distance, never hierarchy" - still holds. Here the courses stay flat,
-- independent and individually playable. facility_key only says "these came out of
-- the same scan", which is a fact we measured rather than a relationship we inferred.
--
-- The value is the course_id of the pinned course at separation time: already unique,
-- already stable, and meaningful when read by a human.

alter table course_maps add column if not exists facility_key text;

create index if not exists course_maps_facility_key_idx
  on course_maps (facility_key) where facility_key is not null;

comment on column course_maps.facility_key is
  'Shared token linking courses separated from one scan of one site. Flat, not hierarchical - each course keeps its own row, id, geometry and visuals. Null when a course is the only one on its site.';
