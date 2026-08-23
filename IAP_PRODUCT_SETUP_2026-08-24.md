# App Store IAP setup — copy-paste sheet

Everything needed to create the two iOS products for Clarity Caddy. The two
product IDs are the only values that MUST be exactly as written — the app asks
for them by ID via /api/store-config. Names and descriptions below match the
in-app paywall wording and fit Apple's length limits (30 / 45 chars).

---

## 1. Monthly Membership (auto-renewable subscription)

App Store Connect → your app → Monetization → **Subscriptions**

First create the group (one-time):

    Subscription Group Reference Name:  Clarity Membership

Then the subscription inside it:

    Product ID:              clarity_membership_monthly
    Reference Name:          Monthly Membership
    Subscription Duration:   1 month
    Price:                   (your choice - match the web price tier)

Localization (English):

    Display Name:  Monthly Membership
    Description:   Full access, renews monthly. Cancel anytime.

Review Information:

    Screenshot:    the paywall screen (see "Review screenshot" below)
    Review Notes:  Unlocks full membership features. Purchasable without an
                   account; access is honoured on-device and transfers to an
                   account on sign-in.

## 2. One Month Pass (non-renewing)

App Store Connect → your app → Monetization → **In-App Purchases** → (+)

    Type:            Non-Renewing Subscription
    Product ID:      clarity_month_pass
    Reference Name:  One Month Pass
    Price:           (your choice)

Localization (English):

    Display Name:  One Month Pass
    Description:   30 days of full access. Does not renew.

Review Information:

    Screenshot:    the paywall screen
    Review Notes:  One payment for 30 days of access. Expiry is managed by our
                   backend from the purchase date. Never auto-renews.

## Review screenshot (required for BOTH, this is what 2.1(b) flagged)

Run the app in the iPad simulator, open Access & Membership, screenshot the
paywall showing both products with prices. Required size for iPad: 2048×2732
(or 2732×2048). The simulator's ⌘S screenshot at that resolution works as-is.
Upload the same image to both products' App Review Screenshot field.

## 3. Attach both IAPs to the app version

On the 1.0 version page in App Store Connect, find the **In-App Purchases and
Subscriptions** section and add both products, so they are submitted WITH the
binary. An IAP not attached to the version is the literal "has not been
submitted for review" rejection.

## 4. RevenueCat side (after the ASC products exist)

Product catalog → Products → **+ New Product**, twice, against the
**Clarity Golf (App Store)** app:

    clarity_membership_monthly
    clarity_month_pass

Then:

- **Entitlements** → `membership` → attach BOTH new App Store products.
- **Offerings** → the current offering → add both (alongside the Play Store
  ones; the app matches packages by product ID, so sharing the offering is
  fine).

## 5. Don't forget

- Paid Apps Agreement must show **Active** (App Store Connect → Business).
- Both products start as "Missing Metadata" until name, price, description and
  screenshot are all in - only then can they be submitted.
- EULA line for the App Description (3.1.2(c) metadata):
  Terms of Use (EULA): https://www.apple.com/legal/internet-services/itunes/dev/stdeula/
