-- Clarity Course Visual Engine metadata.
-- Structured records live in Supabase. Bulky immutable visual assets are linked
-- by path so storage can evolve without coupling Play to table internals.

create table if not exists public.course_visuals (
  id text primary key,
  course_id text not null,
  status text not null default 'unavailable',
  raw_master_path text,
  basic_image_path text,
  preview_image_path text,
  published_image_path text,
  course_bounds jsonb not null default '{}'::jsonb,
  source_capture_ids jsonb not null default '[]'::jsonb,
  preset_id text,
  preset_version integer not null default 0,
  course_overrides jsonb not null default '{}'::jsonb,
  current_version integer not null default 0,
  published_version integer not null default 0,
  last_error jsonb not null default '{}'::jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  versions jsonb not null default '[]'::jsonb,
  uploaded_assets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists course_visuals_course_id_idx
on public.course_visuals (course_id);

create index if not exists course_visuals_status_idx
on public.course_visuals (status, updated_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-visuals', 'course-visuals', true, 10485760, array['image/svg+xml', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table public.course_visuals enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_visuals to service_role;

drop policy if exists "service role can manage course visuals" on public.course_visuals;
create policy "service role can manage course visuals"
on public.course_visuals
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
