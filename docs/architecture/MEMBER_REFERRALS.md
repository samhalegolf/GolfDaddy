# Clarity Caddy Member Referrals

## Ownership

Referrals are a private authenticated member benefit. They must not appear in public pricing, public signup, homepage copy, or non-referral marketing. Public upgrade paths remain Free, 30-Day Pass, and Monthly Membership.

The server owns all referral decisions. The UI can request actions and display state, but it does not decide eligibility, invite validity, free-month dates, conversion, or reward application.

## Data Model

- `referral_invitations` owns private single-use invitation links. Public URLs contain only an unguessable token; the database stores the token hash.
- `user_entitlements` remains the shared access projection. Referral free months use `product_key = referral_membership`, `entitlement_reason = referral_free_month`, `source_type = referral`, `source_referral_id`, `non_renewing = true`, and `referral_eligible = false`.
- Admin-comped Membership uses `product_key = admin_comped_membership`, `entitlement_reason = admin_comped_membership`, and explicit `referral_eligible`.
- `referral_reward_ledger` records earned inviter rewards and how each was paid out, including `qualifying_source` (`stripe`, `play`, `app_store`) and the `reward_entitlement_id` it granted. A referral can earn no more than one reward.
- The inviter's earned month uses `product_key = referral_reward_membership`, `entitlement_reason = referral_reward_month`, `source_type = referral_reward`. Keeping it distinct from `referral_membership` is what lets the app tell "given a month" from "earned a month".
- `referral_analytics_events` stores privacy-safe lifecycle events without raw tokens or payment details.

## Lifecycle

Invitation states are `open`, `opened`, `accepted`, `free_month_active`, `free_month_ended`, `converted`, `reward_earned`, `revoked`, and `invalid`.

Members can have up to 5 open or opened invitations at one time by default. Accepted, expired, invalid, or revoked invitations release a slot. This is a concurrent limit, not a lifetime cap.

## Eligibility

Eligible inviters are active paid Monthly Members and active admin-comped Membership users with `referral_eligible = true`. Month Pass users and referral-free-month invitees cannot create referrals. Referral recipients only become eligible later if they become paid Monthly Members or receive an independent admin-comped Membership.

## Invitee Access

Accepting a valid private referral creates exactly 30 days of non-renewing Membership-level access through `user_entitlements`. No Stripe customer, card, or payment method is required to activate it.

## Billing And Reward Payout

If an invitee starts Monthly Membership checkout during the referral month, Checkout receives `subscription_data[trial_end]` equal to the referral expiry. This lets Checkout collect payment details without charging before the free access ends.

Inviter rewards are paid as entitlement days, not Stripe credits. When the referred account’s first paid Monthly Membership charge succeeds — a Stripe invoice, an App Store purchase, or a Play purchase — the ledger creates one reward and grants the inviter 30 days of `referral_reward_membership` in `user_entitlements`, stacked on the end of their existing access. Credits were replaced in July 2026 because they required an active Stripe customer, so an inviter who pays through a store could never be paid out.

The reward is a month of access, not a skipped payment. For an inviter whose subscription is still auto-renewing — Stripe or store — the granted month sits behind renewals that keep pushing their expiry out, so it is banked rather than felt: it carries their access when the paid subscription ends. Member-facing copy must say that and not promise a free month off the next bill. Making the next payment genuinely free needs a per-surface mechanism (Stripe balance credit, App Store renewal-date extension, Play deferral) and is not built.

## Where Referrals Live

Settings → Invite a Golfer is the referral home and the single source of truth for a member's invites: the share action, the invite list, and the open-invite count against the cap. The row exists only while the server says the member may invite, so an ineligible player never sees a teaser for a private benefit.

Access & Membership shows referrals as status only — the invitee's own free month, and an inviter's earned reward months — plus a way through to Invite a Golfer. It must not become the referral home again: billing is where a member goes when something is wrong with their payment, not where they go to invite a friend.

Invites are shared as a link (`navigator.share`, falling back to copying). The optional name is a private label for the inviter's own list and is never shown to the friend; email is a secondary path behind a disclosure.

## Idempotency

Stripe webhook replay is still gated by `stripe_webhook_events`, and store deliveries by `store_transaction_id`. Referral rewards also use a unique ledger idempotency key and a unique earned-reward-per-referral constraint, and the granted reward entitlement is unique on `source_referral_id`, so a replayed delivery merges into the same row instead of granting a second month.

## Abuse And Reversals

The service rejects self-referrals, consumed tokens, ineligible existing accounts, duplicate claims, and accounts with prior paid/promotional access. Email alias matches are risk-flagged where detectable.

If a qualifying referred payment is refunded or disputed before the inviter reward is applied, the reward is reversed. If already applied, the ledger records the issue for manual review instead of making surprising billing changes.

## Configuration

Environment configuration:

- `CLARITY_REFERRALS_ENABLED`
- `CLARITY_REFERRAL_FREE_ACCESS_DAYS`, default `30`
- `CLARITY_REFERRAL_INVITE_EXPIRY_DAYS`, default `30`
- `CLARITY_REFERRAL_MAX_OUTSTANDING_INVITES`, default `5`
- `CLARITY_REFERRAL_MAX_UNAPPLIED_REWARDS`, default `12`
- `CLARITY_REFERRAL_REFUND_REVIEW_DAYS`
- `CLARITY_REFERRAL_URL_BASE`
- `CLARITY_REFERRAL_HASH_SALT`

## Known Limitations

Invitation email currently opens a local `mailto:` draft from the app. A server-delivered invitation email can be added later using the existing email provider.

A reward month granted to a member whose subscription is still renewing is banked behind that subscription rather than skipping a payment. See Billing And Reward Payout.

The current app does not persist Stripe payment method fingerprints, so shared-card detection is not enforced in this branch. The referral service blocks prior access, self-referrals, duplicate account claims, and reused Stripe customer/account evidence where the existing model exposes it, then uses risk flags instead of IP-only blocking.
