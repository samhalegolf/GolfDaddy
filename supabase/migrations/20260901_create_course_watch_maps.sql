-- Watch Map package storage - deliberately separate from course_visuals (the native
-- satellite-capture pipeline). A Watch package is a small set of vector-drawn hole images
-- baked from course_maps.objects_json, plus the spatial reference needed to place a GPS
-- coordinate on each one. See scripts/gd-watch-map-core.js for the generator itself.

create table if not exists public.course_watch_maps (
  id text primary key,
  course_id text not null,
  status text not null default 'none',              -- none | partial | ready | failed
  watch_package_version bigint not null default 0,
  recipe_id text,
  recipe_version integer,
  source_objects_version text,                       -- objectsVersion() at generation time, for staleness checks
  hole_count integer not null default 0,
  ready_hole_count integer not null default 0,
  total_bytes integer not null default 0,
  format text,                                        -- "png" | "webp" - whichever the generator picked
  holes jsonb not null default '[]'::jsonb,            -- [{holeNumber, path, width, height, bytes, format, spatialReference, validation, layers}]
  errors jsonb not null default '[]'::jsonb,           -- [{holeNumber, reason}] for holes that failed to bake
  generated_at timestamptz,
  generated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists course_watch_maps_course_id_idx
on public.course_watch_maps (course_id);

create index if not exists course_watch_maps_status_idx
on public.course_watch_maps (status, updated_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-watch-maps', 'course-watch-maps', true, 2097152, array['image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table public.course_watch_maps enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_watch_maps to service_role;

drop policy if exists "service role can manage course watch maps" on public.course_watch_maps;
create policy "service role can manage course watch maps"
on public.course_watch_maps
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
