# App Store rejection 8f5517b3 (second pass, 23 Aug) — what changed

Build 1.0 (757) carried the 19 August fixes and was rejected again, on five
issues. Three were code and are fixed in the working tree; two are App Store
Connect / Netlify tasks listed at the bottom, which only the account holder can
do. Companion doc: APP_REVIEW_FIXES_2026-08-19.md.

## Why the subscribe button "did not respond" — 2.1(b)

Not a StoreKit bug. The live `/api/store-config` returns

    "apiKeys": { "android": "goog_...", "ios": "" }

`REVENUECAT_IOS_PUBLIC_KEY` was never set in Netlify. On iOS,
`clarity-store-billing.js loadConfig()` throws "Store billing is not set up for
this platform" before the store sheet can open, surfaced only as a toast the
reviewer evidently never saw. The same failure is why the paywall showed
"Price shown at purchase" instead of a billed amount — the price cache loads
through the same config. **Setting that one env var fixes the dead button and
the missing prices.** No code change was needed for this issue itself.

## 5.1.1(v) again — the wall the August 19 fix missed

The rangefinder fixes held. What was still walled was the PURCHASE:

- the paywall lives in Player Settings, and `clarity-player-settings.js open()`
  refused signed-out users ("Sign in first" + the sign-in panel);
- both `buy()` paths (`clarity-payments.js`, `clarity-store-billing.js`)
  refused signed-out users the same way.

So the only route to a subscription ran through registration — which is the
rejection, since a purchase is not an account-based feature.

### What it does now: anonymous purchase

- `clarity-store-billing.js buy()` no longer requires an account. A signed-out
  purchase runs under RevenueCat's anonymous ID, and the entitlement is honoured
  from `customerInfo.entitlements` — the store's own validated answer, cached in
  `clarity:store-entitlement:v1` and refreshed from the store on every boot (so
  expiry and refunds catch up). When the player later signs in, `identify()` →
  `logIn()` transfers the anonymous purchase to their account and the webhook
  writes the backend entitlement exactly as before. Backend grants still come
  only from the webhook; the device entitlement is the record only while there
  is no account to hold one.
- `ClarityPayments.hasActiveAccess()` folds in
  `ClarityStoreBilling.entitlementActive()`, so a signed-out purchaser is a
  member on this device: bag distances, bubble adoption, everything
  `requireAccess()` guards.
- `ClarityPayments.openPaywall()` is the one way to put the paywall on screen.
  `showSection("payments")` alone only toggled sections inside the settings
  panel — if the panel was closed (for a guest it always was) the tap did
  nothing visible. openPaywall opens the panel first, and
  `gdOpenPlayerSettingsPanel({section:"payments"})` now admits guests for that
  section only; settings proper still require an account.
- Restore Purchases also works signed out — the store account owns the
  purchase, not the Clarity account.
- Sign-out drops RevenueCat back to a fresh anonymous user and clears the
  device entitlement, so a shared iPad does not keep the departed account's
  membership. Wired to `clarity:session-changed`.

Deliberately NOT opened: keeping score, the round record, resume, shot/course/
practice data. Those save to an account and are account-based in exactly the
sense guideline 5.1.1 permits gating.

## 3.1.2(c) — billed amount and subscription terms in the flow

The price was a 12px pill at the bottom of the card while the product name sat
at 17px. Now the billed amount is the card's largest element (24px, orange, its
own row under the title) with the period beside it ("$X.XX / month",
"$X.XX one-time"), and every other pricing detail is subordinate small print.
`renderStoreSubscriptionTerms()` adds the written terms Apple wants inside the
flow on store builds: title, 1-month length, billed price, auto-renewal
behaviour, and how to cancel. Terms/Privacy links were already present
(clarity-legal-links.js) and stay.

Web cards keep their Stripe price labels untouched — the "/ month" suffix is
only added to bare store prices.

### One trap found while wiring RevenueCat

`/api/store-config` reports `entitlementId: "membership"`, but the entitlement in
the RevenueCat dashboard is identified as "Clarity Golf Member". A device
entitlement lookup keyed on an exact match would therefore have found nothing,
and a paid purchase would have granted no access on a signed-out device -
silently, since the store call itself succeeds.

`saveEntitlementFromCustomerInfo()` now prefers the configured id and falls back
to ANY active entitlement. Clarity has one access tier, so "an entitlement is
active" and "has full access" are the same statement. If a second tier is ever
introduced this has to become an exact check again, and the comment there says
so. Setting `REVENUECAT_ENTITLEMENT_ID` in Netlify to the real identifier is
still worth doing for precision, but is no longer load-bearing.

## Tests

- `dev/store-billing-client.test.js` gained a signed-out pass: a guest purchase
  must complete, run anonymously (no made-up appUserID), grant on-device access,
  skip the doomed backend poll, and transfer on the next sign-in. Run locally —
  the browser half needs Chrome:  `node dev/store-billing-client.test.js`
- Also run: `node dev/auth-route-boot-release.test.js` and
  `node dev/payment-checkout-client.test.js` (both pass on the static half;
  checkout-client confirms the web Stripe path is untouched).

## Before resubmitting — Sam's checklist

**Netlify (fixes the dead subscribe):**
1. Site settings → Environment variables → add `REVENUECAT_IOS_PUBLIC_KEY` =
   the `appl_...` key from RevenueCat → Project settings → API keys (the iOS
   app's public SDK key). Redeploy so `/api/store-config` serves it. Verify:
   `curl https://caddy.claritygolf.app/api/store-config` shows a non-empty ios key.

**RevenueCat sanity check:**
2. The iOS app in RevenueCat must have both products attached
   (`clarity_membership_monthly`, `clarity_month_pass`), the `membership`
   entitlement mapped to both, and an offering (current) containing them.

**App Store Connect — the 2.1(b) "not submitted" issue:**
3. Both In-App Purchases must be attached to the app version and submitted WITH
   the new binary: App Store Connect → your app → the 1.0 version page →
   In-App Purchases and Subscriptions section → add both products.
4. Each IAP needs complete metadata: display name, description, and the
   **App Review screenshot** (any screenshot of the paywall screen at required
   resolution — take it from the iPad simulator). "Missing Metadata" state is
   what blocks submission.
5. Paid Apps Agreement: Business → confirm status is Active.

**App Store Connect — the 3.1.2(c) metadata issue:**
6. Privacy Policy field must contain a working link
   (https://caddy.claritygolf.app/privacy.html).
7. Terms of Use: if using Apple's standard EULA, paste this line at the end of
   the App Description: "Terms of Use (EULA):
   https://www.apple.com/legal/internet-services/itunes/dev/stdeula/". If using
   your own, upload it in the EULA field instead and link terms.html.

**Build + device walk:**
8. `npm run native:sync`, bump the build number, archive.
9. On device, signed out and cold: open the app → Play → rangefinder works →
   find Access & Membership (or trip a bag edit) → paywall opens WITHOUT
   sign-in → real prices show → subscribe with a sandbox Apple ID → access
   activates on-device → then create an account and confirm the membership
   follows it.

**The reply to Apple** (they asked for a screen recording for 3.1.2(c)):
10. Record the flow from step 9 on the iPad simulator or device and attach it.
    Say plainly: users can now purchase without registering; the subscription's
    billed amount, length, and terms are shown in the purchase flow; the EULA
    link is in the App Description; the privacy policy link is in the Privacy
    Policy field; both IAPs are attached and submitted with this binary; and
    the unresponsive purchase was a server configuration fault that has been
    corrected.
