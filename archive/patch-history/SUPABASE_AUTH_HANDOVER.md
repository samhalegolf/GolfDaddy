# Clarity Caddy — Supabase Auth Source of Truth Build

This build moves the account login/signup path onto Supabase Auth.

## What changed

- Added Netlify Auth functions:
  - `/api/auth-signup`
  - `/api/auth-login`
  - `/api/auth-update-account`
- Added browser wrapper:
  - `scripts/clarity-supabase-auth.js`
- Signup now creates a real Supabase Auth user first.
- Login now validates against Supabase Auth password login first.
- Local password hashes are no longer trusted.
- Local account/profile storage remains only as a browser display cache after Supabase Auth succeeds.
- `app_accounts` and `app_profiles` now store `auth_user_id` linking rows back to `auth.users.id`.
- Account update now updates Supabase Auth, then refreshes the local display cache.

## Required Netlify environment variables

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
CLARITY_EMAIL_FROM
CLARITY_ALERT_EMAIL
```

Payment variables are still required for Stripe passes:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_DAY_PASS
STRIPE_PRICE_ROUND_PASS
APP_URL
```

## Supabase SQL to run

Run the updated `supabase/payment-schema.sql`.

New Auth linkage columns:

```sql
alter table if exists public.app_accounts
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

alter table if exists public.app_profiles
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
```

## How to test

1. Clear local browser storage or use a private browser window.
2. Sign up with a new test email and password.
3. Confirm there is a new user in Supabase Auth.
4. Confirm these rows exist:

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
```

5. Log out.
6. Log in from a clean/private browser using the same email/password.
7. The app should rebuild its local display cache from Supabase Auth + Supabase account/profile rows.

## Important behaviour

- No Supabase Auth confirmation = no real login.
- No Supabase Auth signup = no real account.
- Local storage is now only a cache after backend confirmation.
- Payment entitlement checks still come from Supabase, not local cache.

## Known migration note

Existing local-only prototype accounts will not automatically have Supabase Auth passwords. Those users need to be recreated in Supabase Auth or migrated with a temporary password/reset flow.
