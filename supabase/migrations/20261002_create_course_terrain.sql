-- Course terrain as a versioned, Clarity-owned asset (functions/lib/terrain/).
--
-- One row per course: which terrain version is current, where its files are, and the
-- manifest that says where the heights came from (provider, dataset version, resolution,
-- CRS, vertical datum, licence, coverage, quality). The heights themselves never live here -
-- they are a terrain-RGB PNG in the course-visuals bucket under <courseId>/terrain/v<N>/.
--
-- status:
--   ready  - terrain_version points at a complete asset
--   failed - no asset has ever been baked; last_error says why
-- A failed REBAKE of a course that already has an asset keeps status 'ready' (the old asset
-- stays live) and only fills last_error / last_attempt_at.

create table if not exists public.course_terrain (
  course_id text primary key,
  terrain_version integer not null default 0,
  status text not null default 'failed',
  format_version text,
  primary_source_id text,
  source_ids text[] not null default '{}',
  quality_class text,
  green_detail text,
  confidence real,
  source_resolution_m real,
  grid_resolution_m real,
  vertical_datum text,
  coverage_core real,
  resolver_fingerprint text,
  manifest jsonb,
  heights_path text,
  mask_path text,
  manifest_path text,
  last_error text,
  last_attempt_at timestamptz,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "Rebuild terrain for every course covered by provider X" and the upgrade report.
create index if not exists course_terrain_primary_source_idx
on public.course_terrain (primary_source_id);

create index if not exists course_terrain_source_ids_idx
on public.course_terrain using gin (source_ids);

alter table public.course_terrain enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_terrain to service_role;

drop policy if exists "service role can manage course terrain" on public.course_terrain;
create policy "service role can manage course terrain"
on public.course_terrain
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- Provider data staged ONCE for sources that publish files rather than a service
-- (scripts/terrain/stage-terrain-source.mjs - OSNI's 10m DTM sheets first). Public read: every
-- source staged here is openly licensed, and bakes read it with plain GETs. Writes are
-- service-role only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('terrain-sources', 'terrain-sources', true, 20971520, array['application/json', 'application/gzip', 'application/octet-stream'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
