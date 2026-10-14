-- A course's trees, found along its fairways and greens (functions/lib/gd-course-trees-core.mjs).
--
-- Their own layer, not shapes in course_map_overlays and not objects in course_maps: a
-- tree-lined course holds thousands, only the watch bake reads them, and both of those rows
-- are synced whole elsewhere (the phone's library, Studio's course database).
--
-- trees holds every tree the finder saw at any sensitivity, as
-- [lat, lng, radius_m, level, from_height]: `level` is the strictest sensitivity that finds
-- it, so the trees live on the watch are exactly those at or under the row's `level` (and
-- every one found from its height alone). Studio's More / Less move `level`, nothing else.
--
-- status: 'auto' while it is what a tree run left; 'edited' once someone published changes in
-- Studio - an automatic run never writes over an edited row.

create table if not exists public.course_trees (
  course_id text primary key,
  trees jsonb not null default '[]'::jsonb,
  level smallint not null default 2,
  status text not null default 'auto',     -- auto | edited
  imagery text,                             -- frames | esri | esri+frames
  run jsonb,                                -- {version, holes: {n: {count, source, error?}}, heights, ranAt}
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.course_trees enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_trees to service_role;
