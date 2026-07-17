# Clarity Caddy — Supabase Source-of-Truth Upgrade

Date: 2026-06-16

## What changed

This build removes the fake/placeholder cloud-sync behaviour for the important parts of the app.

For accounts, profiles, payments, passes, memberships, and access checks, Supabase is now treated as the source of truth. Local browser storage is only used as a cache/outbox and no longer proves that an account or paid entitlement is real.

## Added files

- `scripts/clarity-cloud-sync.js`
  - Implements the previously missing `window.ClarityCloudSync` object.
  - Confirms new/login accounts through `/api/account-sync`.
  - Tracks sync state: `synced`, `checking`, `pending`, `blocked`, `signed_out`.
  - Shows a visible warning badge when Supabase confirmation fails or items are pending.
  - Holds failed sync payloads in a local outbox and retries when online.
  - Can discard a local account if signup fails before Supabase confirms it.

- `functions/account-sync.js`
  - Netlify function that writes/updates account and profile records in Supabase.
  - Blocks account creation if Supabase is not configured.
  - Checks duplicate email addresses against Supabase.
  - Writes sync audit events.
  - Provides diagnostics for current account/profile state.

- `functions/alert-utils.js`
  - Sends backend alert emails through Resend.
  - Uses Netlify Blobs to throttle repeated alert emails.
  - Alert recipient comes from `CLARITY_ALERT_EMAIL`, falling back to `CLARITY_DEBUG_REPORT_TO` or `SUPPORT_ALERT_EMAIL`.

## Updated files

- `index.html`
  - Loads `scripts/clarity-cloud-sync.js` before payments/settings code.
  - Signup is now async and must receive Supabase confirmation before the UI says the account is created.
  - If signup creates a local browser account but Supabase rejects/fails, the local account is discarded.
  - Login now checks Supabase before the app treats the user as properly logged in.
  - If login sync fails, the app logs the local session back out instead of pretending everything worked.

- `scripts/clarity-payments.js`
  - Payment access no longer stays unlocked from stale cached entitlement data after a Supabase check fails.
  - A failed entitlement check now returns `Supabase check failed` and keeps paid access locked until Supabase confirms an active entitlement.

- `functions/payment-entitlement.js`
  - Missing/broken Supabase config now returns an error instead of a quiet “not configured” success-style response.
  - Sends admin alert email when payment entitlement checking cannot reach/write Supabase.

- `functions/stripe-webhook.js`
  - Sends admin alert email if Stripe webhook processing cannot write to Supabase.

- `supabase/payment-schema.sql`
  - Adds source-of-truth app tables:
    - `app_accounts`
    - `app_profiles`
    - `app_sync_events`
  - Keeps existing payment tables:
    - `user_entitlements`
    - `payment_events`

## Supabase tables to create/update

Run the full `supabase/payment-schema.sql` in Supabase SQL editor.

The important new checks are:

```sql
select * from public.app_accounts order by created_at desc limit 20;
select * from public.app_profiles order by created_at desc limit 20;
select * from public.app_sync_events order by created_at desc limit 20;
select * from public.user_entitlements order by created_at desc limit 20;
select * from public.payment_events order by created_at desc limit 20;
```

## Required Netlify environment variables

Minimum required:

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RESEND_API_KEY=
CLARITY_EMAIL_FROM=
CLARITY_ALERT_EMAIL=
```

Payment variables still required for paid passes:

```text
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_DAY_PASS=
STRIPE_PRICE_ROUND_PASS=
CLARITY_DAY_PASS_HOURS=24
CLARITY_ROUND_PASS_HOURS=24
APP_URL=https://clarity-caddie.netlify.app
```

Optional alert throttle:

```text
CLARITY_ALERT_THROTTLE_MINUTES=45
```

## Behaviour after this build

### Signup

```text
Create local account shell
→ POST /api/account-sync
→ Supabase writes app_accounts + app_profiles + app_sync_events
→ only then show success
```

If Supabase fails:

```text
Local account shell is removed
→ user sees an error
→ admin receives alert email if Resend + alert email are configured
```

### Login

```text
Local password check
→ POST /api/account-sync as login_check/upsert
→ only then app treats login as confirmed
```

If Supabase fails:

```text
Local session is logged back out
→ user sees error
→ warning badge appears if relevant
```

### Payments

```text
Stripe Checkout
→ Stripe webhook
→ Supabase user_entitlements row
→ app checks /api/payment-entitlement
→ paid access unlocks only from live Supabase confirmation
```

If Supabase check fails:

```text
Paid access remains locked
→ user sees Supabase check failed
→ admin receives alert email
```

## Important note

This is a major reliability step, but it is still using the app’s existing local password system. A later hardening step should move login fully onto Supabase Auth so passwords are never managed by the app/browser account layer.
