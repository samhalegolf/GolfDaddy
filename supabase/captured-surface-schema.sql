-- Clarity Captured Surface cloud backing store.
-- One row per captured hole surface scan (green-centred Leaflet tile capture).
-- The scan manifest stores tile URL references + projection data, not image data.
-- Pushed by /api/captured-surface-sync (service role only). Run in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.captured_surfaces (
  id uuid primary key default gen_random_uuid(),
  client_scan_id text not null unique,
  account_id text,
  player_id text,
  course_key text not null,
  course_name text,
  hole_number integer not null default 1,
  source_type text,
  status_json jsonb not null default '{}'::jsonb,
  interaction_json jsonb not null default '{}'::jsonb,
  projection_json jsonb not null default '{}'::jsonb,
  pins_json jsonb not null default '{}'::jsonb,
  manifest_json jsonb not null default '{}'::jsonb,
  client_created_at timestamptz,
  client_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists captured_surfaces_course_hole_idx
on public.captured_surfaces (course_key, hole_number, updated_at desc);

create index if not exists captured_surfaces_account_idx
on public.captured_surfaces (account_id, updated_at desc);

alter table public.captured_surfaces enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.captured_surfaces to service_role;

drop policy if exists "service role can manage captured surfaces" on public.captured_surfaces;

create policy "service role can manage captured surfaces"
on public.captured_surfaces
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
