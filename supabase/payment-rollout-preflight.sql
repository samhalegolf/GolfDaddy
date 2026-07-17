-- ============================================================================
-- Clarity Caddy payment rollout preflight (read-only)
-- ============================================================================
-- Run this before supabase/migrations/20260713_add_month_pass_memberships.sql.
-- This file is intentionally read-only: it only SELECTs metadata/data and emits
-- NOTICE output from anonymous blocks.
--
-- Treat these as migration blockers before production rollout:
-- - duplicate Stripe Customer IDs in app_accounts
-- - duplicate Stripe Subscription IDs in caddie_memberships or entitlements
-- - duplicate Stripe webhook event IDs
-- - duplicate payment product keys
-- - membership rows without a user_id
-- - active paid entitlement rows with neither user_id nor account_email
-- ============================================================================

select
  'existing_payment_tables' as report,
  table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'app_accounts',
    'user_entitlements',
    'payment_events',
    'payment_products',
    'caddie_memberships',
    'stripe_webhook_events'
  )
order by table_name;

select
  'payment_products_product_kind_default' as report,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'payment_products'
  and column_name = 'product_kind';

select
  'payment_products_product_kind_checks' as report,
  conname,
  pg_get_constraintdef(c.oid) as definition,
  c.convalidated as validated
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'payment_products'
  and c.contype = 'c'
order by conname;

select
  'rollout_columns_present' as report,
  table_name,
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'app_accounts' and column_name in ('stripe_customer_id', 'auth_user_id')) or
    (table_name = 'user_entitlements' and column_name in ('product_key', 'profile_id', 'stripe_customer_id', 'stripe_checkout_session_id', 'stripe_payment_intent_id', 'stripe_subscription_id', 'usage_count', 'metadata')) or
    (table_name = 'payment_products' and column_name in ('product_key', 'product_kind', 'stripe_price_id', 'billing_schedule', 'active')) or
    (table_name = 'caddie_memberships' and column_name in ('user_id', 'stripe_customer_id', 'stripe_subscription_id', 'status', 'access_until', 'grace_until', 'first_payment_failed_at', 'cancel_at_period_end', 'last_paid_invoice_id', 'last_stripe_event_created_at')) or
    (table_name = 'stripe_webhook_events' and column_name in ('stripe_event_id', 'processing_status', 'processed_at', 'error_message', 'updated_at'))
  )
order by table_name, column_name;

do $$
declare
  result jsonb;
begin
  if to_regclass('public.payment_products') is null then
    raise notice 'payment_products: missing. Migration will create it.';
  else
    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select product_kind, count(*) as row_count
        from public.payment_products
        group by product_kind
        order by product_kind
      ) t
    $q$ into result;
    raise notice 'existing product kinds: %', result;

    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select product_key, count(*) as row_count
        from public.payment_products
        group by product_key
        having count(*) > 1
        order by product_key
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - duplicate payment product keys: %', result;

    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select product_key, product_kind, active, stripe_price_id, billing_schedule, updated_at
        from public.payment_products
        where product_key in ('month_pass', 'monthly_membership')
        order by product_key
      ) t
    $q$ into result;
    raise notice 'existing Month Pass / Membership products: %', result;
  end if;

  if to_regclass('public.app_accounts') is null then
    raise notice 'app_accounts: missing. STOP: account identity table must exist before payment rollout.';
  else
    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select stripe_customer_id, count(*) as row_count, array_agg(account_id order by account_id) as account_ids
        from public.app_accounts
        where stripe_customer_id is not null
        group by stripe_customer_id
        having count(*) > 1
        order by row_count desc, stripe_customer_id
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - duplicate Stripe Customer IDs: %', result;
  end if;

  if to_regclass('public.caddie_memberships') is null then
    raise notice 'caddie_memberships: missing. Migration will create it.';
  else
    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select stripe_subscription_id, count(*) as row_count, array_agg(user_id order by user_id) as user_ids
        from public.caddie_memberships
        where stripe_subscription_id is not null
        group by stripe_subscription_id
        having count(*) > 1
        order by row_count desc, stripe_subscription_id
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - duplicate Membership Stripe Subscription IDs: %', result;

    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select user_id, count(*) as current_rows
        from public.caddie_memberships
        where status in ('active', 'trialing', 'past_due', 'paused', 'incomplete')
          and (
            access_until is null
            or access_until > now()
            or grace_until > now()
          )
        group by user_id
        having count(*) > 1
        order by current_rows desc, user_id
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - multiple current membership rows for one user: %', result;

    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select id, user_id, account_email, stripe_customer_id, stripe_subscription_id, status
        from public.caddie_memberships
        where coalesce(nullif(user_id, ''), '') = ''
        order by updated_at desc nulls last
        limit 25
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - membership rows with null/blank user_id: %', result;
  end if;

  if to_regclass('public.user_entitlements') is null then
    raise notice 'user_entitlements: missing. STOP: existing entitlement table must exist before payment rollout.';
  else
    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select stripe_subscription_id, count(*) as row_count, array_agg(id order by id) as entitlement_ids
        from public.user_entitlements
        where stripe_subscription_id is not null
        group by stripe_subscription_id
        having count(*) > 1
        order by row_count desc, stripe_subscription_id
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - duplicate entitlement Stripe Subscription IDs: %', result;

    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select stripe_checkout_session_id, count(*) as row_count, array_agg(id order by id) as entitlement_ids
        from public.user_entitlements
        where stripe_checkout_session_id is not null
        group by stripe_checkout_session_id
        having count(*) > 1
        order by row_count desc, stripe_checkout_session_id
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - duplicate Checkout Session IDs: %', result;

    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select id, user_id, account_email, entitlement_type, product_key, status, expires_at
        from public.user_entitlements
        where status = 'active'
          and coalesce(nullif(user_id, ''), nullif(account_email, ''), '') = ''
        order by created_at desc nulls last
        limit 25
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - active entitlements without user_id or account_email: %', result;
  end if;

  if to_regclass('public.stripe_webhook_events') is null then
    raise notice 'stripe_webhook_events: missing. Migration will create it.';
  else
    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select stripe_event_id, count(*) as row_count
        from public.stripe_webhook_events
        group by stripe_event_id
        having count(*) > 1
        order by row_count desc, stripe_event_id
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - duplicate stripe_webhook_events IDs: %', result;
  end if;

  if to_regclass('public.payment_events') is null then
    raise notice 'payment_events: missing. Existing legacy payment event history table is absent.';
  else
    execute $q$
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      from (
        select stripe_event_id, count(*) as row_count
        from public.payment_events
        group by stripe_event_id
        having count(*) > 1
        order by row_count desc, stripe_event_id
      ) t
    $q$ into result;
    raise notice 'BLOCKER if not empty - duplicate legacy payment_events IDs: %', result;
  end if;
end $$;
