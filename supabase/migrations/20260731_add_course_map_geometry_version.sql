-- Same pattern as 20260720_add_course_map_hole_count.sql: a small, additive column on the
-- existing course_maps table. geometry_version is bumped whenever the server-side AutoMapper
-- algorithm (functions/lib/gd-automapper-core.mjs) changes in a way that should force every
-- course to be remapped, and is compared against course_mapper_jobs.mapper_version to decide
-- whether "this course at this mapper version" has already been processed.

alter table public.course_maps
add column if not exists geometry_version integer;

create index if not exists course_maps_geometry_version_idx
on public.course_maps (geometry_version);
