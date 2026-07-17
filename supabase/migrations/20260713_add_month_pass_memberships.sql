-- ============================================================================
-- Clarity Caddy payment rollout: Month Pass + Monthly Membership
-- ============================================================================
-- Production rollout file for the Stripe Month Pass / Membership branch.
--
-- Compatibility notes:
-- - This migration intentionally does not recreate or drop payment tables.
-- - Day Pass, Round Pass, existing user_entitlements and payment_events rows are
--   preserved. The new product_kind constraint is added NOT VALID so any legacy
--   rows outside the new enum do not block the rollout; new/updated rows must use
--   an allowed kind.
-- - Run supabase/payment-rollout-preflight.sql first. Duplicate customer,
--   subscription, or webhook identifiers should be cleaned up before production
--   launch even though this migration skips unsafe unique-index creation when
--   duplicates are present.
-- ============================================================================

create extension if not exists pgcrypto;

-- Keep existing entitlement history, but add the columns the new payment code
-- needs to distinguish Month Pass, legacy Day/Round, refunds, and Stripe IDs.
alter table if exists public.user_entitlements
  drop constraint if exists user_entitlements_entitlement_type_check;

alter table if exists public.user_entitlements
  drop constraint if exists user_entitlements_status_check;

alter table if exists public.user_entitlements
  add column if not exists product_key text;

alter table if exists public.user_entitlements
  add column if not exists profile_id text;

alter table if exists public.user_entitlements
  add column if not exists stripe_customer_id text;

alter table if exists public.user_entitlements
  add column if not exists stripe_checkout_session_id text;

alter table if exists public.user_entitlements
  add column if not exists stripe_payment_intent_id text;

alter table if exists public.user_entitlements
  add column if not exists stripe_subscription_id text;

alter table if exists public.user_entitlements
  add column if not exists usage_count integer not null default 0;

alter table if exists public.user_entitlements
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists user_entitlements_product_key_idx
on public.user_entitlements(product_key);

create index if not exists user_entitlements_profile_id_idx
on public.user_entitlements(profile_id);

create index if not exists user_entitlements_stripe_customer_idx
on public.user_entitlements(stripe_customer_id)
where stripe_customer_id is not null;

create index if not exists user_entitlements_stripe_payment_intent_idx
on public.user_entitlements(stripe_payment_intent_id)
where stripe_payment_intent_id is not null;

create index if not exists user_entitlements_active_product_idx
on public.user_entitlements(user_id, account_email, product_key, status, expires_at);

do $$
begin
  if to_regclass('public.user_entitlements') is not null
     and not exists (
       select 1 from pg_indexes
       where schemaname = 'public'
         and indexname = 'user_entitlements_checkout_session_unique'
     )
     and not exists (
       select 1
       from public.user_entitlements
       where stripe_checkout_session_id is not null
       group by stripe_checkout_session_id
       having count(*) > 1
     ) then
    create unique index user_entitlements_checkout_session_unique
    on public.user_entitlements(stripe_checkout_session_id)
    where stripe_checkout_session_id is not null;
  elsif to_regclass('public.user_entitlements') is not null then
    raise notice 'Skipped user_entitlements_checkout_session_unique because duplicate checkout session IDs exist or the index already exists. Resolve preflight blockers before launch.';
  end if;
end $$;

-- app_accounts owns the reusable Stripe Customer mapping. The unique index is
-- added only when safe, so legacy duplicate customer IDs do not crash rollout.
alter table if exists public.app_accounts
  add column if not exists stripe_customer_id text;

create index if not exists app_accounts_stripe_customer_idx
on public.app_accounts(stripe_customer_id)
where stripe_customer_id is not null;

do $$
begin
  if to_regclass('public.app_accounts') is not null
     and not exists (
       select 1 from pg_indexes
       where schemaname = 'public'
         and indexname = 'app_accounts_stripe_customer_id_unique'
     )
     and not exists (
       select 1
       from public.app_accounts
       where stripe_customer_id is not null
       group by stripe_customer_id
       having count(*) > 1
     ) then
    create unique index app_accounts_stripe_customer_id_unique
    on public.app_accounts(stripe_customer_id)
    where stripe_customer_id is not null;
  elsif to_regclass('public.app_accounts') is not null then
    raise notice 'Skipped app_accounts_stripe_customer_id_unique because duplicate Stripe Customer IDs exist or the index already exists. Resolve preflight blockers before launch.';
  end if;
end $$;

-- payment_products may already exist from APPLY_MISSING_2026-07-12.sql. Create
-- it only when absent, otherwise extend it in-place and preserve all existing
-- products, prices, and active flags.
create table if not exists public.payment_products (
  id uuid primary key default gen_random_uuid(),
  product_key text not null unique,
  product_kind text not null default 'month_pass',
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
  add column if not exists product_key text;

alter table if exists public.payment_products
  add column if not exists product_kind text;

alter table if exists public.payment_products
  add column if not exists name text;

alter table if exists public.payment_products
  add column if not exists description text not null default '';

alter table if exists public.payment_products
  add column if not exists stripe_product_id text;

alter table if exists public.payment_products
  add column if not exists stripe_price_id text;

alter table if exists public.payment_products
  add column if not exists price_label text not null default '';

alter table if exists public.payment_products
  add column if not exists duration_hours numeric not null default 24;

alter table if exists public.payment_products
  add column if not exists billing_schedule text not null default 'one_time';

alter table if exists public.payment_products
  add column if not exists active boolean not null default true;

alter table if exists public.payment_products
  add column if not exists colour text not null default '';

alter table if exists public.payment_products
  add column if not exists sort_order integer not null default 100;

alter table if exists public.payment_products
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table if exists public.payment_products
  alter column product_kind set default 'month_pass';

alter table if exists public.payment_products
  drop constraint if exists payment_products_product_kind_check;

do $$
begin
  if to_regclass('public.payment_products') is not null
     and not exists (
       select 1
       from pg_constraint
       where conrelid = 'public.payment_products'::regclass
         and conname = 'payment_products_product_kind_check'
     ) then
    alter table public.payment_products
      add constraint payment_products_product_kind_check
      check (product_kind in ('month_pass', 'day_pass', 'round_pass', 'membership', 'free_pass'))
      not valid;
  end if;
end $$;

create index if not exists payment_products_active_idx
on public.payment_products(active, sort_order);

create index if not exists payment_products_kind_idx
on public.payment_products(product_kind);

do $$
begin
  if not exists (
       select 1 from pg_indexes
       where schemaname = 'public'
         and indexname = 'payment_products_product_key_unique'
     )
     and not exists (
       select 1
       from public.payment_products
       where product_key is not null
       group by product_key
       having count(*) > 1
     ) then
    create unique index payment_products_product_key_unique
    on public.payment_products(product_key);
  end if;
end $$;

do $$
begin
  if exists (select 1 from public.payment_products where product_key = 'month_pass') then
    update public.payment_products
    set
      product_kind = 'month_pass',
      name = coalesce(nullif(name, ''), 'One Month Pass'),
      description = coalesce(nullif(description, ''), 'One payment for 30 days full access. No automatic renewal.'),
      price_label = coalesce(nullif(price_label, ''), 'One month'),
      duration_hours = case when duration_hours is null or duration_hours <= 0 then 720 else duration_hours end,
      billing_schedule = coalesce(nullif(billing_schedule, ''), 'one_time'),
      colour = coalesce(nullif(colour, ''), 'green'),
      sort_order = case when sort_order is null or sort_order = 100 then 10 else sort_order end,
      updated_at = now()
    where product_key = 'month_pass';
  else
    insert into public.payment_products (
      product_key, product_kind, name, description, price_label,
      duration_hours, billing_schedule, active, colour, sort_order
    ) values (
      'month_pass', 'month_pass', 'One Month Pass',
      'One payment for 30 days full access. No automatic renewal.',
      'One month', 720, 'one_time', true, 'green', 10
    );
  end if;

  if exists (select 1 from public.payment_products where product_key = 'monthly_membership') then
    update public.payment_products
    set
      product_kind = 'membership',
      name = coalesce(nullif(name, ''), 'Monthly Membership'),
      description = coalesce(nullif(description, ''), 'Full access with monthly renewal. Cancel anytime.'),
      price_label = coalesce(nullif(price_label, ''), 'Monthly'),
      duration_hours = case when duration_hours is null or duration_hours <= 0 then 720 else duration_hours end,
      billing_schedule = coalesce(nullif(billing_schedule, ''), 'monthly'),
      colour = coalesce(nullif(colour, ''), 'blue'),
      sort_order = case when sort_order is null or sort_order = 100 then 20 else sort_order end,
      updated_at = now()
    where product_key = 'monthly_membership';
  else
    insert into public.payment_products (
      product_key, product_kind, name, description, price_label,
      duration_hours, billing_schedule, active, colour, sort_order
    ) values (
      'monthly_membership', 'membership', 'Monthly Membership',
      'Full access with monthly renewal. Cancel anytime.',
      'Monthly', 720, 'monthly', false, 'blue', 20
    );
  end if;
end $$;

-- caddie_memberships is a projection of Stripe subscription state. It is
-- separate from one-time entitlements so Month Pass access can survive a failed
-- or cancelled Membership.
create table if not exists public.caddie_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  account_email text,
  stripe_customer_id text,
  stripe_subscription_id text,
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

alter table if exists public.caddie_memberships
  add column if not exists account_email text,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_price_id text,
  add column if not exists access_until timestamptz,
  add column if not exists grace_until timestamptz,
  add column if not exists first_payment_failed_at timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists current_period_start timestamptz,
  add column if not exists current_period_end timestamptz,
  add column if not exists last_paid_invoice_id text,
  add column if not exists last_stripe_event_created_at timestamptz,
  add column if not exists last_synced_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists caddie_memberships_user_idx
on public.caddie_memberships(user_id);

create index if not exists caddie_memberships_customer_idx
on public.caddie_memberships(stripe_customer_id);

create index if not exists caddie_memberships_status_idx
on public.caddie_memberships(status);

create index if not exists caddie_memberships_access_until_idx
on public.caddie_memberships(access_until);

create index if not exists caddie_memberships_grace_until_idx
on public.caddie_memberships(grace_until);

do $$
begin
  if not exists (
       select 1 from pg_indexes
       where schemaname = 'public'
         and indexname = 'caddie_memberships_user_unique'
     )
     and not exists (
       select 1
       from public.caddie_memberships
       where user_id is not null
       group by user_id
       having count(*) > 1
     ) then
    create unique index caddie_memberships_user_unique
    on public.caddie_memberships(user_id);
  else
    raise notice 'Skipped caddie_memberships_user_unique because duplicate user rows exist or the index already exists. Resolve preflight blockers before launch.';
  end if;

  if not exists (
       select 1 from pg_indexes
       where schemaname = 'public'
         and indexname = 'caddie_memberships_subscription_unique'
     )
     and not exists (
       select 1
       from public.caddie_memberships
       where stripe_subscription_id is not null
       group by stripe_subscription_id
       having count(*) > 1
     ) then
    create unique index caddie_memberships_subscription_unique
    on public.caddie_memberships(stripe_subscription_id)
    where stripe_subscription_id is not null;
  else
    raise notice 'Skipped caddie_memberships_subscription_unique because duplicate subscription IDs exist or the index already exists. Resolve preflight blockers before launch.';
  end if;
end $$;

-- Stripe event dedupe table. The webhook code claims a row before processing,
-- then marks it processed/failed. Stale processing rows are retryable in code.
create table if not exists public.stripe_webhook_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null,
  event_type text not null,
  stripe_created_at timestamptz,
  processed_at timestamptz,
  processing_status text not null default 'processing',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stripe_webhook_events_status_idx
on public.stripe_webhook_events(processing_status, updated_at desc);

create index if not exists stripe_webhook_events_type_idx
on public.stripe_webhook_events(event_type, stripe_created_at desc);

do $$
begin
  if not exists (
       select 1 from pg_indexes
       where schemaname = 'public'
         and indexname = 'stripe_webhook_events_event_unique'
     )
     and not exists (
       select 1
       from public.stripe_webhook_events
       group by stripe_event_id
       having count(*) > 1
     ) then
    create unique index stripe_webhook_events_event_unique
    on public.stripe_webhook_events(stripe_event_id);
  else
    raise notice 'Skipped stripe_webhook_events_event_unique because duplicate webhook event IDs exist or the index already exists. Resolve preflight blockers before launch.';
  end if;
end $$;

alter table public.payment_products enable row level security;
alter table public.caddie_memberships enable row level security;
alter table public.stripe_webhook_events enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.payment_products to service_role;
grant select, insert, update, delete on public.caddie_memberships to service_role;
grant select, insert, update, delete on public.stripe_webhook_events to service_role;
grant select, insert, update, delete on public.user_entitlements to service_role;
grant select, update on public.app_accounts to service_role;

drop policy if exists "service role can manage payment products" on public.payment_products;
create policy "service role can manage payment products"
on public.payment_products
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
