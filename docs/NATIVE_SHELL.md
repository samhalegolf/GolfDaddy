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

- Android debug APK builds: `cd android && ./gradlew assembleDebug` → 11 MB
  (was 14 MB before the app/studio split — see `docs/APP_STUDIO_SPLIT.md`)
- iOS Release builds and launches in the Simulator
- The bundled web assets are the **app** surface only: no admin panels, no
  full visual engine, just the 38KB play/capture client
- Manifest declares `INTERNET`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`
- `npm run test:boot` still passes — 0 uncaught exceptions
- `dev/native-shell-owner.test.js` passes

Android needs `JAVA_HOME` pointed at Android Studio's bundled JBR:

```
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
```

## Not yet done

**iOS now builds and runs.** Superseded 2026-07-26: Xcode 26.6 is installed, the
Release configuration compiles, and the app installs and launches in the
Simulator (auth gate renders, safe areas correct). It has still never run on a
physical device.

**iOS signs and archives.** Superseded 2026-07-28: an Apple Developer account is
signed into Xcode, `DEVELOPMENT_TEAM` is `9JL7847XQL` in both configs, and
`xcodebuild archive` produces a signed archive — verified at 1.0.0 build 507,
arm64, privacy manifest present, 3 dSYMs.

Two things blocked it, and neither reported itself honestly.

The project-level Release config pinned `CODE_SIGN_IDENTITY` to
`"iPhone Developer"` — the pre-2019 name for a *development* certificate,
straight from the Capacitor template. Archiving therefore asked for an iOS App
Development profile and failed with "your team has no devices", which reads as
an account problem rather than a build setting naming the wrong class of
certificate. Release is now `"Apple Development"`, which is what automatic
signing expects **at build time**: it signs the archive for development and
re-signs for distribution at export. `"Apple Distribution"` is the tempting fix
and is rejected outright as a conflicting manual identity. Debug keeps the
legacy string — Xcode still maps it, and nothing about Debug was broken.

`xcodebuild` registers a device only with `-allowProvisioningDeviceRegistration`.
`-allowProvisioningUpdates` creates profiles and certificates but never devices,
so on an account with none the archive fails identically whether or not a phone
is plugged in. A first archive on a fresh account needs both flags:

```
xcodebuild archive -project ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath <path>.xcarchive \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration
```

The device also needs Developer Mode on (Settings → Privacy & Security). iOS 16+
refuses development use without it, and Xcode will not register a device it
cannot use — so the toggle looks unrelated and is not.

**Nothing has been uploaded.** No App Store Connect app record existed as of
2026-07-28 and no build has reached TestFlight. Upload runs from Xcode's
Organizer, which reuses the account already signed into Xcode; `xcrun altool`
wants an App Store Connect API key or app-specific password, and this machine
has neither.

**Nothing has run on real hardware.** Still true. A signed Debug build for the
registered iPhone compiles, but it was never installed or launched, and the
Android APK has never been on a phone either. Real-course GPS testing is still
the gate before any public submission.

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

## Android release signing

Debug builds need nothing. A **release** build (for Play internal testing or
production) requires an upload keystore, which is deliberately not in this repo.

Create it once — this prompts for the passwords, so they are never typed into a
shell history:

```
keytool -genkeypair -v \
  -keystore android/clarity-caddy-upload.jks \
  -alias clarity-caddy-upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

Then copy `android/keystore.properties.example` to `android/keystore.properties`
and fill in the two passwords. Both the `.jks` and `keystore.properties` are
gitignored; CI can set `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` instead.

**Back the keystore up somewhere durable and off this machine.** Losing it means
losing the ability to update the app on Play, unless Play App Signing key
upgrade is available.

Build:

```
npm run native:release:aab    # android/app/build/outputs/bundle/release  - for Play
npm run native:release:apk    # android/app/build/outputs/apk/release     - direct install
```

A release build without credentials fails at task-graph time with an explicit
message rather than silently falling back to the debug key — Play rejects
debug-signed artifacts, and discovering that at upload wastes a build.

## Versioning, both platforms

Neither platform has a version number to bump by hand.

- **Android** — `versionCode` is the git commit count and `versionName` comes
  from `package.json` (`resolveVersionCode`/`resolveVersionName` in
  `android/app/build.gradle`). `ANDROID_VERSION_CODE` overrides for CI.
- **iOS** — the same two values, stamped onto the **built** `Info.plist` by the
  "Stamp version" build phase (`ios/App/stamp-version.sh`). `IOS_BUILD_NUMBER`
  overrides for CI.

`CFBundleVersion` was hardcoded to `1` until 2026-07-26, which would have let
exactly one App Store Connect upload through and had every later one rejected.

The iOS values are stamped onto the build product rather than written into
`project.pbxproj` on purpose: a commit-count build number in a tracked file
dirties the tree on every commit, and committing that change advances the count
again — a loop with no fixed point.

One ordering detail matters and is easy to get wrong. Xcode re-runs
`ProcessInfoPlistFile` on incremental builds and will overwrite an unordered
stamp — a clean build looks correct while every incremental one silently ships
`1.0 / 1`. The phase declares `$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)` as an
**input**, which forces it to run afterwards. `dev/ios-version-stamp.test.js`
asserts that, and it was verified by building twice into the same derived data.

## Network reachability, verified on device

The bundled app is served from `https://localhost`, so every `/api` call is
cross-origin. Netlify functions send no CORS headers, so the webview blocked them
all until `CapacitorHttp` was enabled — requests now originate from native code and
CORS does not apply.

Probed from inside the running app. Every status matches what the live site returns
to a direct request, so nothing is being blocked or mis-rewritten:

| Endpoint | Status | Meaning |
|---|---|---|
| `/api/auth-public-config` | 200 | Supabase config loads — was `Failed to fetch` before the fix |
| `/api/course-maps` | 200 | course picker search works |
| `/api/course-visuals` | 400 | reachable; 400 is "missing params" |
| `/api/captured-surface-sync` | 405 | reachable; needs POST |
| `/api/account-sync` | 405 | reachable; needs POST |
| `overpass-api.de/api/interpreter` | 200 | AutoMapper course scan works |
| `api.open-meteo.com` | 200 | elevation and wind |
| `cdn.jsdelivr.net` | 200 | tesseract OCR |

Caveat: the POST-only endpoints were confirmed reachable by a GET returning 405.
That proves the transport works; it does not prove those flows succeed end to end
with auth headers and a real payload.

Satellite tiles are `<img>` elements, not fetches, and were never affected.

## Third-party origins the webview must reach

`server.arcgisonline.com` (satellite tiles), `{s}.tile.openstreetmap.org`,
`api.open-meteo.com` (elevation + wind), `cdn.jsdelivr.net` (tesseract.js for OCR).
All HTTPS, so no cleartext exemption is needed.
