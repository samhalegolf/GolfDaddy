create extension if not exists pgcrypto;

create table if not exists public.user_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  account_email text,
  entitlement_type text not null check (entitlement_type in ('day_pass', 'round_pass', 'subscription')),
  status text not null default 'active' check (status in ('active', 'expired', 'refunded', 'cancelled')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  stripe_customer_id text,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_subscription_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_entitlements_user_id_idx
on public.user_entitlements (user_id);

create index if not exists user_entitlements_account_email_idx
on public.user_entitlements (account_email);

create index if not exists user_entitlements_active_idx
on public.user_entitlements (status, expires_at);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  event_type text not null,
  payload_json jsonb not null,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.user_entitlements enable row level security;
alter table public.payment_events enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.user_entitlements to service_role;
grant select, insert, update, delete on public.payment_events to service_role;

create policy "service role can manage user entitlements"
on public.user_entitlements
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role can manage payment events"
on public.payment_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- Core app account/profile storage. This makes Supabase the source of truth for identity records.
create table if not exists public.app_accounts (
  id uuid primary key default gen_random_uuid(),
  account_id text not null unique,
  profile_id text not null,
  email text not null unique,
  name text not null,
  role text not null default 'player' check (role in ('player', 'subscribedPlayer', 'coach', 'admin')),
  created_by_coach_id text,
  linked_coach_ids jsonb not null default '[]'::jsonb,
  linked_player_ids jsonb not null default '[]'::jsonb,
  requires_password_setup boolean not null default false,
  password_salt text,
  password_hash text,
  last_login_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists app_accounts_account_id_idx on public.app_accounts (account_id);
create index if not exists app_accounts_email_idx on public.app_accounts (email);
create index if not exists app_accounts_role_idx on public.app_accounts (role);

create table if not exists public.app_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null unique,
  account_id text not null,
  email text not null,
  name text not null,
  permission text not null default 'player',
  handedness text,
  handicap text,
  bag_json jsonb not null default '[]'::jsonb,
  profile_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists app_profiles_profile_id_idx on public.app_profiles (profile_id);
create index if not exists app_profiles_account_id_idx on public.app_profiles (account_id);
create index if not exists app_profiles_email_idx on public.app_profiles (email);

create table if not exists public.app_sync_events (
  id uuid primary key default gen_random_uuid(),
  account_id text,
  profile_id text,
  event_type text not null,
  status text not null default 'synced',
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists app_sync_events_account_id_idx on public.app_sync_events (account_id);
create index if not exists app_sync_events_created_at_idx on public.app_sync_events (created_at desc);

alter table public.app_accounts enable row level security;
alter table public.app_profiles enable row level security;
alter table public.app_sync_events enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.app_accounts to service_role;
grant select, insert, update, delete on public.app_profiles to service_role;
grant select, insert, update, delete on public.app_sync_events to service_role;

create policy "service role can manage app accounts"
on public.app_accounts
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role can manage app profiles"
on public.app_profiles
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role can manage app sync events"
on public.app_sync_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- Supabase Auth migration: app identity now points at auth.users.
alter table if exists public.app_accounts
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

alter table if exists public.app_profiles
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create index if not exists app_accounts_auth_user_id_idx on public.app_accounts(auth_user_id);
create index if not exists app_profiles_auth_user_id_idx on public.app_profiles(auth_user_id);

-- Local password hashes are no longer trusted. Keep columns only for safe migration/backward compatibility.
comment on column public.app_accounts.password_hash is 'Deprecated: local prototype password hash. Supabase Auth is the source of truth.';
comment on column public.app_accounts.password_salt is 'Deprecated: local prototype password salt. Supabase Auth is the source of truth.';

-- Payment Settings / Admin Access Model
-- Safe in-app settings live here. Stripe secret keys stay in Netlify environment variables.

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

grant select, insert, update, delete on public.payment_products to service_role;
grant select, insert, update, delete on public.payment_admin_events to service_role;

create policy "service role can manage payment products"
on public.payment_products
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role can manage payment admin events"
on public.payment_admin_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

insert into public.payment_products (
  product_key,
  product_kind,
  name,
  description,
  price_label,
  duration_hours,
  billing_schedule,
  active,
  colour,
  sort_order
) values
  ('day_pass', 'day_pass', 'Day Pass', 'Paid access for a single day.', 'Day pass', 24, 'one_time', true, 'orange', 10),
  ('round_pass', 'round_pass', 'Round Pass', 'Paid access for one round/day window.', 'Round pass', 24, 'one_time', true, 'green', 20),
  ('monthly_membership', 'membership', 'Monthly Membership', 'Recurring membership access.', 'Monthly', 720, 'monthly', false, 'blue', 30)
on conflict (product_key) do nothing;
