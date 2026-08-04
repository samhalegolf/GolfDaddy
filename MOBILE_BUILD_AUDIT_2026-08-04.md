# Mobile build audit — 2026-08-04

Scope: what stands between the current tree and a shippable native binary now
that the picker hands off to `/app/`. Audit only; no code changed.

Companions: `MOBILE_APP_ARCHITECTURE_HANDOVER_2026-07-31.md` (the spec),
`PRE_BUILD_AUDIT_2026-07-31.md` (what was cut), `GPS_PLAY_DELETION_AUDIT_2026-08-02.md`
(the cutover plan — two of its open gaps are still open, see P1-4 and P1-5).

Verified by reading source and by running the full CI battery plus
`npm run build:app` on this date. **All 24 tests pass.** That is the problem
worth stating first: the suite is Chromium-only and every native test loads the
ROOT `index.html`, so nothing below is caught by CI.

---

## TL;DR

The cutover landed since the 2026-08-02 audit — `scripts/gd-gps-play-runtime-owner-v1.js`
is gone and the picker now navigates to `/app/`
(`scripts/inline/gd-course-picker-search-v2.js:495`). That makes `/app/` the
only GPS play surface in the product.

**On a native build, `/app/` cannot load, and if it could, none of its API calls
would resolve.** Two independent P0s, both native-only, both invisible to the
current tests. Everything else — signing, permissions, privacy manifest,
versioning, deep-link config on Android, plugin sync — is in good shape.

---

## P0 — the native binary ships without GPS play

> **Both P0s fixed and verified on device, 2026-08-04.** Built the iOS project
> (`xcodebuild`, Debug, iPhone 17 Pro simulator, BUILD SUCCEEDED) and drove the
> real flow: home → Play → picker → Akarana → **the `/app/` play surface loads,
> framed on hole 1, over LINZ satellite imagery**. The two-button Back/Home bar,
> the Standing Here / Head To the Tee pill and the hole stepper are all `/app/`
> chrome that does not exist in the root shell, and satellite (rather than the
> OSM drawn fallback) can only appear if `/api/auth-public-config` resolved —
> which on native is exactly what P0-2 was blocking. Full CI battery still
> passes; `npm run build:app` stamps 28 app assets (was 27).

### P0-1 — `/app/` resolves to the legacy root `index.html` on both platforms

The picker navigates to `/app/?courseId=…`
(`scripts/inline/gd-course-picker-search-v2.js:495`). On the web that resolves
to `app/index.html` because the server does directory-index resolution. **The
Capacitor local servers do not.** Both treat an extensionless path as an SPA
route and serve the bundle root:

- iOS — `node_modules/@capacitor/ios/Capacitor/Capacitor/Router.swift:20-24`:
  `if pathUrl.pathExtension.isEmpty { return basePath + "/index.html" }`.
  `/app/` has no extension → root `index.html`.
- Android — `node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/WebViewLocalServer.java:399`:
  `!request.getUrl().getLastPathSegment().contains(".") && html5mode` → root
  `index.html`. `getLastPathSegment()` of `/app/` is `"app"`; `html5mode`
  defaults to `true` (`CapConfig.java:36`) and `capacitor.config.json` does not
  set `server.html5mode`.

The files are in the bundle (`ios/App/App/public/app/index.html`,
`android/app/src/main/assets/public/app/index.html`) — they are simply never
served. Tapping Play in the app re-enters the root shell, which no longer has a
play runtime.

**Fixed** in `gd-course-picker-search-v2.js:navigateToAppPlay` — the target is
now `/app/index.html?…`. The extension makes both routers serve the file, and it
is equally correct on the web. Note that `dev/fresh-app-boot.test.js` already
used the explicit filename (lines 391, 1124, 1164), which is precisely why the
suite stayed green while production shipped the directory form.

### P0-2 — every `/api/*` call from `/app/` 404s on native

`scripts/inline/gd-native-bootstrap.js` is the sole owner of API-origin
resolution: on native it rewrites relative `/api/*` to
`https://caddy.claritygolf.app` by patching `window.fetch`. It is the first
script in the root `index.html` (`index.html:10`).

**`app/index.html` does not load it.** Its seven fetches are all relative and
would resolve against `capacitor://localhost` / `https://localhost`:

| call | file |
| --- | --- |
| `/api/course-package` | `app/js/course-package.js:37` |
| `/api/course-visuals` | `app/js/play.js:67` |
| `/api/course-visual-assets` | `app/js/play-surface.js:351` |
| `/api/course-library` | `app/js/course-library.js:18` |
| `/api/scorecard-store` | `app/js/scorecard.js:50` |
| `/api/auth-public-config` | `app/js/basemap.js:112` |

Consequences, all silent because every consumer is deliberately fail-open: no
course package (so no geometry for an undownloaded course), no published
surface ever, no par data, no LINZ key → **satellite imagery silently
downgrades to OSM everywhere in New Zealand**, and `clarity-supabase-auth.js`
(loaded at `app/index.html:220`) cannot reach its config.

**Fixed** — `app/index.html` now loads `../scripts/inline/gd-native-bootstrap.js`
as its first script, matching the root shell. Inert on web, confirmed in the
browser: `GDNative` resolves to `{isNative:false, platform:"web", apiOrigin:""}`,
`fetch` untouched, app boots with zero console errors. The build's
`stampAppSurface` step resolves `../scripts/…` against `dist/app/` and
content-hashes it like every other asset, and `--app-only` does not prune it
(it is referenced by the root app surface too — worth remembering when wiring
the P1 scripts below).

---

## P1 — ships, but loses data, money, or the round

### P1-3 — no durable storage for any of the new app's keys

`scripts/inline/gd-durable-storage.js` mirrors irreplaceable localStorage keys
into `@capacitor/preferences`, because a WebView evicts web storage under
pressure — its own header calls losing a round on the 14th hole "the worst
failure this app has". It is loaded at `index.html:11` and **not** by
`app/index.html`.

Worse, its `DURABLE_KEYS` list (lines 30-35) predates the rebuild and names none
of the new key space: `clarity:scorecard:v1`, `clarity:bag:v1`,
`clarity:gps-settings:v1`, `clarity:course-library:v1`, plus the nines and pin
stores. The in-progress scorecard is exactly the "round being played right now"
the mechanism exists to protect.

`app/js/course-store.js:5-13` reasons that localStorage needs no native path
because "Capacitor's WebView has the same localStorage API". True of the API,
not of the durability — that is the premise durable-storage.js was written to
correct.

### P1-4 — GPS play has no paid-tier gate

Grepped `app/js` and the picker's handoff path: no entitlement, paywall, or
tier check anywhere. `enterGpsPlay` → `navigateToAppPlay`
(`gd-course-picker-search-v2.js:483-496`) gates only on `result.playable`.
The gate the old runtime owned went with it. GPS play is currently free to
every signed-in account. Flagged as open in the 2026-08-02 audit; still open.

### P1-5 — a round feeds nothing into My Bubble

No writes to the shot/stats pipeline exist in `app/js` — no `shot_library`,
`clarity_practice_shots`, or `/api/shot*` reference. Shots recorded during a
round are viewport state only. Also flagged 2026-08-02; still open.

### P1-6 — Android hardware Back exits the app mid-round

`scripts/inline/gd-native-back-button.js` is loaded at `index.html:352`, not by
`app/index.html`. Without it the system Back gesture pops the WebView history
past the handoff and closes the app. `app/js/boot.js` has its own `exitBack`
(undo → history → main site) wired to the on-screen button only.

### P1-7 — no error reporting on the play surface

`clarity-error-reporter.js` is listed in `PRE_BUILD_AUDIT_2026-07-31.md` as
something the fresh build takes. `app/index.html` loads no reporter and
registers no `onerror`/`unhandledrejection` handler. A crash on the 9th tee
produces nothing anywhere.

---

## P2 — store review, and quality gaps worth closing before submission

### P2-8 — iOS universal links are not configured

`.well-known/` contains `assetlinks.json` only. There is no
`apple-app-site-association`, no `.entitlements` file anywhere under `ios/`,
and no `CODE_SIGN_ENTITLEMENTS` in `project.pbxproj` — so no Associated
Domains. Android App Links are correctly set up
(`android/app/src/main/AndroidManifest.xml`, `autoVerify="true"`, real SHA-256
fingerprint); iOS gets nothing. Password-reset and account-setup emails open
Safari on iPhone, which is the exact failure
`scripts/inline/gd-native-deep-links.js` was written to prevent — and that
script is not loaded by `app/index.html` either.

`scripts/clarity-deploy-build.js:57-61` asserts in a comment that iOS reads
AASA from this path. It is a plan, not a fact.

### P2-9 — location denial is silent and unrecoverable

`app/js/gps.js:26` — the `watchPosition` error callback is an empty function
with the comment "denied or unavailable: stay markerless, no retry loop".
Fail-open is right for "no fix yet"; for a hard denial it leaves the player
with a permanently dotless map, no explanation, and no route to Settings.
App Review routinely tests the denial path.

### P2-10 — the screen sleeps mid-round

No wake lock anywhere in the tree — no `navigator.wakeLock`, no KeepAwake
plugin in `package.json`. Over a four-hour round the display sleeps constantly,
and iOS may purge WebView content under memory pressure on resume.

### P2-11 — offline is thinner than it reads

`app/js/boot.js:174-198` biases to the downloaded package, so a saved course
enters play without a network round-trip. But `course-store.js` stores metadata
only (by design), the published surface is fetched per hole from
`/api/course-visual-assets`, and every basemap source in `app/js/basemap.js` is
a remote tile host. Offline on a course, a "downloaded" course renders as
overlays over blank tiles. Whether that is acceptable is a product call, but it
should be a decision rather than a discovery.

### P2-12 — the Playwright demo harness ships inside the binary

`demo/` (20 KB) is in `publicPaths` (`clarity-deploy-build.js:44`) and lands in
both `ios/App/App/public/demo` and `android/app/src/main/assets/public/demo`.
Small, but it is a dev harness inside a store binary; `--app-only` already
prunes studio files and should prune this too.

### P2-13 — dead stylesheet for the deleted runtime owner

`index.html:383` still links
`styles/inline/gd-gps-play-runtime-owner-v1-css.css` after the JS owner was
deleted.

### P2-14 — CI cannot see any of the above

`dev/native-shell-owner.test.js:103` and `dev/app-permissions-smoke.test.js:55`
both `goto` the root `index.html`. `dev/fresh-app-boot.test.js` boots
`app/index.html` but over plain HTTP in Chromium, where relative `/api/*` and
directory-index resolution both behave the way they never will in WKWebView.
Every native-only defect in this document passes CI green.

---

## What is in good shape

Genuinely done, and worth not re-litigating:

- **Signing.** Keystore and `keystore.properties` are gitignored
  (`.gitignore:31-35`); release builds fail loudly without credentials rather
  than falling back to the debug key.
- **Versioning.** Android `versionCode` derives from commit count with an
  override and a floor (`android/app/build.gradle`); `ios/App/stamp-version.sh`
  mirrors it as a build phase, stamping the built product rather than the repo.
  Both take the marketing version from `package.json`.
- **iOS permissions.** `Info.plist` declares when-in-use location only, with the
  always-key deliberately removed to match `privacy.html`. `arm64` capability
  matches the binary.
- **Privacy manifest.** `PrivacyInfo.xcprivacy` covers the UserDefaults reason
  Capacitor and `@capacitor/preferences` both omit, and its collected-data
  entries mirror the policy page.
- **Android permissions and links.** Fine + coarse location, GPS feature
  optional, App Links verified against a real fingerprint.
- **Plugin sync.** `package.json`, `android/app/capacitor.build.gradle` and
  `ios/App/CapApp-SPM/Package.swift` list the same six plugins. No drift.
- **Build output.** `npm run build:app` succeeds, prunes the studio surface,
  content-stamps 90 root + 27 app assets, and every asset reference in both
  `index.html` and `app/index.html` resolves. `dist` is 10 MB.
- **`app/`'s own rules hold.** 4,549 lines, no `setInterval` outside the
  README's own mention of the rule, and the boot test confirms zero uncaught
  exceptions and zero intervals at runtime.

---

## Status, end of 2026-08-04

Everything below was fixed and is covered by `dev/app-native-contract.test.js`
(registered in CI), which was mutation-tested against three reintroduced defects
before being trusted. Full suite green: 27 structural tests plus boot smoke.

| item | state |
| --- | --- |
| P0-1 extensionless `/app/` handoff | fixed |
| P0-2 no API origin on `/app/` | fixed |
| P1-3 durable storage | fixed — 5 `clarity:*` keys mirrored, 2 in the reload set |
| P1-4 paid-tier gate | fixed — `gps_round_start` restored at the picker, fails closed |
| P1-5 on-course shot feed | fixed — routed to **Course Data**, not My Bubble |
| P1-6 Android back | fixed — wired to `/app/`'s own `exitBack` |
| P1-7 error reporter | fixed |
| P2-8 iOS universal links | files done; project wiring blocked, see below |
| P2-9 silent location denial | fixed — `#gpsNotice`, denial only |
| P2-10 no wake lock | fixed — `app/js/wake-lock.js` |
| P2-11 offline expectations | unchanged; documented, not a defect |
| P2-12 `demo/` in the binary | fixed — pruned by `--app-only` |
| P2-13 "dead" stylesheet | **withdrawn — the finding was wrong** |
| P2-14 CI blind to the native path | fixed |

### P2-13 was wrong

`styles/inline/gd-gps-play-runtime-owner-v1-css.css` is not dead. `gd-shell.js:128-131`
still toggles `shell-gps`, `gdGpsActive` and `gps-active` for the **course-picker**
route, not just the deleted GPS route, so the stylesheet is live every time the
picker opens. The original finding inferred "dead" from the JS owner being
deleted and did not check who else sets the classes. Left in place.

### P2-8 is half-landed, and deliberately so

`ios/App/App/App.entitlements`, `.well-known/apple-app-site-association` and the
`application/json` header in `netlify.toml` are all in. The `CODE_SIGN_ENTITLEMENTS`
wiring is **not**: pointing the target at the entitlements file makes the build
demand a provisioning profile granting Associated Domains, and the cached App
Store profile predates that capability, so the export fails outright. Trading a
working release build for a P2 feature is the wrong way round. Enabling it needs
an Apple ID signed into Xcode (Settings → Accounts), which regenerates the
profile with the capability; the test goes strict automatically once the wiring
lands.

### P1-5 resolved: the feed goes to Course Data

The 2026-08-02 audit framed this as "restore the My Bubble feed or confirm the
cut", but that framing was too narrow — it described where the *old* runtime
happened to send shots (`gd_shot_events_v1`, tagged `courseContext:"gps_course"`),
not where the architecture says they belong. `scripts/gd-shot-snapshot.js` is
explicit:

> GPS Play's only analytical output. At shot completion GPS Play builds a
> complete raw snapshot … and submits it to Course Data. GPS Play performs no
> wind correction, no slope correction, **no My Bubble comparison**, no variant
> selection and no recommendation logic — it records what happened and what the
> player chose.

So the feed now runs GPS Play → `buildShotSnapshot` → `CourseDataIntake.submitShotSnapshot`,
and `gd-course-data-comparison.js` — the My Bubble comparison layer — is
deliberately not loaded on the play surface. Comparing a shot to a bubble is a
downstream question, asked where the analysis is read.

`app/js/course-data.js` owns it; `app/js/shot.js` gained an `onComplete` seam
(shot completion already lived there). Guarded by `dev/app-course-data-feed.test.js`,
mutation-tested against four reintroduced defects.

**Two real bugs surfaced while wiring it**, both the same `Number(null) === 0`
trap and both invisible until shots started being persisted as measurements:

- `buildShotSnapshot` runs numbers through `asNumber(value, null)`, so passing
  `null` for an unmeasured field stored a finite **0**. "No wind reading" became
  "wind measured at 0 km/h" — an invented observation, exactly what the snapshot
  contract forbids. Absent numerics are now passed as `undefined`, which takes
  the null fallback.
- `app/js/shot.js`'s `pt()` answered `{lat:0, lng:0}` for a null input, because
  `Number(null)` is 0 and 0 is finite. `holeOut(null)` was recording the ball in
  the Gulf of Guinea rather than falling back to the aim. Harmless while shots
  lived in memory for one round; not harmless once Course Data persists them.
  Fixed at source, and hole-outs with no fix are now labelled
  `hole-out-assumed-target` rather than passed off as observed.

`gd_shot_snapshots_v1` is mirrored to durable storage — a shot is a measurement
of a moment that cannot be retaken. The derived analyses beside it are not, since
`reprocessShot` can rebuild them from the raw.

## Suggested order

1. ~~`/app/index.html?…` in the picker (P0-1)~~ — **done**.
2. ~~Load `gd-native-bootstrap.js` first in `app/index.html` (P0-2)~~ — **done**.
3. Load the rest of the native layer into `app/index.html`:
   `gd-durable-storage.js`, `gd-native-back-button.js`,
   `gd-native-deep-links.js`, and the error reporter (P1-3, P1-6, P1-7).
4. Extend `DURABLE_KEYS` to the `clarity:*` key space (P1-3).
5. Decide the two product gaps — tier gate and shot feed (P1-4, P1-5).
6. Add a WKWebView-path test so 1 and 2 cannot regress (P2-14), then work P2.
