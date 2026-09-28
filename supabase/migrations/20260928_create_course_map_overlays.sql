-- Mapping overlay: hand-drawn fairway polygons and hole lines the mapper merges into the
-- Overpass payload before it resolves a course (functions/lib/gd-map-overlay-core.mjs).
--
-- A separate table, not a column on course_maps, for two reasons. objects_json is rewritten
-- wholesale by every mapper run, so anything that has to SURVIVE a run cannot live inside it;
-- and the overlay is meant to be deleted outright once OSM carries the real shapes, which is
-- a row delete here and would be a null-out-one-column-among-forty there.
--
-- One row per course. features is the list Studio draws and the worker reads:
--   [{ "id": "f-1", "kind": "fairway" | "hole", "hole": 7 | null, "points": [{"lat","lng"}, ...] }]
--
-- Service role only: written by /api/course-map-overlay after admin verification, read by the
-- mapper worker. Nothing on a player's device reads or writes this table.

create table if not exists public.course_map_overlays (
  course_id text primary key,
  features jsonb not null default '[]'::jsonb,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.course_map_overlays is
  'Hand-drawn mapping overlay (fairway polygons, hole lines, greens) merged into the OSM payload by the mapper worker. Delete the row once OSM has the real shapes.';

alter table public.course_map_overlays enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_map_overlays to service_role;

drop policy if exists "service role can manage course map overlays" on public.course_map_overlays;
create policy "service role can manage course map overlays"
on public.course_map_overlays
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
