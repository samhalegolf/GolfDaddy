# Clarity Caddy Member Referrals

## Ownership

Referrals are a private authenticated member benefit. They must not appear in public pricing, public signup, homepage copy, or non-referral marketing. Public upgrade paths remain Free, 30-Day Pass, and Monthly Membership.

The server owns all referral decisions. The UI can request actions and display state, but it does not decide eligibility, invite validity, free-month dates, conversion, or reward application.

## Data Model

- `referral_invitations` owns private single-use invitation links. Public URLs contain only an unguessable token; the database stores the token hash.
- `user_entitlements` remains the shared access projection. Referral free months use `product_key = referral_membership`, `entitlement_reason = referral_free_month`, `source_type = referral`, `source_referral_id`, `non_renewing = true`, and `referral_eligible = false`.
- Admin-comped Membership uses `product_key = admin_comped_membership`, `entitlement_reason = admin_comped_membership`, and explicit `referral_eligible`.
- `referral_reward_ledger` records earned inviter rewards and their Stripe action. A referral can earn no more than one reward.
- `referral_analytics_events` stores privacy-safe lifecycle events without raw tokens or payment details.

## Lifecycle

Invitation states are `open`, `opened`, `accepted`, `free_month_active`, `free_month_ended`, `converted`, `reward_earned`, `revoked`, and `invalid`.

Members can have up to 10 open or opened invitations at one time by default. Accepted, expired, invalid, or revoked invitations release a slot. This is a concurrent limit, not a lifetime cap.

## Eligibility

Eligible inviters are active paid Monthly Members and active admin-comped Membership users with `referral_eligible = true`. Month Pass users and referral-free-month invitees cannot create referrals. Referral recipients only become eligible later if they become paid Monthly Members or receive an independent admin-comped Membership.

## Invitee Access

Accepting a valid private referral creates exactly 30 days of non-renewing Membership-level access through `user_entitlements`. No Stripe customer, card, or payment method is required to activate it.

## Stripe Billing

If an invitee starts Monthly Membership checkout during the referral month, Checkout receives `subscription_data[trial_end]` equal to the referral expiry. This lets Checkout collect payment details without charging before the free access ends.

Inviter rewards use Stripe customer balance credits. When the referred account’s first positive paid Monthly Membership invoice succeeds, the ledger creates one available reward, then schedules it by creating a negative customer balance transaction for the inviter’s Stripe Customer. Stripe applies that credit to a future finalized invoice, keeping billing and access coherent with the existing subscription.

## Idempotency

Stripe webhook replay is still gated by `stripe_webhook_events`. Referral rewards also use a unique ledger idempotency key and a unique earned-reward-per-referral constraint. Stripe balance transactions use an `Idempotency-Key` based on the reward ID.

## Abuse And Reversals

The service rejects self-referrals, consumed tokens, ineligible existing accounts, duplicate claims, and accounts with prior paid/promotional access. Email alias matches are risk-flagged where detectable.

If a qualifying referred payment is refunded or disputed before the inviter reward is applied, the reward is reversed. If already applied, the ledger records the issue for manual review instead of making surprising billing changes.

## Configuration

Environment configuration:

- `CLARITY_REFERRALS_ENABLED`
- `CLARITY_REFERRAL_FREE_ACCESS_DAYS`, default `30`
- `CLARITY_REFERRAL_INVITE_EXPIRY_DAYS`, default `30`
- `CLARITY_REFERRAL_MAX_OUTSTANDING_INVITES`, default `10`
- `CLARITY_REFERRAL_MAX_UNAPPLIED_REWARDS`, default `12`
- `CLARITY_REFERRAL_REFUND_REVIEW_DAYS`
- `CLARITY_REFERRAL_URL_BASE`
- `CLARITY_REFERRAL_HASH_SALT`

## Known Limitations

Invitation email currently opens a local `mailto:` draft from the app. A server-delivered invitation email can be added later using the existing email provider.

Customer balance credits apply to the next eligible finalized Stripe invoice for that customer. This is deliberate and ledgered, but Stripe does not let the app pick an arbitrary future invoice for the credit.

The current app does not persist Stripe payment method fingerprints, so shared-card detection is not enforced in this branch. The referral service blocks prior access, self-referrals, duplicate account claims, and reused Stripe customer/account evidence where the existing model exposes it, then uses risk flags instead of IP-only blocking.
