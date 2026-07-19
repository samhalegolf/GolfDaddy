-- Referral inviter rewards move from Stripe customer balance credits to
-- entitlement days.
--
-- The credit mechanism only worked for inviters with an active Stripe
-- subscription and a stripe_customer_id. An inviter who pays through Google Play
-- or the App Store has neither, so their reward would sit in the ledger blocked
-- on 'inviter_membership_not_active' forever.
--
-- Granting days in user_entitlements instead works identically no matter how
-- either party pays, keeps the whole reward inside our own ledger, and is never
-- visible to Apple or Google as a discount on a store-billed subscription.

-- Distinct from 'referral_membership', which is the INVITEE's free month. This
-- is the INVITER's earned reward, and keeping them separate means paymentState
-- and admin tooling can tell "given a month" from "earned a month".
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
  ('referral_reward_membership', 'membership', 'Referral Reward Month', 'A free month of Membership earned by inviting a friend who subscribed.', 'One month', 720, 'one_time', true, 'gold', 50)
on conflict (product_key) do update set
  product_kind = excluded.product_kind,
  name = excluded.name,
  description = excluded.description,
  duration_hours = excluded.duration_hours,
  billing_schedule = excluded.billing_schedule,
  colour = excluded.colour,
  sort_order = excluded.sort_order,
  updated_at = now();

-- One reward entitlement per referral. The existing referral index covers
-- source_type = 'referral' (the invitee's free month); this covers the inviter
-- side without colliding with it.
create unique index if not exists user_entitlements_referral_reward_source_unique
on public.user_entitlements (source_referral_id)
where source_type = 'referral_reward' and source_referral_id is not null;

-- Links a ledger row to the entitlement it granted, so a reversal can find it.
alter table if exists public.referral_reward_ledger
  add column if not exists reward_entitlement_id uuid;

-- Records which billing surface the invitee's qualifying purchase came through,
-- so rewards earned from a Play or App Store conversion are auditable alongside
-- the Stripe ones.
alter table if exists public.referral_reward_ledger
  add column if not exists qualifying_source text;

alter table if exists public.referral_reward_ledger
  add column if not exists qualifying_store_transaction_id text;

alter table if exists public.referral_reward_ledger
  drop constraint if exists referral_reward_ledger_qualifying_source_check;

alter table if exists public.referral_reward_ledger
  add constraint referral_reward_ledger_qualifying_source_check
  check (qualifying_source is null or qualifying_source in ('stripe', 'play', 'app_store'));

-- The invitation's converting purchase may now be a store purchase rather than a
-- Stripe invoice.
alter table if exists public.referral_invitations
  add column if not exists conversion_source text;

alter table if exists public.referral_invitations
  add column if not exists first_paid_store_transaction_id text;

create index if not exists referral_invitations_first_paid_store_txn_idx
on public.referral_invitations (first_paid_store_transaction_id)
where first_paid_store_transaction_id is not null;
