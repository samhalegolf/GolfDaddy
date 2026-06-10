# Clarity Access / Paywall Scaffold

This patch adds structure only. Prices are intentionally blank.

## Product model

- Free GPS stays free.
- First Personal Bubble Round can be started without a card.
- Round Pass support exists as a one-time access source.
- Unlimited Premium and Coach entitlements exist as states, but Stripe/product prices are not required yet.
- Admin bypasses all gates during development.

## Client API

The browser exposes:

```js
window.ClarityAccess
```

Important helpers:

```js
ClarityAccess.readState()
ClarityAccess.saveState(state)
ClarityAccess.has("fullBagBubble")
ClarityAccess.canStartPersonalBubbleRound()
ClarityAccess.canUsePracticeAnalysis()
ClarityAccess.canUseVirtualRound()
ClarityAccess.startPersonalBubbleRound({ courseId, courseName })
ClarityAccess.markMeaningfulUse("play_entered")
ClarityAccess.grantRoundPasses(1, "manual test")
ClarityAccess.setEntitlement("premium")
ClarityAccess.createCheckout("round_pass")
```

## Stripe placeholders

Routes added:

```text
/api/create-checkout-session
/api/stripe-webhook
```

Netlify env vars to add later:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_ROUND_PASS
STRIPE_PRICE_UNLIMITED_MONTHLY
STRIPE_PRICE_UNLIMITED_ANNUAL
STRIPE_PRICE_FOUNDER_ANNUAL
STRIPE_PRICE_COACH_MONTHLY
CLARITY_SITE_URL
```

## Product config

Template file:

```text
data/clarity-access-products.template.json
```

This file intentionally leaves `priceDisplay` and `stripePriceId` blank.
