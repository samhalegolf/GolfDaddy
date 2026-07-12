# Payment Test-Mode Checklist

Use this checklist in Stripe test mode before any production rollout. Do not paste secret values into this file or commit them.

## 1. Stripe Test Prices

1. In Stripe Dashboard, switch to **Test mode**.
2. Create or identify a one-time Price for **One Month Pass**.
   - Product name: `Clarity Caddie One Month Pass`
   - Pricing model: one-time
   - Copy the test `price_...` ID.
3. Create or identify a recurring Price for **Monthly Membership**.
   - Product name: `Clarity Caddie Monthly Membership`
   - Pricing model: recurring
   - Billing period: monthly
   - Copy the test `price_...` ID.
4. Confirm both IDs start with `price_`. Do not use `prod_...` IDs.

## 2. Local/Test Environment

Set these in a local `.env`/Netlify dev environment, using test-mode values only:

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_MONTH_PASS_PRICE_ID=
STRIPE_MONTHLY_MEMBERSHIP_PRICE_ID=
CLARITY_ALERT_EMAIL=
APP_URL=http://localhost:8888
```

Run the local Netlify functions from the repo root:

```bash
netlify dev
```

## 3. Forward Stripe Test Webhooks

In a second terminal:

```bash
stripe listen --forward-to localhost:8888/api/stripe-webhook
```

Copy the displayed test webhook signing secret into `STRIPE_WEBHOOK_SECRET` for the local session, then restart `netlify dev`.

Select or send these test events:

```text
checkout.session.completed
checkout.session.expired
invoice.paid
invoice.payment_failed
invoice.payment_action_required
invoice.finalization_failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
charge.refunded
payment_intent.payment_failed
```

## 4. Month Pass Checkout

1. Sign into Clarity Caddie with a Supabase Auth test user.
2. Open **Player Settings > Payments & Access**.
3. Confirm the Month Pass card is enabled only when its `price_...` ID is configured.
4. Click **Buy One Month**.
5. Complete Checkout with a Stripe test card.
6. Confirm the webhook inserts one `user_entitlements` row:
   - `product_key = month_pass`
   - `status = active`
   - `stripe_checkout_session_id` is set
   - `stripe_payment_intent_id` is set
   - `expires_at` is 30 days after `starts_at`
7. Replay the same `checkout.session.completed` event from Stripe CLI or Dashboard and confirm no second entitlement is added.
8. Buy a second Month Pass and confirm the second row starts from the later of now or the first pass expiry.

## 5. Membership Checkout

1. Confirm the Membership card is enabled only when its recurring `price_...` ID is configured.
2. Click **Start Membership**.
3. Complete Checkout with a Stripe test card.
4. Confirm `caddie_memberships` contains one row for the user:
   - `status = active` or `trialing`
   - `stripe_customer_id` is set
   - `stripe_subscription_id` is set
   - `current_period_end` and `access_until` are set
   - `grace_until` is null
5. Attempt to start Membership again and confirm the app routes to Membership management instead of creating another Checkout Session.

## 6. Renewal, Failure, Recovery, Cancellation

Use Stripe test clocks where possible.

1. Advance a test clock or trigger `invoice.paid`.
   - Confirm `last_paid_invoice_id` updates.
   - Confirm `access_until` advances.
   - Confirm `grace_until` and `first_payment_failed_at` clear.
2. Trigger `invoice.payment_failed`.
   - Confirm `status = past_due`.
   - Confirm `first_payment_failed_at` is set once.
   - Confirm `grace_until` is seven days after the first failure.
3. Trigger another failure.
   - Confirm the grace window does not restart.
4. Resolve payment and trigger `invoice.paid`.
   - Confirm Membership returns to active.
   - Confirm grace fields clear.
5. Cancel at period end in the Customer Portal.
   - Confirm `cancel_at_period_end = true`.
   - Confirm access remains active until the paid-through period end.
6. Let the subscription delete/end.
   - Confirm `status = canceled`.
   - Confirm Membership access is no longer active after the paid-through end.

## 7. Customer Portal

1. Open **Manage Membership** from the payment panel.
2. Confirm Stripe opens a test Customer Portal session for the signed-in user.
3. Confirm another user's account ID in the request body cannot open that other user's portal; the server should use the authenticated Supabase user instead.

## 8. Supabase Checks After Each Event

Run these checks in Supabase SQL editor or table view:

```sql
select product_key, product_kind, active, stripe_price_id
from public.payment_products
where product_key in ('month_pass', 'monthly_membership');

select user_id, account_email, product_key, status, starts_at, expires_at,
       stripe_checkout_session_id, stripe_payment_intent_id
from public.user_entitlements
where product_key in ('month_pass', 'day_pass', 'round_pass')
order by created_at desc;

select user_id, account_email, stripe_customer_id, stripe_subscription_id,
       status, access_until, grace_until, first_payment_failed_at,
       cancel_at_period_end, current_period_end, last_paid_invoice_id
from public.caddie_memberships
order by updated_at desc;

select stripe_event_id, event_type, processing_status, processed_at, error_message, updated_at
from public.stripe_webhook_events
order by updated_at desc
limit 25;
```

## 9. Automated Coverage

Run local mocked tests:

```bash
npm run test:payments
```

These tests do not hit live Stripe or Supabase. The harness lives at `dev/payment-rollout-tests.js` so it is not copied to the public `dist/scripts` bundle. It covers Checkout modes, server-side identity precedence, duplicate membership blocking, portal account protection, Month Pass grants/extension/idempotency, Membership invoice/failure/grace/recovery/cancellation paths, legacy Day/Round access, and webhook processing-row concurrency.
