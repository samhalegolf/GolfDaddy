create extension if not exists pgcrypto;

create table if not exists public.user_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  account_email text,
  profile_id text,
  entitlement_type text not null,
  product_key text,
  status text not null default 'active',
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  stripe_customer_id text,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_subscription_id text,
  source_type text,
  source_referral_id uuid,
  entitlement_reason text,
  referral_eligible boolean not null default false,
  non_renewing boolean not null default false,
  scheduled_paid_start_at timestamptz,
  usage_count integer not null default 0,
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

drop policy if exists "service role can manage user entitlements" on public.user_entitlements;
create policy "service role can manage user entitlements"
on public.user_entitlements
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage payment events" on public.payment_events;
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
  stripe_customer_id text,
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

drop policy if exists "service role can manage app accounts" on public.app_accounts;
create policy "service role can manage app accounts"
on public.app_accounts
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage app profiles" on public.app_profiles;
create policy "service role can manage app profiles"
on public.app_profiles
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage app sync events" on public.app_sync_events;
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
  drop constraint if exists user_entitlements_status_check;

alter table if exists public.user_entitlements
  add column if not exists product_key text;

alter table if exists public.user_entitlements
  add column if not exists profile_id text;

alter table if exists public.user_entitlements
  add column if not exists usage_count integer not null default 0;

alter table if exists public.user_entitlements
  add column if not exists source_type text;

alter table if exists public.user_entitlements
  add column if not exists source_referral_id uuid;

alter table if exists public.user_entitlements
  add column if not exists entitlement_reason text;

alter table if exists public.user_entitlements
  add column if not exists referral_eligible boolean not null default false;

alter table if exists public.user_entitlements
  add column if not exists non_renewing boolean not null default false;

alter table if exists public.user_entitlements
  add column if not exists scheduled_paid_start_at timestamptz;

alter table if exists public.app_accounts
  add column if not exists stripe_customer_id text;

create unique index if not exists app_accounts_stripe_customer_id_unique
on public.app_accounts (stripe_customer_id)
where stripe_customer_id is not null;

create table if not exists public.payment_products (
  id uuid primary key default gen_random_uuid(),
  product_key text not null unique,
  product_kind text not null default 'month_pass' check (product_kind in ('month_pass', 'day_pass', 'round_pass', 'membership', 'free_pass')),
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

alter table if exists public.payment_products
  drop constraint if exists payment_products_product_kind_check;

alter table if exists public.payment_products
  add constraint payment_products_product_kind_check
  check (product_kind in ('month_pass', 'day_pass', 'round_pass', 'membership', 'free_pass'));

create index if not exists payment_products_active_idx on public.payment_products(active, sort_order);
create index if not exists payment_products_kind_idx on public.payment_products(product_kind);

create table if not exists public.caddie_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  account_email text,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  stripe_price_id text,
  status text not null default 'incomplete',
  access_until timestamptz,
  grace_until timestamptz,
  first_payment_failed_at timestamptz,
  cancel_at_period_end boolean not null default false,
  current_period_start timestamptz,
  current_period_end timestamptz,
  last_paid_invoice_id text,
  last_stripe_event_created_at timestamptz,
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists caddie_memberships_customer_idx on public.caddie_memberships(stripe_customer_id);
create index if not exists caddie_memberships_status_idx on public.caddie_memberships(status);
create index if not exists caddie_memberships_access_until_idx on public.caddie_memberships(access_until);
create index if not exists caddie_memberships_grace_until_idx on public.caddie_memberships(grace_until);

create table if not exists public.stripe_webhook_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  event_type text not null,
  stripe_created_at timestamptz,
  processed_at timestamptz,
  processing_status text not null default 'processing',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stripe_webhook_events_status_idx on public.stripe_webhook_events(processing_status, updated_at desc);
create index if not exists stripe_webhook_events_type_idx on public.stripe_webhook_events(event_type, stripe_created_at desc);

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
alter table public.caddie_memberships enable row level security;
alter table public.stripe_webhook_events enable row level security;

grant select, insert, update, delete on public.payment_products to service_role;
grant select, insert, update, delete on public.payment_admin_events to service_role;
grant select, insert, update, delete on public.caddie_memberships to service_role;
grant select, insert, update, delete on public.stripe_webhook_events to service_role;

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

drop policy if exists "service role can manage caddie memberships" on public.caddie_memberships;
create policy "service role can manage caddie memberships"
on public.caddie_memberships
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage stripe webhook events" on public.stripe_webhook_events;
create policy "service role can manage stripe webhook events"
on public.stripe_webhook_events
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
  ('month_pass', 'month_pass', 'One Month Pass', 'One payment for 30 days full access. No automatic renewal.', 'One month', 720, 'one_time', true, 'green', 10),
  ('monthly_membership', 'membership', 'Monthly Membership', 'Full access with monthly renewal. Cancel anytime.', 'Monthly', 720, 'monthly', false, 'blue', 20)
on conflict (product_key) do update set
  product_kind = excluded.product_kind,
  name = excluded.name,
  description = excluded.description,
  duration_hours = excluded.duration_hours,
  billing_schedule = excluded.billing_schedule,
  colour = excluded.colour,
  sort_order = excluded.sort_order,
  updated_at = now();
