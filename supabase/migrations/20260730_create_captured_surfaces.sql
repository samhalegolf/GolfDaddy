-- Documents a table that has been live since functions/captured-surface-sync.js shipped
-- but never had a migration file. `create table if not exists` is a no-op against the live
-- table. This table is slated for removal once the client-side captured-surface subsystem
-- is retired (see the course-package migration plan, stage 8) - documenting it now makes
-- that a clean, reviewable `drop table` migration later instead of dropping something that
-- was never declared anywhere.
--
-- Columns verified against the live table (list_tables against the clarity-caddie Supabase
-- project) rather than inferred from client code alone - the actual primary key is a
-- surrogate `id uuid`, with `client_scan_id` as a unique column, and there is a separate
-- `created_at` alongside `client_created_at`. Matching this exactly matters beyond
-- documentation: it is also what a fresh preview/branch database gets created with.

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

create index if not exists captured_surfaces_course_key_idx
on public.captured_surfaces (course_key, hole_number, updated_at desc);

create index if not exists captured_surfaces_account_id_idx
on public.captured_surfaces (account_id, updated_at desc);

create index if not exists captured_surfaces_updated_at_idx
on public.captured_surfaces (updated_at desc);

alter table public.captured_surfaces enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.captured_surfaces to service_role;

drop policy if exists "service role can manage captured surfaces" on public.captured_surfaces;
create policy "service role can manage captured surfaces"
on public.captured_surfaces
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
