-- Garmin watch packages - the drawn map, with no images.
--
-- A Garmin draws each hole itself from outlines and terrain pieces (see
-- docs/WATCH_ARCHITECTURE.md, "The drawn map"), so it needs none of the baked hole
-- images the Apple Watch uses from course_watch_maps. This table holds just the data:
-- per hole the spatial reference, the golf reference, the outlines, the terrain
-- pieces and the palette.
--
-- Built automatically after the normal course package is made (end of a mapper run,
-- and again after the visual export, when the elevation the terrain needs exists),
-- and rebuilt whenever the course's geometry or terrain moves on. See
-- functions/course-garmin-maps-background.mjs.

create table if not exists public.course_garmin_maps (
  id text primary key,
  course_id text not null,
  status text not null default 'none',                -- none | partial | ready | failed
  garmin_package_version bigint not null default 0,   -- Date.now() at build; what the watch keys its copy on
  builder_version integer not null default 0,         -- GARMIN_BUILDER_VERSION; a new builder rebuilds every course
  source_objects_revision integer,                    -- course_maps.objects_revision it was built from
  source_objects_version text,                        -- objectsVersion() at build, for courses with no revision
  terrain_generated_at text,                          -- frames/index.json generatedAt it took terrain from, or null
  hole_count integer not null default 0,
  ready_hole_count integer not null default 0,
  holes jsonb not null default '[]'::jsonb,           -- [{holeNumber, spatialReference, reference, outlines, terrain, palette}]
  errors jsonb not null default '[]'::jsonb,
  building_since timestamptz,                         -- set while a build runs, so two cannot overlap
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists course_garmin_maps_course_id_idx
on public.course_garmin_maps (course_id);

alter table public.course_garmin_maps enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_garmin_maps to service_role;

drop policy if exists "service role can manage course garmin maps" on public.course_garmin_maps;
create policy "service role can manage course garmin maps"
on public.course_garmin_maps
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
