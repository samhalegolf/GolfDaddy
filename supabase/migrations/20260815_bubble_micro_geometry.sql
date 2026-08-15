-- Bubble Micro-Geometry: the server-side home for the player model and the
-- geometry configuration that produces it.
--
-- Two tables, and the split between them is the whole point of Phase 0:
--
--   bubble_geometry_configs  what Clarity believes about how bubbles mould.
--                            Versioned, published from Studio, one active row.
--                            Changing it must never need an App Store release.
--
--   bubble_player_models     the result of applying that belief to one
--                            player's practice data. Written when the data
--                            changes, read instantly on every screen open.
--
-- The phone reads a model and renders it. It does not compute one, and it does
-- not hold a copy of the config that produced it.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Geometry configuration versions
-- ---------------------------------------------------------------------------

create table if not exists public.bubble_geometry_configs (
  id uuid primary key default gen_random_uuid(),
  -- Monotonic, human-quotable. "the model changed at config 7" has to mean
  -- one specific thing.
  version integer not null unique,
  config_version integer not null default 1,
  model_version integer not null default 1,
  -- Exactly one row may be active. Enforced by the partial unique index below
  -- rather than by whoever happens to be writing, because two active configs
  -- would mean two different bubbles depending on which row a query saw first.
  active boolean not null default false,
  label text,
  note text,
  config_json jsonb not null default '{}'::jsonb,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bubble_geometry_configs_single_active_idx
on public.bubble_geometry_configs (active)
where active;

create index if not exists bubble_geometry_configs_version_idx
on public.bubble_geometry_configs (version desc);

-- ---------------------------------------------------------------------------
-- Player models
-- ---------------------------------------------------------------------------

create table if not exists public.bubble_player_models (
  id uuid primary key default gen_random_uuid(),
  -- One model per player. player_id is the scope everything else in the shot
  -- library is keyed by, so it is the key here too.
  player_id text not null unique,
  account_id text,
  model_version integer not null default 1,
  config_version integer not null default 1,
  -- The version of bubble_geometry_configs this model was built under. A model
  -- built under an older config is not wrong, it is just old - the sweeper
  -- rebuilds it, and until then the phone keeps rendering the last good one.
  geometry_config_id uuid references public.bubble_geometry_configs (id),
  -- The compact payload the phone hydrates. Kept whole rather than shredded
  -- into columns: the app reads it as one object and the shape is owned by
  -- scripts/gd-bubble-signals-core.js, not by this schema.
  model_json jsonb not null default '{}'::jsonb,
  -- Detection reasoning. Studio reads it; the phone never does.
  diagnostics_json jsonb not null default '{}'::jsonb,
  -- What the model was built from, so "is this stale" is answerable without
  -- re-running the analysis.
  source_shots integer not null default 0,
  source_batches integer not null default 0,
  source_latest_at timestamptz,
  status text not null default 'ready' check (status in ('ready', 'stale', 'failed')),
  error text,
  analysed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bubble_player_models_account_idx
on public.bubble_player_models (account_id, updated_at desc);

create index if not exists bubble_player_models_status_idx
on public.bubble_player_models (status, updated_at desc);

-- ---------------------------------------------------------------------------
-- Access
--
-- Same posture as shot_library_batches: RLS on, service role only. The browser
-- never queries these directly - it goes through /api/bubble-model, which
-- holds the service key and checks who is asking. Studio needs cross-player
-- reads and admin-only publishing, and neither is expressible as an anon-key
-- policy without handing every client the whole table.
-- ---------------------------------------------------------------------------

alter table public.bubble_geometry_configs enable row level security;
alter table public.bubble_player_models enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.bubble_geometry_configs to service_role;
grant select, insert, update, delete on public.bubble_player_models to service_role;

drop policy if exists "service role can manage bubble geometry configs" on public.bubble_geometry_configs;
create policy "service role can manage bubble geometry configs"
on public.bubble_geometry_configs
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage bubble player models" on public.bubble_player_models;
create policy "service role can manage bubble player models"
on public.bubble_player_models
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Seed: version 1, every Signal off.
--
-- The V1 success condition is that with all Signals disabled nothing changes,
-- so the FIRST published config has to be the one that changes nothing. An
-- empty table would work too, but then "no config" and "the off config" would
-- be different states that behave the same, and only one of them would be
-- visible in Studio.
-- ---------------------------------------------------------------------------

insert into public.bubble_geometry_configs (version, config_version, model_version, active, label, note, config_json, published_by)
select 1, 1, 1, true, 'Baseline - all Signals off',
       'Seeded with the migration. Identity geometry: every region 1.0, axis 0. Renders exactly the bubble that shipped before the Micro-Geometry engine existed.',
       '{"enabled": false}'::jsonb, 'migration'
where not exists (select 1 from public.bubble_geometry_configs);
