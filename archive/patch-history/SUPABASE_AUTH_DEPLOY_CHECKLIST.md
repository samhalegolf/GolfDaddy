# Clarity Caddie Supabase Auth Deploy Checklist

## What is already built in this package

- Supabase Auth signup/login functions.
- Supabase-backed account/profile upsert.
- Entitlement check stays locked unless Supabase confirms active access.
- Email alert helper for Supabase/payment failures.
- Netlify redirects for all API functions, including Auth and diagnostics.
- Optional protected `/api/admin-diagnostics` endpoint.

## Netlify environment variables to add

Required Supabase:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

Required for alerts:

```text
RESEND_API_KEY
CLARITY_EMAIL_FROM
CLARITY_ALERT_EMAIL
```

Recommended for protected backend diagnostics:

```text
CLARITY_ADMIN_DIAGNOSTICS_TOKEN
```

Payments:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_DAY_PASS
STRIPE_PRICE_ROUND_PASS
APP_URL
```

Optional pass duration controls:

```text
CLARITY_DAY_PASS_HOURS=24
CLARITY_ROUND_PASS_HOURS=24
CLARITY_ALERT_THROTTLE_MINUTES=45
```

## Supabase steps

1. Open Supabase dashboard.
2. Go to SQL Editor.
3. Run `supabase/payment-schema.sql` from this package.
4. Go to Authentication settings.
5. Confirm Email provider is enabled.
6. For simplest early testing, allow email/password signup and either disable email confirmation or keep the current server function creating confirmed users.

## Verification SQL

```sql
select account_id, auth_user_id, email, name, role, created_at, updated_at
from public.app_accounts
order by created_at desc
limit 20;

select profile_id, auth_user_id, account_id, email, name, permission, updated_at
from public.app_profiles
order by updated_at desc
limit 20;

select *
from public.app_sync_events
order by created_at desc
limit 20;

select *
from public.user_entitlements
order by created_at desc
limit 20;

select stripe_event_id, event_type, processed_at, created_at
from public.payment_events
order by created_at desc
limit 20;
```

## Diagnostics endpoint

After adding `CLARITY_ADMIN_DIAGNOSTICS_TOKEN`, you can check the backend with:

```shell
curl -H "Authorization: Bearer YOUR_TOKEN" "https://YOUR_SITE_URL/api/admin-diagnostics?email=test@example.com"
```

If no email is supplied, it returns recent sync/payment events only.

## Expected fresh signup result

A successful fresh signup should create:

- one row in `auth.users`
- one row in `public.app_accounts` with `auth_user_id`
- one row in `public.app_profiles` with `auth_user_id`
- one `public.app_sync_events` row with `event_type = supabase_auth_signup`

