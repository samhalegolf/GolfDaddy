# Clarity Caddie Payment Settings Build

Built: 2026-06-17

## What changed

Added an in-app Admin → Payments & Access settings area.

Safe in-app settings now include:

- Create/edit Day Passes
- Create/edit Round Passes
- Create/edit Memberships
- Create/edit Free Pass templates
- Enable/disable products
- Store Stripe Product IDs and Stripe Price IDs
- Store product names, descriptions, durations, billing schedule labels, colours and price labels
- Issue free passes to an email/account for a period of time
- View connection status for Stripe secret, webhook secret and alert email

Secrets still stay server-side only:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`

## New backend endpoint

`/api/payment-admin`

Actions:

- `seedDefaults`
- `upsertProduct`
- `setProductActive`
- `issueFreePass`

The function checks the requester against `public.app_accounts` and only allows `role = admin` to mutate payment settings.

## New Supabase tables

Run the updated `supabase/payment-schema.sql` again. It is idempotent.

New tables:

- `payment_products`
- `payment_admin_events`

Also updates `user_entitlements` so entitlement types can be product-driven instead of locked to only `day_pass`, `round_pass`, and `subscription`.

## Checkout behaviour

`/api/create-checkout-session` now looks up active products from `payment_products` using `product_key`. It still falls back to legacy env vars for `day_pass` and `round_pass` if the table has not been seeded yet.

Stripe Checkout metadata now includes:

- `product_key`
- `product_kind`
- `product_name`
- `duration_hours`
- `account_id`
- `account_email`

The Stripe webhook uses that metadata to create the matching Supabase `user_entitlements` row.

## Deployment steps

1. Push this build to GitHub.
2. Netlify auto-deploys.
3. Run `supabase/payment-schema.sql` in Supabase SQL Editor.
4. Hard refresh the app.
5. Log in as admin.
6. Open Settings → Payments & Access.
7. Click Seed defaults if product rows are empty.
8. Paste Stripe `price_...` IDs into products.
9. Test checkout.
10. Confirm rows in `payment_events`, `user_entitlements`, and `payment_admin_events`.

## Required environment variables

Already expected:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `CLARITY_EMAIL_FROM`
- `CLARITY_ALERT_EMAIL`
- `APP_URL` or `CLARITY_SITE_URL`
