-- Clarity Caddie — course play map storage.
-- Stores the mapped course geometry produced by the GPS auto mapper and
-- extracted by the course play pipeline (gd-course-play-pipeline.js).
-- One row per account + course. The full pipeline DB payload
-- (schema gd.course_play_pipeline.db.course, including every hole's
-- tee/green/route/fairway geometry) lives in payload jsonb.

create extension if not exists pgcrypto;

create table if not exists public.course_play_maps (
  id uuid primary key default gen_random_uuid(),
  account_id text not null default 'anonymous',
  account_email text,
  course_id text not null,
  course_key text,
  course_name text,
  status text,
  source text,
  data_version integer not null default 1,
  holes_count integer not null default 0,
  holes_ready_count integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  client_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, course_id)
);

create index if not exists course_play_maps_course_id_idx
on public.course_play_maps (course_id);

create index if not exists course_play_maps_account_id_idx
on public.course_play_maps (account_id);

create index if not exists course_play_maps_account_email_idx
on public.course_play_maps (account_email);

alter table public.course_play_maps enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_play_maps to service_role;

create policy "service role can manage course play maps"
on public.course_play_maps
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
