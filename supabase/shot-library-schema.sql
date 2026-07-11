-- Clarity Shot Library cloud backing store.
-- One row per practice import batch (session + capture + shots + rejects),
-- stored as jsonb so the client-side store shape can evolve without migrations.
-- Run this in the Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.shot_library_batches (
  id uuid primary key default gen_random_uuid(),
  import_batch_id text not null unique,
  account_id text,
  player_id text,
  player_name text,
  status text not null default 'active' check (status in ('active', 'deleted')),
  payload_json jsonb not null default '{}'::jsonb,
  shot_count integer not null default 0,
  client_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shot_library_batches_player_idx
on public.shot_library_batches (player_id, updated_at desc);

create index if not exists shot_library_batches_account_idx
on public.shot_library_batches (account_id, updated_at desc);

alter table public.shot_library_batches enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.shot_library_batches to service_role;

drop policy if exists "service role can manage shot library batches" on public.shot_library_batches;

create policy "service role can manage shot library batches"
on public.shot_library_batches
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
