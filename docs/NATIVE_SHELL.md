# Native shell (Capacitor) — state and gaps

Supersedes `NATIVE_APP_PLANNING_HANDOVER.md` on the abandoned `native-app-planning`
branch (2026-06-18). That branch was never merged and its `src/shared/*` extractions
were stale against the structural rebuild; nothing from it is carried forward except
the bundle identifier.

- App name: **Clarity Caddy**
- Bundle ID / package: `com.claritygolf.caddy` (both platforms)
- Capacitor **8.4.2**, versions pinned exactly — not `latest`
- Model: **bundled assets**, not a remote-URL wrapper

## How it loads

`npm run build:netlify` copies `index.html`, `assets/`, `scripts/`, `styles/` into
`dist/`. `npx cap sync` copies `dist/` into the native projects. The webview serves
those files from a local origin (`https://localhost` on Android, `capacitor://localhost`
on iOS) — both are secure contexts, which geolocation requires.

`npm run native:sync` does build + sync in one step. `native:android` / `native:ios`
also open the IDE.

## The one new module

`scripts/inline/gd-native-bootstrap.js` — sole owner of platform detection and API
origin. Loads **first** in `index.html`, before everything including the file-protocol
guard.

Because the bundled app is not served from Netlify, the 24 relative `/api/*` calls
spread across 13 files would hit the webview and 404. Rather than edit 13 files, the
bootstrap patches `window.fetch` to rewrite `/api/*` to `https://caddy.claritygolf.app`
when native. Call sites stay relative, which is what the web build needs.

On web the module is inert: `isNative` false, `apiOrigin` empty, `fetch` untouched.
`dev/native-shell-owner.test.js` locks both halves and runs in structural CI. The
native half is verified by re-running the module source against a stubbed Capacitor
global, so it needs no device.

Also changed: `gd-file-protocol-redirect.js` now bails when native (it would otherwise
risk replacing `document.body` with the "run python3 http.server" screen), and the
viewport meta gained `viewport-fit=cover` for safe areas.

## Verified working

- Android debug APK builds: `cd android && ./gradlew assembleDebug` → 14 MB
- 124 web asset files bundled into the APK, including `gd-app-core.js` and Leaflet
- Manifest declares `INTERNET`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`
- `npm run test:boot` still passes — 0 uncaught exceptions
- `dev/native-shell-owner.test.js` passes

Android needs `JAVA_HOME` pointed at Android Studio's bundled JBR:

```
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
```

## Not yet done

**iOS is scaffolding only.** The project generates and plugins resolve via Swift
Package Manager (Capacitor 8 dropped the CocoaPods requirement), but this machine has
only Command Line Tools. Building needs full Xcode from the App Store. Nothing about
the iOS project has been compiled or run.

**Nothing has run on a real device or emulator.** The APK builds; it has not been
installed. Real-course GPS testing is still the gate before any public submission.

**Store billing: code complete, unconfigured.** The webhook
(`functions/store-webhook.js`), schema, entitlement read path, referral rewards and
the client module (`scripts/clarity-store-billing.js`) are all built and tested.
`PurchasesPlugin` and the Play Billing Client are confirmed present in the built APK.

The client talks to the RevenueCat plugin through the Capacitor bridge
(`window.Capacitor.Plugins.Purchases`) rather than importing the SDK, because this
repo has no bundler. Signatures match `@revenuecat/purchases-capacitor` 13.2.3; if
that dependency is upgraded, re-check `configure`, `logIn`, `getOfferings`,
`purchasePackage` and `restorePurchases` against `definitions.d.ts`.

The module never grants access. A completed purchase only triggers a re-read of
`/api/payment-entitlement`, polled for a few seconds because the webhook is
asynchronous — the entitlement is written server-side after RevenueCat validates the
receipt. A client that could grant its own access would be trivially spoofable.

What remains is external setup that cannot be done from the repo:

1. RevenueCat account with the Play app connected
2. Products in Play Console, and a RevenueCat offering containing them
3. Netlify environment variables:
   - `REVENUECAT_ANDROID_PUBLIC_KEY` / `REVENUECAT_IOS_PUBLIC_KEY` — public SDK
     keys, served to the app by `/api/store-config`
   - `REVENUECAT_WEBHOOK_AUTH` — shared secret; **the webhook fails closed without
     it**, since an unauthenticated endpoint that writes entitlements would let
     anyone grant themselves paid access
   - `STORE_MEMBERSHIP_PRODUCT_ID` / `STORE_MONTH_PASS_PRODUCT_ID` — default to
     `clarity_membership_monthly` and `clarity_month_pass`
4. RevenueCat webhook pointed at `https://caddy.claritygolf.app/api/store-webhook`,
   with the Authorization header set to the same shared secret

Product ids and SDK keys are served from `/api/store-config` rather than hardcoded,
so they can change without a store release — a wrong product id would otherwise be a
multi-day review cycle to fix.

`appUserID` is set to our `account_id`, which is the only join the webhook has back
to an account. `buy()` and `restore()` both identify before purchasing, so no login
hook is needed.

Nothing has been run against a real store. The webhook is tested against stubbed
Supabase and synthetic RevenueCat payloads; the client is tested against a stubbed
Capacitor bridge. No real money has moved through any of it.

**Auth deep links break.** Password-reset and account-setup emails link to
`caddy.claritygolf.app` with `?claritySetPassword=1` / `?clarityResetPassword`,
generated server-side. Those open the browser, not the app. Needs universal links
(iOS) and app links (Android) before either flow works from a native install.

**Local storage is the whole persistence layer.** 299 `localStorage` references,
including the auth session at `clarity:supabase-auth-session:v1`. Webview storage
eviction logs the user out and loses local round and course data. `@capacitor/preferences`
is installed but not yet wired in as a durable backing store.

**Geolocation still uses the web API.** `navigator.geolocation` works in both webviews
and the single `watchPosition` is centralised in
`scripts/inline/gd-gps-play-runtime-owner-v1.js`, so it functions — but
`@capacitor/geolocation` is installed and not yet used. Moving to it would give proper
permission prompts and better background behaviour.

**No Android back-button handling.** `@capacitor/app` is installed but not wired.
Hardware back currently does nothing useful; it should close the topmost modal before
navigating.

## Third-party origins the webview must reach

`server.arcgisonline.com` (satellite tiles), `{s}.tile.openstreetmap.org`,
`api.open-meteo.com` (elevation + wind), `cdn.jsdelivr.net` (tesseract.js for OCR).
All HTTPS, so no cleartext exemption is needed.
