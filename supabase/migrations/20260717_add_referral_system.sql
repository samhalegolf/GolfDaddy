-- ============================================================================
-- Clarity Caddy referral architecture
-- ============================================================================
-- Additive only. Referral free access projects through user_entitlements, while
-- inviter rewards are tracked in a ledger and applied through Stripe billing.

create extension if not exists pgcrypto;

alter table if exists public.user_entitlements
  add column if not exists source_type text;

alter table if exists public.user_entitlements
  add column if not exists source_referral_id uuid;

alter table if exists public.user_entitlements
  add column if not exists non_renewing boolean not null default false;

alter table if exists public.user_entitlements
  add column if not exists scheduled_paid_start_at timestamptz;

alter table if exists public.user_entitlements
  add column if not exists entitlement_reason text;

alter table if exists public.user_entitlements
  add column if not exists referral_eligible boolean not null default false;

create index if not exists user_entitlements_source_referral_idx
on public.user_entitlements(source_type, source_referral_id)
where source_referral_id is not null;

do $$
begin
  if to_regclass('public.user_entitlements') is not null
     and not exists (
       select 1 from pg_indexes
       where schemaname = 'public'
         and indexname = 'user_entitlements_referral_source_unique'
     )
     and not exists (
       select 1
       from public.user_entitlements
       where source_type = 'referral'
         and source_referral_id is not null
       group by source_referral_id
       having count(*) > 1
     ) then
    create unique index user_entitlements_referral_source_unique
    on public.user_entitlements(source_referral_id)
    where source_type = 'referral' and source_referral_id is not null;
  elsif to_regclass('public.user_entitlements') is not null then
    raise notice 'Skipped user_entitlements_referral_source_unique because duplicate referral sources exist or the index already exists.';
  end if;
end $$;

create table if not exists public.referral_invitations (
  id uuid primary key default gen_random_uuid(),
  inviter_account_id text not null,
  inviter_account_email text,
  token_hash text not null unique,
  status text not null default 'open',
  friend_name text,
  invitee_email text,
  invitee_account_id text,
  invitee_account_email text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  opened_at timestamptz,
  accepted_at timestamptz,
  free_access_started_at timestamptz,
  free_access_ends_at timestamptz,
  planned_paid_start_at timestamptz,
  paid_membership_started_at timestamptz,
  first_paid_invoice_at timestamptz,
  reward_earned_at timestamptz,
  revoked_at timestamptz,
  invalid_reason text,
  revoked_reason text,
  first_paid_invoice_id text,
  stripe_subscription_id text,
  stripe_customer_id text,
  risk_flags jsonb not null default '[]'::jsonb,
  attribution_metadata jsonb not null default '{}'::jsonb,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_by_ip_hash text,
  opened_by_ip_hash text,
  accepted_by_ip_hash text,
  updated_at timestamptz not null default now(),
  constraint referral_invitations_status_check check (
    status in (
      'open',
      'opened',
      'accepted',
      'free_month_active',
      'free_month_ended',
      'converted',
      'reward_earned',
      'revoked',
      'invalid'
    )
  )
);

create index if not exists referral_invitations_inviter_idx
on public.referral_invitations(inviter_account_id, created_at desc);

create index if not exists referral_invitations_invitee_idx
on public.referral_invitations(invitee_account_id)
where invitee_account_id is not null;

create index if not exists referral_invitations_status_idx
on public.referral_invitations(status, expires_at, updated_at desc);

create index if not exists referral_invitations_first_paid_invoice_idx
on public.referral_invitations(first_paid_invoice_id)
where first_paid_invoice_id is not null;

do $$
begin
  if not exists (
       select 1 from pg_indexes
       where schemaname = 'public'
         and indexname = 'referral_invitations_invitee_claim_unique'
     )
     and not exists (
       select 1
       from public.referral_invitations
       where invitee_account_id is not null
         and status in ('accepted', 'free_month_active', 'free_month_ended', 'converted', 'reward_earned')
       group by invitee_account_id
       having count(*) > 1
     ) then
    create unique index referral_invitations_invitee_claim_unique
    on public.referral_invitations(invitee_account_id)
    where invitee_account_id is not null
      and status in ('accepted', 'free_month_active', 'free_month_ended', 'converted', 'reward_earned');
  else
    raise notice 'Skipped referral_invitations_invitee_claim_unique because duplicate invitee claims exist or the index already exists.';
  end if;
end $$;

create table if not exists public.referral_reward_ledger (
  id uuid primary key default gen_random_uuid(),
  inviter_account_id text not null,
  inviter_account_email text,
  referral_id uuid not null references public.referral_invitations(id) on delete restrict,
  reward_type text not null default 'free_membership_month',
  reward_quantity integer not null default 1,
  reward_duration_days integer not null default 30,
  status text not null default 'pending',
  earned_at timestamptz,
  scheduled_for timestamptz,
  applied_at timestamptz,
  reversed_at timestamptz,
  expired_at timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_invoice_id text,
  qualifying_stripe_invoice_id text,
  qualifying_stripe_subscription_id text,
  stripe_customer_balance_transaction_id text,
  stripe_reversal_balance_transaction_id text,
  credit_amount integer,
  credit_currency text,
  idempotency_key text not null,
  reversal_reason text,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referral_reward_ledger_status_check check (
    status in ('pending', 'available', 'scheduled', 'applied', 'reversed', 'expired')
  ),
  constraint referral_reward_ledger_type_check check (
    reward_type in ('free_membership_month')
  )
);

create index if not exists referral_reward_inviter_idx
on public.referral_reward_ledger(inviter_account_id, status, created_at desc);

create index if not exists referral_reward_referral_idx
on public.referral_reward_ledger(referral_id);

create unique index if not exists referral_reward_idempotency_unique
on public.referral_reward_ledger(idempotency_key);

do $$
begin
  if not exists (
       select 1 from pg_indexes
       where schemaname = 'public'
         and indexname = 'referral_reward_one_earned_per_referral'
     ) then
    create unique index referral_reward_one_earned_per_referral
    on public.referral_reward_ledger(referral_id)
    where reward_type = 'free_membership_month' and earned_at is not null;
  end if;
end $$;

create table if not exists public.referral_analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  referral_id uuid,
  account_id text,
  actor_account_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists referral_analytics_events_type_idx
on public.referral_analytics_events(event_type, created_at desc);

create index if not exists referral_analytics_events_referral_idx
on public.referral_analytics_events(referral_id, created_at desc);

alter table public.referral_invitations enable row level security;
alter table public.referral_reward_ledger enable row level security;
alter table public.referral_analytics_events enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.referral_invitations to service_role;
grant select, insert, update, delete on public.referral_reward_ledger to service_role;
grant select, insert, update, delete on public.referral_analytics_events to service_role;

drop policy if exists "service role can manage referral invitations" on public.referral_invitations;
create policy "service role can manage referral invitations"
on public.referral_invitations
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage referral reward ledger" on public.referral_reward_ledger;
create policy "service role can manage referral reward ledger"
on public.referral_reward_ledger
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage referral analytics" on public.referral_analytics_events;
create policy "service role can manage referral analytics"
on public.referral_analytics_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
