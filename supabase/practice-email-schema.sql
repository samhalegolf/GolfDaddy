create extension if not exists pgcrypto;

create table if not exists public.practice_email_intake_events (
  id uuid primary key default gen_random_uuid(),
  intake_id text not null unique,
  account_id text,
  profile_id text,
  player_key text not null,
  recipient_email text,
  sender_email text,
  subject text,
  provider_message_id text,
  status text not null default 'received' check (status in ('received', 'staged', 'needs_review', 'pending_photo', 'unsupported', 'failed')),
  routing_json jsonb not null default '{}'::jsonb,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists practice_email_intake_events_player_key_idx
on public.practice_email_intake_events (player_key, created_at desc);

create index if not exists practice_email_intake_events_account_id_idx
on public.practice_email_intake_events (account_id, created_at desc);

create index if not exists practice_email_intake_events_profile_id_idx
on public.practice_email_intake_events (profile_id, created_at desc);

create table if not exists public.practice_import_batches (
  id uuid primary key default gen_random_uuid(),
  import_batch_id text not null unique,
  session_id text not null,
  intake_id text references public.practice_email_intake_events (intake_id) on delete set null,
  account_id text,
  profile_id text,
  player_key text not null,
  player_id text,
  player_name text,
  source_type text not null,
  source_name text,
  row_count integer not null default 0,
  valid_count integer not null default 0,
  invalid_count integer not null default 0,
  status text not null default 'staged' check (status in ('staged', 'needs_review', 'imported', 'rejected')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists practice_import_batches_player_key_idx
on public.practice_import_batches (player_key, created_at desc);

create index if not exists practice_import_batches_intake_id_idx
on public.practice_import_batches (intake_id);

create table if not exists public.practice_native_shots (
  id uuid primary key default gen_random_uuid(),
  shot_id text not null unique,
  import_batch_id text not null references public.practice_import_batches (import_batch_id) on delete cascade,
  session_id text not null,
  intake_id text,
  account_id text,
  profile_id text,
  player_key text not null,
  player_id text,
  player_name text,
  club text,
  shot_number numeric,
  metrics_json jsonb not null default '{}'::jsonb,
  raw_source_json jsonb not null default '{}'::jsonb,
  unknown_fields_json jsonb not null default '{}'::jsonb,
  warnings_json jsonb not null default '[]'::jsonb,
  errors_json jsonb not null default '[]'::jsonb,
  status text not null default 'ready_for_gate' check (status in ('ready_for_gate', 'native_valid', 'native_invalid', 'rejected', 'imported')),
  source_type text,
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists practice_native_shots_batch_idx
on public.practice_native_shots (import_batch_id, shot_number);

create index if not exists practice_native_shots_player_key_idx
on public.practice_native_shots (player_key, created_at desc);

alter table public.practice_email_intake_events enable row level security;
alter table public.practice_import_batches enable row level security;
alter table public.practice_native_shots enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.practice_email_intake_events to service_role;
grant select, insert, update, delete on public.practice_import_batches to service_role;
grant select, insert, update, delete on public.practice_native_shots to service_role;

create policy "service role can manage practice email intake events"
on public.practice_email_intake_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role can manage practice import batches"
on public.practice_import_batches
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role can manage practice native shots"
on public.practice_native_shots
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
