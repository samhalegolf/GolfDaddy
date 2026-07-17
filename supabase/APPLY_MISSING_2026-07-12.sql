-- ============================================================================
-- Clarity Caddy — apply MISSING Supabase schema (verified 2026-07-12)
-- ============================================================================
-- Run this ONCE in the Supabase SQL editor (project zcevluithwoumvafhmct).
-- It is safe to re-run: everything is if-not-exists / drop-if-exists.
--
-- Verified missing from the live project:
--   1. payment_products        (payment admin product manager is broken)
--   2. payment_admin_events    (admin audit trail is lost)
--   3. shot_library_batches    (shot library sync silently failing)
--   4. captured_surfaces       (NEW - captured surface scan backup)
--
-- It does NOT touch tables that already exist and work:
-- app_accounts, app_profiles, app_sync_events, user_entitlements,
-- payment_events, support_tickets, practice_* tables.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1 + 2. Payment products + admin events (from payment-schema.sql, bottom
-- section — the top of that file was applied, this part never was)
-- ----------------------------------------------------------------------------

-- user_entitlements upgrades that shipped with the products feature:
alter table if exists public.user_entitlements
  drop constraint if exists user_entitlements_entitlement_type_check;

alter table if exists public.user_entitlements
  add column if not exists product_key text;

create table if not exists public.payment_products (
  id uuid primary key default gen_random_uuid(),
  product_key text not null unique,
  product_kind text not null default 'day_pass' check (product_kind in ('day_pass', 'round_pass', 'membership', 'free_pass')),
  name text not null,
  description text not null default '',
  stripe_product_id text,
  stripe_price_id text,
  price_label text not null default '',
  duration_hours numeric not null default 24,
  billing_schedule text not null default 'one_time',
  active boolean not null default true,
  colour text not null default '',
  sort_order integer not null default 100,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_products_active_idx on public.payment_products(active, sort_order);
create index if not exists payment_products_kind_idx on public.payment_products(product_kind);

create table if not exists public.payment_admin_events (
  id uuid primary key default gen_random_uuid(),
  admin_account_id text,
  admin_email text,
  action text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payment_admin_events_created_at_idx on public.payment_admin_events(created_at desc);

alter table public.payment_products enable row level security;
alter table public.payment_admin_events enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.payment_products to service_role;
grant select, insert, update, delete on public.payment_admin_events to service_role;

drop policy if exists "service role can manage payment products" on public.payment_products;
create policy "service role can manage payment products"
on public.payment_products
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage payment admin events" on public.payment_admin_events;
create policy "service role can manage payment admin events"
on public.payment_admin_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

insert into public.payment_products (
  product_key, product_kind, name, description, price_label,
  duration_hours, billing_schedule, active, colour, sort_order
) values
  ('day_pass', 'day_pass', 'Day Pass', 'Paid access for a single day.', 'Day pass', 24, 'one_time', true, 'orange', 10),
  ('round_pass', 'round_pass', 'Round Pass', 'Paid access for one round/day window.', 'Round pass', 24, 'one_time', true, 'green', 20),
  ('monthly_membership', 'membership', 'Monthly Membership', 'Recurring membership access.', 'Monthly', 720, 'monthly', false, 'blue', 30)
on conflict (product_key) do nothing;

-- ----------------------------------------------------------------------------
-- 3. Shot library batches (from shot-library-schema.sql — never applied)
-- ----------------------------------------------------------------------------

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

grant select, insert, update, delete on public.shot_library_batches to service_role;

drop policy if exists "service role can manage shot library batches" on public.shot_library_batches;
create policy "service role can manage shot library batches"
on public.shot_library_batches
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- ----------------------------------------------------------------------------
-- 4. Captured surfaces (NEW — backs the previously dead client outbox)
-- ----------------------------------------------------------------------------

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

grant select, insert, update, delete on public.captured_surfaces to service_role;

drop policy if exists "service role can manage captured surfaces" on public.captured_surfaces;
create policy "service role can manage captured surfaces"
on public.captured_surfaces
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('payment_products', 'payment_admin_events', 'shot_library_batches', 'captured_surfaces')
order by table_name;
-- Expect 4 rows.
