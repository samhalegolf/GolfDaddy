-- Clarity Caddie course-map cloud backing store.
-- Supabase owns structured map truth; bulky visual artifacts should be linked
-- through assets_json rather than stored as tile arrays here.

create table if not exists public.course_maps (
  id text primary key,
  course_id text not null,
  course_name text not null,
  course_lat double precision,
  course_lng double precision,
  finder_lat double precision,
  finder_lng double precision,
  published boolean not null default true,
  published_at timestamptz,
  published_by_json jsonb not null default '{}'::jsonb,
  objects_json jsonb not null default '{}'::jsonb,
  holes_json jsonb not null default '{}'::jsonb,
  assets_json jsonb not null default '{}'::jsonb,
  course_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists course_maps_course_id_idx
on public.course_maps (course_id);

create index if not exists course_maps_updated_idx
on public.course_maps (updated_at desc);

create index if not exists course_maps_published_idx
on public.course_maps (published, updated_at desc);

alter table public.course_maps enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_maps to service_role;

drop policy if exists "service role can manage course maps" on public.course_maps;
create policy "service role can manage course maps"
on public.course_maps
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
