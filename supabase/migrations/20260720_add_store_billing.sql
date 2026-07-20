-- Store billing (Google Play + App Store via RevenueCat).
--
-- Store purchases land in user_entitlements rather than caddie_memberships.
-- readPaidAccess already filters entitlements on product_key + expires_at without
-- reading any Stripe column, so a store row lights up access with no change to
-- that query. caddie_memberships stays Stripe-only: its whole renewal model is
-- driven by Stripe webhooks and stripe_subscription_id is unique-constrained.
--
-- A renewing store subscription is ONE row whose expires_at is pushed forward on
-- each RENEWAL event, keyed on the store transaction id for idempotency.

alter table if exists public.user_entitlements
  add column if not exists store text;

alter table if exists public.user_entitlements
  add column if not exists store_transaction_id text;

alter table if exists public.user_entitlements
  add column if not exists store_product_id text;

-- RevenueCat's app_user_id. We set this to our account_id at login, so it is the
-- join back to an account when a webhook arrives with no email.
alter table if exists public.user_entitlements
  add column if not exists store_app_user_id text;

alter table if exists public.user_entitlements
  drop constraint if exists user_entitlements_store_check;

alter table if exists public.user_entitlements
  add constraint user_entitlements_store_check
  check (store is null or store in ('play', 'app_store', 'amazon', 'stripe', 'promotional'));

-- Idempotency key for store purchases, mirroring the role stripe_checkout_session_id
-- plays for web. Partial so the existing Stripe rows (all null) stay valid.
create unique index if not exists user_entitlements_store_transaction_unique
on public.user_entitlements (store_transaction_id)
where store_transaction_id is not null;

create index if not exists user_entitlements_store_app_user_idx
on public.user_entitlements (store_app_user_id)
where store_app_user_id is not null;

-- Store SKUs alongside the Stripe price ids. Same product, three billing surfaces.
alter table if exists public.payment_products
  add column if not exists play_product_id text;

alter table if exists public.payment_products
  add column if not exists app_store_product_id text;

-- Webhook replay protection, mirroring stripe_webhook_events.
create table if not exists public.store_webhook_events (
  id uuid primary key default gen_random_uuid(),
  store_event_id text not null unique,
  event_type text not null,
  store text,
  app_user_id text,
  store_event_at timestamptz,
  processed_at timestamptz,
  processing_status text not null default 'processing',
  error_message text,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists store_webhook_events_status_idx
on public.store_webhook_events (processing_status, updated_at desc);

create index if not exists store_webhook_events_type_idx
on public.store_webhook_events (event_type, store_event_at desc);

alter table public.store_webhook_events enable row level security;

grant select, insert, update, delete on public.store_webhook_events to service_role;

drop policy if exists "service role can manage store webhook events" on public.store_webhook_events;
create policy "service role can manage store webhook events"
on public.store_webhook_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- Store-billed equivalents of the existing web products. Kept as distinct product
-- keys so paymentState can report where access came from, and so admin tooling can
-- tell a Play subscriber apart from a Stripe one without joining another table.
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
  ('store_membership', 'membership', 'Monthly Membership', 'Full access with monthly renewal, billed by the app store. Cancel anytime.', 'Monthly', 720, 'monthly', true, 'blue', 30),
  ('store_month_pass', 'month_pass', 'One Month Pass', 'One payment for 30 days full access, billed by the app store. No automatic renewal.', 'One month', 720, 'one_time', true, 'green', 40)
on conflict (product_key) do update set
  product_kind = excluded.product_kind,
  name = excluded.name,
  description = excluded.description,
  duration_hours = excluded.duration_hours,
  billing_schedule = excluded.billing_schedule,
  colour = excluded.colour,
  sort_order = excluded.sort_order,
  updated_at = now();
