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
