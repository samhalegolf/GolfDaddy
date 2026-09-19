# Clarity Caddy — Garmin Connect IQ Upload Readiness Audit

**Date:** 2026-09-20 (NZ) · **Audited revision:** `c611f667e61185d4b20fae53830845b37ac8e0f5` (merge of PR #80 `garmin-first-build`) · **Branch:** `claude/happy-brown-wb38a7`
**Audit type:** static evidence-gathering. No application code was modified. No build, package, deploy or Store action was taken.

> **Evidence labels used throughout**
> - **[GARMIN-REQ]** Official Garmin requirement (from Garmin documentation)
> - **[GARMIN-DOC]** Garmin documentation guidance
> - **[COMMUNITY]** Observed Garmin/community failure mode (not an official rule)
> - **[CADDY-INV]** Caddy architectural invariant (from the audit spec §2)
> - **[ENG-REC]** Strong technical / engineering recommendation
> - **[VERIFY]** Agent suspicion or recollection that requires human verification
>
> **Environment limitation.** This audit ran on a Linux container with no Connect IQ SDK, no `monkeyc`, no simulator, no Garmin hardware, and outbound access to `developer.garmin.com` blocked by the network proxy. Every Garmin API-level fact below that is not quoted from a file in this repo is therefore my recollection of the Connect IQ documentation and is tagged **[VERIFY]**. Nothing in this report is a hardware or simulator result.

---

## Final result (summary)

```
CLARITY CADDY — GARMIN AUDIT

GARMIN PACKAGE       🟠 REVIEW
DEVICE COMPATIBILITY 🟠 REVIEW
CADDY ARCHITECTURE   🔴 BLOCK
RUNTIME HARDENING    🔴 BLOCK

FINAL STATUS:        NOT READY
```

Four P0 blockers (GA-001 to GA-004). The two that matter most are outside the watch code: the phone app cannot talk to a Garmin at all yet (the Connect IQ Mobile SDK is not bundled, so `send()` returns `false` on both platforms), and the watch app has never been launched in the simulator or on a device. Uploading now would give a reviewer an app that says "Waiting for round" forever. Full finding list in §32, gate rationale in §36.

---

## Phase A — Repository discovery

| Item | Finding |
|---|---|
| Connect IQ project root | `garmin/` — the only `manifest.xml` / `monkey.jungle` in the repo (excluding `node_modules`). Verified with `find`; there is no second Garmin-looking directory. |
| App type | One `watch-app` (`ClarityCaddyApp`). No data fields, widgets, watch faces or background services. |
| Manifest | `garmin/manifest.xml` (see §5) |
| Jungle | `garmin/monkey.jungle` — single barrel, `source/` + `resources/` + per-device `resources-icons/{35,40,60,70}` |
| Monkey C source | 32 files, 4,188 lines under `garmin/source/` (Session, GPS, Maps, Bubble, Player, UI, Device) |
| Resources | `resources/strings/strings.xml` (one string: `AppName`), four launcher icons (35/40/60/70 px, sizes verified with `file`) |
| Generated artefacts | **None.** `garmin/build/`, `*.iq`, `*.prg` are git-ignored (`.gitignore` lines 58-61) and none exist in this checkout. |
| Exported `.iq` | **Not available for audit.** |
| SDK version | Not installed here. Repo claims SDK **9.2.0** was used on 2026-09-19 (`garmin/UPLOAD.md` §0, commit `b1408af`). |
| Target devices | `approachs62`, `approachs7042mm`, `approachs7047mm`, `fenix6`, `fr55` |
| Build scripts | `garmin/build.sh` (`check` / `build` / `package`) |
| Test config | `npm run test:garmin` → `dev/garmin-settings-surface.test.js`, `dev/garmin-launcher-icons.test.js`. **Not wired into CI** (`.github/workflows/structural-smoke.yml` has no Garmin reference). No Monkey C tests; no simulator config. |
| External libraries | None. No barrels, no third-party Monkey C. |
| Network endpoints (watch) | Phone via `Toybox.Communications`; hole imagery via `Communications.makeImageRequest` to `<GDNative.apiOrigin>/api/course-watch-map-assets?path=…` (URL is attached by the phone in `app/js/watch-map-delivery.js`). No direct Supabase or other endpoint from the watch. |
| Watch/phone comms docs | `garmin/README.md`, `garmin/UPLOAD.md`, `app/js/caddy-watch.js` (Scene/command contract), `ios/App/App/Wearables/Garmin/GarminTransport.swift`, `android/.../wearables/garmin/GarminTransport.java` |

**Exact project/build path audited:** `/home/user/GolfDaddy/garmin` at commit `c611f66`.

---

## 4. Build integrity

| Check | Status | Evidence |
|---|---|---|
| Project compiles cleanly | 🟠 REVIEW | Claimed for all five products with SDK 9.2.0 on 2026-09-19 (commit `b1408af`, `UPLOAD.md` §0). **Not reproducible in this environment** (no SDK). `garmin/README.md` line 3 still says "This code has never been compiled" — stale and contradicting `UPLOAD.md`. |
| No compiler errors | 🟠 REVIEW | Same evidence as above; no build log is checked in. |
| No warnings affecting runtime | 🟠 REVIEW | `build.sh` passes `--warn` but no warning output is recorded anywhere. |
| Exported `.iq` can be produced | 🟠 REVIEW | `./build.sh package` documented; claimed to work; not verified here. |
| Export contains intended binaries | 🟠 REVIEW | Cannot inspect; no artefact. |
| Package corresponds to audited revision | 🔴 not established | No `.iq` hash recorded anywhere in the repo. |
| Build uses intended SDK / SDK recorded | 🟠 REVIEW | SDK auto-detected from PATH or `current-sdk.cfg` (`build.sh` lines 22-38) — whichever SDK the Mac has "current" wins; not pinned. |
| No stale artefacts mistaken for output | 🟢 PASS | Nothing checked in; `build/` ignored. |
| No dev-only configuration | 🟢 PASS | No debug flags, no dev endpoints in `garmin/`. |
| Application ID correct and stable | 🟢 PASS (see §5) | `fac5991c01f348ddb7577553071ddd0f` in manifest; matches iOS (dashed) `NativeRoundBridge.swift:81` and Android `NativeRoundBridge.java:60`. |
| Version number intentional | 🟠 REVIEW | Manifest declares no `version` attribute; Connect IQ takes the app version from the Store form on upload **[VERIFY]**. No release version is tracked in-repo. |

**Provenance record**

| Field | Value |
|---|---|
| Git commit | `c611f667e61185d4b20fae53830845b37ac8e0f5` (2026-09-20 10:18 +1200) |
| Garmin-relevant commits | `b1408af` compile fixes, `2dcb618` map URL, `33f98c9` pairing UI, `676be14` app id, `a97df65` launcher icons |
| SDK version | 9.2.0 per repo text — **unverified here** |
| SDK build | unknown |
| Build timestamp | none recorded |
| IQ package filename | `garmin/build/ClarityCaddy.iq` (by convention; file not present) |
| IQ package SHA-256 | **not available** |
| Package size | **not available** |

---

## 5. Manifest audit (`garmin/manifest.xml`)

| Check | Status | Evidence / note |
|---|---|---|
| Application type correct | 🟢 | `type="watch-app"`; the app is a foreground interactive app. |
| Application ID valid | 🟢 | 32-hex UUID, developer-generated; comment in manifest explains stability rule. Consistent with both phone builds. |
| Product list intentional | 🟢 | Five products, deliberately chosen (Approach S62, S70 42/47 mm, fenix 6, FR 55). Each has a matching `resourcePath` line in `monkey.jungle`. |
| Every product currently valid/supported | 🟠 | All five compiled under SDK 9.2.0 per the commit message, which implies the SDK knows the ids. **Not confirmed against the current Compatible Devices list here** (site blocked). Run `./build.sh check` on the Mac. |
| No obsolete/unsupported ids | 🟠 | `approachs62` tops out at CIQ 3.0.x (manifest comment). Still listed by Garmin **[VERIFY]**. |
| No simulator/preview products | 🟢 | None. |
| Minimum API level appropriate | 🟠 | `minSdkVersion="3.0.0"`, lowered from 3.2.0 so the S62 compiles. All Toybox calls used are ≥ 3.0-compatible or `has`-guarded (see §7). Note the trade-off: three of five devices are CIQ 3.x-era and will take the `drawBitmap` fallback path (GA-006). |
| Permissions intentional | 🟢 | `Positioning`, `Communications` only. |
| Permissions match functionality | 🟢 | `Positioning` → `Position.enableLocationEvents` (`GarminLocationManager.mc:39`). `Communications` → `registerForPhoneAppMessages`, `transmit`, `makeImageRequest`. |
| Required permissions present | 🟢 | Nothing else used (no Background, Sensor, Fit, PersistedContent). |
| Unnecessary permissions | 🟢 | None. |
| Resources referenced exist | 🟢 | `@Strings.AppName` → `strings.xml`; `@Drawables.LauncherIcon` → each icon folder's `drawables.xml`. Per-product wiring guarded by `dev/garmin-launcher-icons.test.js`. |
| Languages intentional | 🟢 | `eng` only; UI strings are hard-coded English in Monkey C (not resource strings) — fine for a single language, but a localisation debt (P3). |
| Developer/company metadata | n/a | Lives in the developer portal, not the manifest. |
| Store name vs manifest name | 🟠 | Manifest `AppName` = "Clarity Caddy"; `UPLOAD.md` says the Store name will be "Clarity Caddy". Consistent by intent; no Store listing exists yet to confirm. |

---

## 6. Device compatibility matrix

Evidence source for **every row is static/API only**. No simulator run, no hardware. Device facts (resolution, display type, touch, API ceiling, memory) are **[VERIFY]** recollections — read them from each device's `compiler.json` in the SDK Manager's `Devices/` folder before trusting them.

| Device | Valid product | API compatible | APIs supported | Permissions | Display | Input | Memory risk | Physical test | Result |
|---|---|---|---|---|---|---|---|---|---|
| approachs62 | compiles (SDK 9.2.0 claim) | 3.0.x ceiling; min 3.0.0 ok | `drawBitmap2` absent → fallback path (GA-006); touch API constants [VERIFY] | Positioning, Communications | 260×260 round MIP [VERIFY] | touch + buttons | Medium — full-size bitmap in app heap (GA-014) | none | 🟠 |
| approachs7042mm | compiles | 4.2+/5.x [VERIFY] | `drawBitmap2` present [VERIFY]; option keys used may be wrong (GA-006) | same | 390×390 AMOLED [VERIFY] | touch + buttons | Low | none | 🟠 |
| approachs7047mm | compiles | as above | as above | same | 454×454 AMOLED [VERIFY] | touch + buttons | Low | none | 🟠 |
| fenix6 | compiles | 3.x/4.x [VERIFY] | `drawBitmap2` likely absent on 3.x firmware (GA-006); no touch → nudge only | same | 260×260 round MIP [VERIFY] | 5 buttons | Medium | none | 🟠 |
| fr55 | compiles | 3.x [VERIFY] | as fenix6 | same | 208×208 round MIP [VERIFY] | 5 buttons | **High** — smallest heap in matrix [VERIFY] (GA-014) | none | 🟠 |

- **Oldest supported target:** Approach S62 (CIQ 3.0.x).
- **Smallest display:** Forerunner 55 (208 px).
- **Lowest-resource target:** Forerunner 55 (likely) — verify `appMemory` in `compiler.json`.
- **AMOLED:** Approach S70 42 mm / 47 mm.
- **MIP:** Approach S62, fenix 6, Forerunner 55.
- **Touchscreen:** Approach S62, S70 (both). `DeviceCapabilities.hasTouch()` reads `isTouchScreen` with a `has` guard.
- **Button-oriented:** fenix 6, Forerunner 55 (no lateral aim nudge exists for these — README Phase 3).
- **Materially different API generations:** CIQ 3.0 (S62) vs CIQ 4/5 (S70). Different graphics pool model, different `drawBitmap2` availability, different memory ceilings.

---

## 7. API compatibility (static)

Toybox modules used: `Lang`, `Math`, `WatchUi`, `Graphics`, `System`, `Application(.Storage)`, `Time`, `Timer`, `Communications`, `Position`. No libraries.

| API | Location | Available at min 3.0.0? | Notes |
|---|---|---|---|
| `Position.enableLocationEvents(LOCATION_CONTINUOUS/DISABLE, cb)` | `GarminLocationManager.mc:39,49` | Yes (1.0) | Foreground only; correct permission. |
| `Position.Info.accuracy`, `QUALITY_*` | `GarminLocationManager.mc:91-99` | Yes | **[VERIFY]** `accuracy` is `Position.Quality` (enum) on every API level I know of — the "metres directly" branch (line 91) is dead code; harmless. |
| `Communications.registerForPhoneAppMessages` | `GarminSessionManager.mc:59` | Yes (1.0) | try/catch wrapped. |
| `Communications.transmit(dict, null, ConnectionListener)` | `GarminSessionManager.mc:379` | Yes | Listener is a no-op; delivery inferred only from ACKs (good). |
| `Communications.makeImageRequest(url, null, {:maxWidth,:maxHeight}, cb)` | `GarminMapDownloader.mc:62` | Yes (1.2) | Callback shape typed `(Number, BitmapResource|BitmapReference|Null)`. `BitmapReference` only exists on graphics-pool devices (CIQ 4+) **[VERIFY]** — the type annotation compiled, so fine. |
| `Application.Storage.getValue/setValue` | Outbox, MapStore, PlayerStore | Yes (2.4) | Size limits **[VERIFY]** (GA-014). |
| `Timer.Timer.start(method, 1000, true)` | `ClarityCaddyApp.mc:25` | Yes | 1 Hz for process lifetime (GA-020). |
| `WatchUi.BehaviorDelegate` `onSelect/onBack/onMenu/onNextPage/onPreviousPage/onKey/onTouch` | `CaddyInputDelegate.mc` | Yes | `onTouch`, `TOUCH_START/MOVE/END/RELEASE`, `KEY_LAP` are guarded with `has`, so an unknown symbol degrades rather than crashes — but the **behaviour** is unverified (GA-013). |
| `dc.drawBitmap2(x,y,bmp,{:destWidth,:destHeight,:filterMode})` | `GarminMapView.mc:242-246` | `has`-guarded | **[VERIFY]** `drawBitmap2` was introduced in CIQ 4.2.1 and its documented options are `:tintColor`, `:filterMode`, `:transform` (an `AffineTransform`) — I do not recall `:destWidth`/`:destHeight` being valid keys. See GA-006. |
| `Graphics.FILTER_MODE_BILINEAR` | `GarminMapView.mc:243` | inside `has` guard | Symbol exists only on CIQ ≥ 4.2.1 **[VERIFY]**; reached only when `drawBitmap2` exists. |
| `System.getDeviceSettings().screenShape/isTouchScreen`, `getSystemStats().totalMemory` | `DeviceCapabilities.mc` | Yes | `has`-guarded where needed. |
| `Lang.Array.slice`, `indexOf`, `String.find/substring/toCharArray/toUpper/toLower`, `Lang.format` | Maps, Bubble | Yes on 3.0 **[VERIFY]** `slice` | Compiled for the S62, which is the strongest evidence available. |
| `Math.log(x, base)`, `Math.pow`, `Math.atan2`, `Math.rand` | Bubble, Maps | Yes | `Math.rand()` is never seeded (`Math.srand` unused) — see GA-005. |

No API is used that requires a permission the manifest lacks. No background APIs, no sensors, no FIT, no web requests other than `makeImageRequest`.

---

## 8. Permissions and privacy

**Positioning — why?** To place the player, size the Bubble, and mark the ball on LOCK from the wrist's own GPS. Started only when a Scene with a round arrives (`receiveScene` → `locationManager.start()`, line 278) and stopped when the round ends (line 255). Not enabled silently at launch. 🟢 PASS on behaviour.

**Communications — why?** Scene/manifest/player/ack from the phone, commands to the phone, hole-image fetch. 🟢 PASS.

| Check | Status | Note |
|---|---|---|
| Permission necessary | 🟢 | Both used. |
| User-facing behaviour matches | 🟠 | There is no on-screen "GPS acquiring / GPS off" state; the user cannot tell that location is active (GA-023). |
| Not inherited from unused dependency | 🟢 | No dependencies. |
| Location handled correctly | 🟢 | Accuracy bound ≤ 100 m before a fix is "usable"; 30 s age bound before it is sent. |
| Not silently enabled against Garmin requirements | 🟢 | Gated on a live round. |
| Consent/notification | 🟠 | Garmin surfaces the permission at install **[GARMIN-DOC, VERIFY]**. The app shows no first-run notice. |
| Data collected understood | 🟢 | Watch sends: coordinate + accuracy + timestamp on LOCK (`LOCK_AT`), aim coordinate on `AIM_AT`, map inventory (course key + hole numbers), player-snapshot fingerprint + engine version. Nothing else leaves the watch. |
| Privacy policy exists / URL available | 🟢 | `privacy.html` hosted (per `UPLOAD.md` §7). |
| Policy accurately describes behaviour | 🟠 | `privacy.html` §Location covers "device location while the app is open" and saved course positions. It does not mention a watch/wearable at all, nor that a LOCK position originates on the watch and is stored via the phone. Update before submission (GA-016). |
| Retention / deletion understood | 🟠 | On-watch: outbox, manifest, ready-hole set, player snapshot persist in `Application.Storage` with no expiry and no clear-on-round-end. Phone/account retention is covered by the existing policy. |
| No undocumented collection | 🟢 | None found. |

---

## 9. Security scan

Scanned `garmin/**` source, resources and docs. **No package available to scan** (see §30).

| Category | Result |
|---|---|
| API keys / secrets / passwords / tokens / JWTs / private keys / cloud or DB credentials | **None** in `garmin/`. |
| Credential-bearing URLs | None. Map URLs are unauthenticated by design; the proxy `functions/course-watch-map-assets.mjs` holds the Supabase service key server-side only. |
| localhost / staging / internal hostnames | None. |
| Base64 / high-entropy blobs | None (regex for ≥40-char tokens: no hits). The only long literal is the app UUID. |
| Unexpected binaries | Four PNG launcher icons only. |
| External libraries | None. |

**URLs / domains found**

| Where | URL | Assessment |
|---|---|---|
| `manifest.xml` | `http://www.garmin.com/xml/connectiq` | XML namespace, not a request. Expected. |
| `build.sh`, `UPLOAD.md` | `https://developer.garmin.com/connect-iq/sdk/`, `https://apps.garmin.com/developer/dashboard` | Doc links only. |
| runtime (from phone) | `<apiOrigin>/api/course-watch-map-assets?path=<course>/vN/hN.webp` | Expected, authorised, unsigned by design, immutable cache. HTTPS depends on `GDNative.apiOrigin` being an `https://` origin **[VERIFY]** — `makeImageRequest` will refuse plain `http` on modern firmware **[COMMUNITY, VERIFY]**. |

Email addresses: none in `garmin/`.

**Developer key:** generated by `build.sh` at `~/.garmin/clarity_caddy_developer_key`, outside the repo; `.gitignore` excludes `*.iq`/`*.prg`. 🟢 No key material in git history was searched for beyond `garmin/` — run `git log -p --all -S "PRIVATE KEY"` on the Mac if you want that closed off too.

---

## 10. External service audit

| Dependency | Provides | Needed for core play? | Unavailable → | Cached? | Watch continues? | Timeout | Malformed | Auth failure | Stale can overwrite? |
|---|---|---|---|---|---|---|---|---|---|
| **Phone app (Communications)** | Scene (round, hole, F/C/B, target, controls, surface), map manifest, player snapshot, command ACKs | **Yes for round identity, hole changes, F/C/B, lock confirmation.** Only the Bubble/target distance/club is computable locally. | Last Scene stays on screen; hole cannot change; LOCK shows "LOCKED" locally for ≤ 20 s then reverts; commands queue in `Application.Storage`. After a watch relaunch: "Waiting for round" until the phone republishes (GA-010). | Scene: no. Manifest, player snapshot, outbox: yes. | Partially (see §15). | No explicit timeout; ACK-driven; retry on every Scene after ≥ 10 s (quantised, GA-005). | `GarminWire` coerces bad fields to null; `isSupported()`/`isUsable()` gates. 🟢 | n/a | Same-round older revision ignored ✅; **different-round or no-round Scene accepted unconditionally** (GA-011). |
| **`/api/course-watch-map-assets` via `makeImageRequest`** (through phone's internet) | Per-hole raster | No — numbers face works without it. | "Loading map..." forever with a silent 1 Hz re-request loop (GA-007). | Decoded bitmap: RAM only, one at a time. "Ready" set persisted, bitmap not (GA-019). | Yes. | Handled by SDK; any non-200 → drop `inFlight` and retry next frame. | Non-200/null data ignored. | None (public). | Response attributed to "first in-flight hole" — can attach to the wrong hole/course (GA-004). |
| **Supabase / auth** | nothing directly | No | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

The architecture is explicitly **phone-authoritative** ("Marshal owns the round", `GarminSessionManager.mc` header; `UPLOAD.md` §7 "useless without the Clarity Caddy phone app"). That is a deliberate design, so the phone dependency is *expected*, not hidden. It still fails the spec's Local Caddy expectations in several places — see §15.

---

## 11. ROUND audit

Authoritative round = the last accepted `GarminScene` held in `GarminSessionManager.scene` (`roundId`, `revision`, `course.key`, `hole.number`).

| Check | Status | Evidence |
|---|---|---|
| One authoritative active round | 🟢 | Single `scene` field; `face()` and every view read it. |
| Round has stable identity | 🟢 | `scene.roundId()`; commands carry it; outbox discards other rounds' commands (`discardCommandsForOtherRounds`). |
| Course belongs to round | 🟢 | `course.key` is inside the Scene. |
| Current hole belongs to round | 🟢 | `hole.number` inside the Scene. |
| Scene/revision belongs to round | 🟢 | `revision` inside the Scene; guard is round-scoped. |
| Survives screen changes | 🟢 | Views are composed, not pushed; `CaddyAppView` only toggles `showingMap`. |
| Survives background/foreground | 🟠 | Connect IQ watch apps do not run in the background **[GARMIN-DOC, VERIFY]**; leaving the app is `onStop` → process end. Scene is **not persisted**, so "foreground again" = relaunch = no round until the phone re-sends (GA-010). |
| Survives lock/unlock | 🟢 (static) | Screen lock does not stop the app; no handler resets state. |
| Survives phone loss | 🟢 | Nothing clears `scene` on disconnect; only a no-round Scene does. |
| Recovery after restart deterministic | 🟠 | Deterministic but *empty*: always "Waiting for round". Outbox/manifest/snapshot restore; Scene does not. The phone-side Garmin transport has no republish-on-reconnect hook yet (Apple's `AppleWatchTransport.republishLatestScene` has no Garmin equivalent), and the watch never sends `REQUEST_LATEST_SCENE` although `caddy-watch.js:355` already answers it. |
| Start/resume/end explicit | 🟠 | Start = first Scene with a round; end = Scene with no round. The watch cannot start or end a round itself — by design. |
| Preview cannot become live | 🟢 | No preview concept on the watch. |
| Stale rounds cannot silently become active | 🔴 | `receiveScene` (lines 260-263) only rejects an older revision **of the same round**. A late/queued Scene for a *previous* round, or a no-round Scene, replaces the current one unconditionally (GA-011). |

**Competing state variables searched:** `currentHole/activeHole/previewHole/selectedHole/gpsHole/resumeHole/lastHole/watchHole` — none exist. Hole-ish state found: `scene.holeNumber()` (authoritative), `GarminPlayState.hole` (set by `enter()`, never read — vestigial, P3), `GarminMapView.framedHoleNumber` (camera cache, deliberate), `GarminLockedShot.holeNumber` (record, deliberate), `GarminMapDownloader.inFlight` keys (fetch bookkeeping — **accidental second source of "which hole" for the response**, GA-004).

---

## 12. AUTHORITATIVE SCENE audit

| Check | Status | Evidence |
|---|---|---|
| Scene has identifiable source | 🟢 | Only `onPhoneAppMessage` → `receiveScene`. |
| Associated with correct course | 🟢 | `course.key` in Scene; map store checks `manifest.courseKey.equals(courseKey)` before serving a bitmap. |
| Scene/hole explicit | 🟢 | `hole.number`. |
| Scene revision known | 🟢 | `revision()`; defaults to 0 when missing (🟠 a missing revision is treated as 0 rather than rejected). |
| Stale scene detectable | 🟠 | Within a round only. |
| Incompatible versions cannot merge | 🟢 | `schemaVersion == 1` gate (`isSupported`); an unsupported Scene is dropped silently — no UI (P2). |
| Missing scene data explicit | 🟢 | All accessors nullable; views draw "-" / "No round". |
| Partial scene explicit | 🟠 | Partial values are drawn as "-" with no explanation of why. |
| Preview cannot overwrite live | n/a | |
| Scene changes cannot corrupt active round | 🟢 | Scene replaces wholesale; `playState.enter()` on hole change; outbox reconciled. |

One anti-pattern per §12's last line: `mapsExpectedCount()` (line 72-79) reads the manifest's hole count **without** checking that the manifest's course matches the Scene's course, while `mapsHeldCount()` does check. A manifest for course A plus a Scene for course B yields "Receiving course 0/18" (part of GA-003).

---

## 13. GPS → TRUSTED FIX audit

Flow found: `Position` event → `onPositionInfo` → accuracy band → `usable = accuracy ∈ [0,100]` → `lastFix` → `onFix` → `playState.update` + `moveTarget`. There **is** a validation layer (good). It does not feed `setCurrentHole()`; GPS never selects a course or hole on the watch (the phone does). 🟢 for the anti-pattern check.

| Check | Status | Evidence |
|---|---|---|
| GPS permission correct | 🟢 | |
| Startup delay handled | 🟠 | Nothing shown while acquiring; `localBubble()` is simply null → phone numbers shown. Silent, not explicit (GA-023). |
| GPS unavailable explicit | 🟠 | `QUALITY_NOT_AVAILABLE` → `lastFix = null` → phone numbers. No UI state says "no GPS". |
| Fix quality represented | 🟢 internal | Mapped to 8/25/75 m estimates. `QUALITY_POOR → 75 m` still counts as **usable** (≤ 100) — a "poor" Garmin fix will be sent as a `LOCK_AT` and drawn as the player dot (GA-012). |
| Accuracy used where needed | 🟢 | 100 m bound, 30 s age bound on `LOCK_AT`. |
| Stale fix detectable | 🔴 | `lastFix` is never aged out. If position callbacks stop (GPS lost, watch indoors) the last usable fix stays "the player" indefinitely for `playerPoint()`, `localBubble()` and the local `LOCKED` display; only the wire `LOCK_AT` checks age (GA-012). |
| Position jumps handled | 🟠 | No jump filter; the camera is re-framed only on hole change, so a jump moves the dot, not the map. Bubble recomputed on every fix. |
| GPS loss mid-round | 🟠 | See stale fix. |
| Bad fixes cannot overwrite trusted state | 🟢 | Unusable → `lastFix = null` (explicit downgrade). |
| Course/hole selection deterministic | 🟢 | Phone-driven; watch never infers. |
| GPS and map failure states separate | 🟢 | Independent code paths; map failure never touches `locationManager`. |

Timestamp precision: `Time.now().value() * 1000.0` (`GarminLocationManager.mc:72`, `GarminSessionManager.mc:396`) produces a **32-bit Float** ≈ 1.76e12, whose resolution at that magnitude is 2^17 ≈ 131,072 ms. See GA-005 — every "age" and "elapsed" comparison in the app is quantised to ~2 minutes.

---

## 14. MAP → VERSIONED ASSET audit

`GarminMapManifest { courseKey, version(ms), holes[ {holeNumber, asset, url, width, height, spatialReference(version 1, transform), green} ] }` — a genuinely versioned asset. 🟢 on shape.

| Check | Status | Evidence |
|---|---|---|
| Map belongs to correct course | 🟢 at serve time | `bitmapFor` checks course key. |
| Map belongs to correct hole | 🔴 | Image response is attributed to `inFlight.keys()[0]` (`GarminMapDownloader.mc:85-88`). Two holes can be in flight (hole changed while fetching), and `receiveManifest` clears bitmaps but not `inFlight`, so a late response from the old course lands in the new manifest's ready set (GA-004). |
| Map revision known | 🟢 | `version`; older package for same course is refused. |
| Stale map detectable | 🟢 | Version compare. |
| Corrupt map detectable | 🟠 | `makeImageRequest` returns null on decode failure → treated as "not ready", retried forever (GA-007). |
| Partial map represented | 🟢 | `readyHoles` set; "Receiving x/y". |
| Missing map represented | 🟢 | "Map not available" / "Loading map..." with "BACK for numbers". |
| Incompatible map cannot silently attach | 🟠 | `spatialReference.version == 1` gate ✅; hole-attribution bug ❌ (GA-004). |
| Map failure explicit UI | 🟠 | "Loading map..." never becomes "failed". |
| Map failure cannot cause GPS oscillation | 🟢 | Independent. |
| Assets usable offline | 🔴 | Bitmaps live in RAM only; every relaunch re-fetches via the phone's internet. A watch with no phone connection has **no map at all** after relaunch (by design, README "Storage/RAM discipline"; still a Local Caddy gap). |

GPS-available-but-no-map and map-available-but-no-GPS are distinguishable in code and (weakly) on screen: the map shows "Loading map..." vs. the map with no player dot. 🟠 — no explicit "no GPS" copy.

---

## 15. LOCAL CADDY audit — what runs on the watch alone

| Function | Local? | Evidence |
|---|---|---|
| Core active-play state | 🟠 | Held locally but *sourced* only from the phone; not persisted. |
| Current-hole state | 🔴 | Hole changes only via phone Scene. NEXT/PREVIOUS HOLE on the watch is a **command** (`sendSimple`); nothing changes until a Scene returns. Phone gone → hole cannot change. |
| Core GPS processing | 🟢 | Local fix, accuracy band, Bubble distance. |
| **Front / Centre / Back** | 🔴 | `NumbersView` draws `scene.distanceFrontM()` etc. — **the phone's numbers computed at the phone's location**. Apple Watch computes these locally ("WristDistances… the wrist is its own rangefinder", `WatchSessionManager.swift:83`) from `greenShape`; the Garmin manifest parser keeps only the green centre and drops `greenShape`/`tee`/`route` (`GarminMapManifest.fromDict` lines 114-123), so it *cannot* compute them (GA-009). |
| Required scene state | 🟠 | Present while the phone is up; not persisted. |
| Required map asset | 🔴 | Needs phone + internet on every launch (§14). |
| Bubble calculation/rendering | 🟢 | `GarminBubbleEngine` fully local, gated on engine-version agreement + snapshot + fix. |
| Input handling | 🟢 | Local. |
| Core navigation (Numbers ↔ Map) | 🟢 | Local. |
| Phone not required for every interaction | 🟠 | Aim drag/nudge and Bubble redraw are local; LOCK, hole nav, take-over need the phone to *complete*. |
| Network not required for every interaction | 🟢 | Only maps. |
| Phone loss does not destroy round state | 🟢 | Nothing clears on disconnect. |

**"Kill the phone" result (static):** Numbers face keeps last F/C/B (frozen at the phone's last position), target distance + club keep updating from watch GPS if a snapshot + engine agreement exist; map keeps showing the resident bitmap for the current hole only; LOCK shows LOCKED for ≤ 20 s then reverts and the command waits in the outbox; hole cannot be changed; on relaunch everything but the outbox/manifest/snapshot is gone.

---

## 16. BUBBLE audit

| Check | Status | Evidence |
|---|---|---|
| Bubble data locally available | 🟢 | Player snapshot persisted (`GarminPlayerStore`), fingerprint-validated on restore. |
| No network needed | 🟢 | |
| No phone needed for basic operation | 🟢 | Given snapshot + fix + a Scene target. |
| Associated with correct player/round/scene | 🟠 | Snapshot is per-device, not per-round; fingerprint carries no player id. A second player's phone pairing the same watch would overwrite the snapshot (acceptable: one watch, one player). |
| Revision/input identity known | 🟢 | Fingerprint + `engineVersion` exact-match gate (`GarminEngineVersion`). |
| Missing Bubble data explicit | 🟠 | Falls back to phone numbers silently (mirrors Apple; the spec prefers explicit). |
| Bubble from another course cannot be reused | 🟢 | Bubble is computed from current fix + current target; nothing course-scoped is cached. |
| Doesn't depend on unavailable phone state | 🟢 | |
| Rendering doesn't require phone's full scene | 🟢 | 168-point ring computed and projected locally. |

Parity: `dev/fixtures/bubble-engine-parity.json` has **never been run** against the Monkey C port (README, `UPLOAD.md` §5). The project's own stated completion bar for the engine is unmet (GA-021).

---

## 17. INPUT audit

Trace: physical → `CaddyInputDelegate` → `InputRouter.dispatch(InputAction.*)` → `onAction` → `GarminSessionManager.send*` / `GarminMapView.*` → outbox → phone.

| Input | Wired | Idempotent / guarded | Note |
|---|---|---|---|
| Touch drag/tap (map) | `onTouch` (guarded) | `dragEnd` sends one `AIM_AT` | **[VERIFY]** event shape (GA-013). Numbers face has no touch targets although `InputRouter.onTap` anticipates them. |
| SELECT | LOCK (numbers) / TAKE_OVER (ready) / aim enter-confirm (map) | `isPending(type)` blocks a second LOCK/TAKE_OVER while one is queued 🟢 | |
| BACK | cancel aim → back to numbers → dismiss rejection | **never returns false** → app cannot be exited with BACK (GA-008) | |
| MENU | Numbers ↔ Map | local | |
| UP/DOWN (`onNextPage`/`onPreviousPage`) | hole nav or aim nudge | `isPending` per type 🟢 | `onNextPage → PREVIOUS_HOLE`, `onPreviousPage → NEXT_HOLE` — inverted naming; confirm on hardware which physical button does what (P3). |
| LAP key | LOCK from map | `has :getKey` guarded | **[VERIFY]** reaches `BehaviorDelegate.onKey` (GA-013). |
| Lock/unlock | none | n/a | System-level; nothing resets. |
| Reset / Log shot / End round / Resume | not on the watch | n/a | By design (phone). |
| Repeated input | LOCK/NEXT/PREV/TAKE_OVER de-duplicated while pending; **AIM_AT is not** — repeated confirms queue multiple `AIM_AT` (each unique id, accepted in order; see GA-018). | | |
| Accidental input after lifecycle transition | `CaddyAppView.onUpdate` resets `showingMap/aiming/dragActive` when the face leaves PLAYING 🟢 | | |

---

## 18. COMMAND audit

`GarminCommand { commandId, roundId, baseRevision, createdAt, device:"garmin", type, payload }` — matches the Apple/JS contract. 🟢 on shape.

| Check | Status | Evidence |
|---|---|---|
| Command identity exists | 🟠 | `uuid()` = `"garmin-" + nowEpochMillis().toNumber() + "-" + Math.rand()`. The Float→Number conversion overflows 32-bit (1.76e12 ≫ 2^31), so the time component is constant/garbage and uniqueness rests entirely on an **unseeded** `Math.rand()`. If the PRNG restarts from the same seed on every app launch **[VERIFY]**, command ids repeat across relaunches and `caddy-watch.js:334` will answer `{accepted:true, duplicate:true}` for a genuinely new command — silent command loss (GA-005). |
| Type explicit | 🟢 | |
| Round identity included | 🟢 | |
| Revision included | 🟢 | `baseRevision`; phone rejects `future-revision`. |
| Duplicates detectable | 🟢 phone-side | `seenCommands` keyed by id (never scoped/cleared — lives for the JS context). |
| Stale commands detectable | 🟠 | Round-scoped discard ✅. **Within a round, a stale `AIM_AT` is not detectable**: the phone accepts any `baseRevision ≤ latest`. `reconcileOutbox` retries every idle command on each Scene, so an `AIM_AT` that was lost, then superseded by a newer accepted `AIM_AT`, is re-sent and **re-applied**, moving the target back (GA-018). |
| Out-of-order cannot corrupt | 🟠 | Relies on FIFO of `Communications.transmit` + retry order (README says so explicitly). Retry breaks FIFO as above. |
| Command failure explicit | 🔴 | `lastRejection` is stored and dismissable but **never drawn** by `NumbersView`, `StatusView` or `GarminMapView` — a marshal rejection is invisible; the LOCK button just goes back to "LOCK" (GA-024). |
| Immediate ack not assumed | 🟢 | `GarminLockedShot` is explicit optimistic intent with 20 s expiry and rejection discard. |
| Unsynchronised commands safe on disconnect | 🟢 | Persisted outbox; round-scoped discard on next Scene. |

---

## 19. ID + REVISION audit (P0 check)

| Boundary | Could data be applied to the wrong course/hole/round/revision? | Source → Destination | Missing identity | Possible failure | Recommended invariant |
|---|---|---|---|---|---|
| GPS → Scene | No | `Position.Info` → `playState.player` | n/a | Stale fix used as current (GA-012) | Age-out `lastFix` (e.g. > 30 s ⇒ null) so *all* consumers share the trust bound `LOCK_AT` already has. |
| Scene → Map | **Yes** | `makeImageRequest` response → `residentBitmaps[hole]` | Response carries no hole/course; attribution by "first in-flight key" | Wrong hole's raster under the right overlays; persisted as "ready" (GA-004) | Allow exactly one in-flight fetch; record `{courseKey, version, holeNumber, url}` at request time; drop the response if any of them differ from the *currently requested* one; clear `inFlight` on manifest change. |
| Scene → Local Caddy | Partly | `receiveScene` | Cross-round ordering | Old round's late Scene replaces new round (GA-011) | Reject a Scene whose `roundId` differs **and** whose revision/timestamp is older than the held one; or have the phone stamp a monotonic `publishedAt` and compare that. |
| Caddy → Command | No | `GarminCommand.wire()` | — | Ids may repeat across launches (GA-005) | Seed the PRNG; build ids from a Double/Long timestamp + per-launch counter. |
| Command → Phone | Partly | outbox retry | No "superseded-by" on `AIM_AT` | Stale aim re-applied (GA-018) | Drop older pending `AIM_AT` when a newer one is enqueued; or include a per-type sequence the phone can compare. |
| Phone → Watch | Partly | `onPhoneAppMessage` | Acks/manifests carry no round id | A manifest for course A during a Scene for course B ⇒ "Receiving 0/18" (GA-003) | `mapsExpectedCount()` must check `manifest.courseKey == scene.courseKey()` like `mapsHeldCount()` does. |

---

## 20. PHONE boundary audit

| Watch → phone dependency | Class |
|---|---|
| Scene (round/hole/F/C/B/target/controls/surface) | **required for core active play** |
| Map manifest + per-hole image URL | required only for the map face |
| Player snapshot | required for local Bubble (cached after first receipt) |
| ACK | required to *confirm* LOCK/aim/hole change; local UI is optimistic for LOCK only |
| TAKE_OVER / HAND_BACK | required for driving-surface handover |
| `watchMapHave` / `watchPlayerHave` reports | informational |

Flows of the "WATCH → PHONE → SERVER → PHONE → WATCH" shape for things that should be local: **hole change** (watch command → phone Marshal → Scene → watch) and **front/centre/back** (phone computes, watch displays). Both are documented as Phase 1 design, but they are exactly what §20 says to flag. The Apple wrist already does F/C/B locally, so this is a parity gap rather than a shared design choice.

**And the phone side of this boundary does not exist yet:** `GarminTransport.swift:send()` (line 221-233) and the Java twin return failure unconditionally because the Connect IQ Mobile SDK is not linked. Every Scene publish to a Garmin currently ends in `completion(false)`. This is GA-001.

---

## 21. Offline / disconnection tests (static reasoning; no runtime evidence)

**Test A — phone disconnected before round.** Round cannot start (no Scene). Scene cannot load. GPS does not start (gated on Scene). Bubble cannot run (no target). User can navigate nothing but sees "Waiting for round". Local input: BACK dismisses nothing; SELECT does nothing. → **Nothing works; by design, but the user gets no hint that a phone is needed** (StatusView says only "Waiting for round"). 🟠

**Test B — phone disconnects during round.** Round continues (Scene retained). Current hole stays correct and cannot change. Map remains for the resident hole only. Bubble/target distance keep tracking GPS. Commands queue durably; retried ≥ ~10 s (quantised to ~2 min, GA-005) after each Scene. On reconnect, the next Scene reconciles (discard other rounds, retry stale). 🟢 mostly; 🟠 "LOCKED" reverts after 20 s with no explanation.

**Test C — phone reconnects with different state.** Same round, newer revision → phone wins ✅. Same round, older revision (impossible unless replayed) → ignored ✅. Different round → phone wins unconditionally, even if older (GA-011). No round → everything wiped, GPS stopped ✅ (phone is authority). Duplicate commands: prevented by phone `seenCommands` ✅; false duplicates possible (GA-005).

---

## 22. Lifecycle audit

Connect IQ watch apps are foreground-only: leaving the app (watch face, another activity, BACK-out) calls `onStop` and the process ends; there is no background/foreground pair for a watch-app **[GARMIN-DOC, VERIFY]**.

| Transition | Round | Scene | Hole | Revision | GPS | Map | Pending commands |
|---|---|---|---|---|---|---|---|
| launch | none | none | none | none | off | manifest restored, bitmaps none, `readyHoles` restored (claims held) | restored from Storage |
| first Scene | set | set | set | set | started | fetch on map view only | reconciled |
| lock / unlock | kept | kept | kept | kept | on | kept | kept |
| phone disconnect | kept | kept | frozen | kept | on | resident only | queued |
| GPS loss | kept | kept | kept | kept | `lastFix` **kept until next event** | kept | kept |
| GPS restore | — | — | — | — | updated | — | — |
| phone reconnect | Scene-driven | replaced if newer/other round | Scene | Scene | on | — | retried |
| app restart | **lost** | **lost** | **lost** | **lost** | off | manifest kept | kept |

Handler that resets to defaults without proving the round ended: `receiveScene` on a no-round Scene (lines 247-257) — acceptable since the phone is the authority, but note it also fires for a *malformed* Scene that merely lacks `roundId` (a Scene with a bad `roundId` type becomes "no round" and wipes the watch). 🟠

---

## 23. Failure-state audit — "does the user reach a deliberate, understandable state?"

| Scenario | State reached | Understandable? |
|---|---|---|
| GPS permission denied | Position call may throw → `started=false`, no fix, phone numbers | 🟠 silent |
| No fix / slow fix | phone numbers, no player dot | 🟠 silent |
| Poor accuracy | 75 m treated as usable | 🔴 wrong-side-of-safe (GA-012) |
| Stale fix | last fix reused | 🔴 (GA-012) |
| Sudden jump | dot jumps, Bubble recomputed | 🟠 |
| GPS loss mid-round / restore | as above | 🟠 |
| Map missing | "Map not available / BACK for numbers" | 🟢 |
| Map partial | "Receiving course x/y" (but never progresses on its own) | 🔴 (GA-003) |
| Map corrupt / loading failure | "Loading map..." forever, 1 Hz re-request | 🔴 (GA-007) |
| Map stale revision | older package refused | 🟢 |
| Map wrong hole / wrong course | possible via in-flight attribution | 🔴 (GA-004) |
| Course unavailable | Scene without course → "-" values | 🟠 |
| Hole unavailable | "HOLE -" | 🟠 |
| Partial course data | "-" values | 🟠 |
| Invalid scene | dropped silently (`isSupported`) | 🟠 |
| Scene revision mismatch | older same-round ignored | 🟢 |
| Phone disconnected / reconnects | see §21 | 🟠 |
| Server unavailable / timeout / malformed / auth (maps) | retry loop | 🔴 (GA-007) |
| Lock / unlock / background / foreground / termination / restart | see §22 | 🟠 restart loses round |
| Low memory | untested; large bitmap risk on FR 55 | 🟠 (GA-014) |

---

## 24. Memory audit

| Pattern | Found? | Location |
|---|---|---|
| Whole-course loading when hole is enough | Manifest for all 18 holes (incl. 8 transform doubles each) held in RAM and persisted as one Storage value. Small (a few KB) but see Storage limits **[VERIFY]**. | `GarminMapStore.persistManifest` |
| Duplicated map data | No — one resident bitmap (`RESIDENT_BITMAP_LIMIT = 1`). 🟢 | |
| Duplicated scene data | No — `GarminScene` wraps the raw dictionary; accessors read through. 🟢 | |
| Duplicated Bubble data | `localBubble()` recomputes a fresh 168-point ring on **every** `onUpdate` (1 Hz) for both Numbers and Map faces — transient garbage, not retention. | `NumbersView.mc:64`, `GarminMapView.mc:124` |
| Old scene revisions retained | No. | |
| Old maps retained | No (evicted on manifest change). | |
| Commands retained indefinitely | Bounded by round discard; a rejected command is removed on ACK. `answeredHandovers` dictionary grows for the process lifetime (tiny). | `GarminSessionManager.mc:41` |
| Large GPS histories | None. 🟢 | |
| Repeated JSON parsing | None (dictionaries arrive parsed). 🟢 | |
| Large strings | None. | |
| Excessive rendering allocation | `drawRing` builds a 168-element array of 2-element arrays per frame; `imageBoxOfRing` another 168 projections when re-framing. Per frame at 1 Hz. | `GarminMapView.mc:275-289` |
| **Decoded bitmap size** | `makeImageRequest` asks for `:maxWidth/:maxHeight = hole.width/height` — the bake ceiling is **448 × 1536 px** (`scripts/gd-watch-map-core.js:57-58`). On CIQ 3.x MIP devices the decoded bitmap lives in the app heap, and a 448×1536 palette bitmap is on the order of hundreds of KB **[VERIFY]** against FR 55 / S62 / fenix 6 `appMemory`. | `GarminMapDownloader.mc:55-58` (GA-014) |

---

## 25. Performance / battery audit

| Item | Frequency | Trigger | Cacheable? | Needed off-screen? | Note |
|---|---|---|---|---|---|
| `WatchUi.requestUpdate()` | 1 Hz, whole app lifetime incl. "Waiting for round" | `Timer` in `onStart` | — | No; stop on non-playing faces | GA-020 |
| `localBubble()` (engine + 168-pt ring + 2 smoothing passes) | every frame (1 Hz), ×1 in Numbers, ×1 in Map (+ once more in `restingCamera` on hole change) | onUpdate | Yes: key on (fix, target, snapshot fingerprint, heldClub) | No | GA-020 |
| Ring projection (168 × Web-Mercator `pow/log/tan`) | every map frame | onUpdate | Yes | No | |
| GPS | `LOCATION_CONTINUOUS` (≈1 Hz) while a round exists | Scene | — | — | Reasonable for golf. |
| `makeImageRequest` retry | up to 1 Hz on failure, unbounded | onUpdate → `bitmapFor` | — | — | GA-007; also BLE/phone battery. |
| Redraw on drag | each touch event → `moveTarget` (1-2 engine calls) + redraw | touch | — | — | Acceptable, mirrors Apple. |
| Network | only maps | — | — | — | |

No tight loops found. Launch path is light (three Storage reads, no network).

---

## 26. Hardware vs simulator

| Area | Simulator evidence | Physical evidence | Static evidence |
|---|---|---|---|
| GPS (`Position.Info.accuracy` shape, `QUALITY_*` behaviour) | none | none | code handles both shapes |
| Bluetooth / phone messaging (`registerForPhoneAppMessages`, `transmit`, message queuing while app closed) | none | none | API calls look correct **[VERIFY]** |
| `makeImageRequest` on CIQ 3.x vs 4.x (BitmapResource vs BitmapReference, memory placement, HTTPS requirement, `:maxWidth/:maxHeight`) | none | none | typed callback compiles |
| Physical buttons (`onNextPage` direction, `KEY_LAP` via BehaviorDelegate) | none | none | guarded |
| Touch events (`onTouch` shape) | none | none | guarded; README calls it "the single least-certain piece" |
| Lock/unlock | none | none | no handlers |
| `drawBitmap2` availability / option keys | none | none | `has`-guarded; keys suspect |
| Storage limits per device | none | none | README item 6 open |

**[COMMUNITY]** Forum reports of simulator/firmware divergence exist for `makeImageRequest` caching and for touch-event delivery differences between device generations; treat as risk evidence, not rules. There is **no** simulator or hardware evidence of any kind for this app (`UPLOAD.md` §0: "It has never run").

---

## 27. Monetisation audit

Contextual hits in `garmin/`: `UNLOCK` (the command name only). No buy/purchase/subscribe/donate/tip/premium/payment/PayPal/Stripe in watch source, resources or manifest.

| Question | Answer |
|---|---|
| Is the watch app monetised? | No in-app monetisation on the watch. |
| Is functionality paywalled? | **Yes, on the phone:** Garmin pairing and every `send()` are gated on an active Clarity membership (`scripts/clarity-garmin.js` header; `GarminTransport.swift:161-176`, `.java:83-101`). A non-member installs the watch app and gets "Waiting for round" forever. |
| Donations/tips | None. |
| External payment | Clarity membership (App Store / Play billing via `clarity-payments.js`) — outside Garmin. |
| Store monetisation declaration accurate? | 🟠 Listing not drafted. The Connect IQ listing should state that a paid Clarity Caddy membership is required (Garmin's review guidelines ask that paid/companion requirements be disclosed **[GARMIN-DOC, VERIFY]**). |
| Wording consistent app ↔ listing | 🟠 Watch shows nothing about membership; phone says "Membership required". Add a line to the watch's no-round face or the listing (GA-015/016). |

---

## 28. Intellectual property / branding

| Asset | Finding |
|---|---|
| Launcher icon | Clarity Caddy pin, own artwork derived from the iOS app icon (README). 🟢 |
| Other images / fonts / audio | None; system fonts only. 🟢 |
| Course imagery | Baked from the project's own course data (`gd-watch-map-core.js`), served from the project's bucket. 🟢 — confirm the underlying map data licence permits redistribution to wearables (same question as the Apple Watch; not Garmin-specific). |
| Third-party libraries | None. 🟢 |
| Garmin branding | Only the words "Garmin", "Connect IQ" in comments/docs and phone settings copy ("Install Clarity Caddy on the watch from the Connect IQ store"). No claim of Garmin ownership, sponsorship, endorsement or certification found. 🟢 |
| Device imagery | None in repo. Store screenshots must not use Garmin device frames without permission **[GARMIN-DOC, VERIFY]**. |

---

## 29. Store listing audit

No listing text, screenshots or category exist in the repo; `UPLOAD.md` §7 lists what the portal asks for. Every listing check is therefore 🟠 REVIEW (not yet produced). Specific requirements the listing must meet, from the code:

- Say plainly that the Clarity Caddy phone app **and an active membership** are required, and that the watch shows "Waiting for round" until a round is started on the phone.
- Justify `Positioning` (distances/lock from the wrist) and `Communications` (phone link, map images).
- Screenshots must be real simulator/device captures — none exist yet.
- Device compatibility must match the five products.
- Privacy policy URL: `privacy.html`, updated per §8.
- Support/contact: `support.html` exists.

### Reviewer Testability Report

| Requirement to exercise core features | Present? | How a reviewer could do it |
|---|---|---|
| Physical golf course / GPS | Simulator can play back a GPX/FIT track **[GARMIN-DOC]**; hardware needs a mapped course. | Provide a demo course with baked watch maps and a GPX file near it. |
| External phone state | Reviewer must run the Clarity Caddy phone app, sign in, start a round, pair the Garmin. | Provide a test account **with membership** and step-by-step instructions. |
| External account | Clarity account + paid membership. | Test account. |
| External hardware | A supported Garmin paired to Garmin Connect. | Unavoidable for hardware review; simulator path covers layout only — but the simulator cannot receive phone messages from the real Clarity app, so **the simulator cannot show a round at all**. |
| Special setup | Course package must exist in `course_watch_maps` for the demo course. | Pre-bake it. |
| Unavailable service | **The phone cannot send to a Garmin at all today** (SDK not bundled). | Nothing a reviewer can do → GA-001. |

**Verdict:** no reviewer path exists today. This is a P0 under the spec ("Reviewer cannot access core functionality and no review path exists").

---

## 30. Binary / package forensic audit

**Not possible.** No `.iq` exists in the repository or this environment, and no SDK is available to produce one. Nothing here can be tied to commit `c611f66`. Before upload, on the Mac:

```bash
cd garmin && ./build.sh package
shasum -a 256 build/ClarityCaddy.iq; ls -l build/ClarityCaddy.iq
git rev-parse HEAD
# then record commit, SDK version (monkeyc --version), timestamp, filename, SHA-256, size
# in this file's §4 provenance table, and keep the .iq alongside the record.
unzip -l build/ClarityCaddy.iq   # confirm one .prg per product + manifest; nothing unexpected
strings build/ClarityCaddy.iq | grep -Ei 'http|key|token|secret' # expect only the asset endpoint fragment if any
```

---

## 31. Test matrix (static results)

| Scenario | Expected authority | Expected behaviour | Evidence | Result |
|---|---|---|---|---|
| Normal play | Round/Scene | Normal operation | code path complete; never executed | 🟠 |
| GPS unavailable | Scene/last trusted state | Explicit GPS state | falls back to phone numbers silently | 🟠 |
| GPS inaccurate | Trusted fix | No bad jump | 100 m bound; POOR=75 m accepted; no age-out | 🟠 |
| Map unavailable | GPS/Scene | Explicit map failure | "Loading map..." forever | 🔴 |
| Map stale | Scene revision | Reject/refresh | version compare | 🟢 |
| Phone disconnected | Local Caddy | Continue locally | Scene retained; hole frozen; F/C/B frozen | 🟠 |
| Phone reconnect | Revision/commands | Reconcile | same-round guard; cross-round unguarded | 🟠 |
| Bubble unavailable | Local scene | Explicit Bubble state | silent fallback to phone numbers | 🟠 |
| Course unavailable | Round | Controlled failure | "-" values | 🟠 |
| Hole ambiguous | Scene/GPS trust | No silent switch | watch never infers hole 🟢; map hole attribution ❌ | 🔴 |
| Watch locked | Round | State preserved | no handlers reset | 🟢 (static) |
| App restarted | Round | Deterministic resume | deterministic *loss* of Scene | 🟠 |
| Old phone command | Revision | Reject/ignore | n/a (phone→watch has no commands); old Scene: same-round only | 🟠 |
| Duplicate command | Command ID | Idempotent | phone dedupes; ids may repeat across launches | 🟠 |

---

## 32. Findings

### GA-001
- **Severity:** P0 · **Status:** BLOCK · **Category:** Store / Architecture
- **Location:** `ios/App/App/Wearables/Garmin/GarminTransport.swift` `send()` (lines 221-233, `completion(false)` unconditionally); `android/.../garmin/GarminTransport.java` (SDK calls commented out); `garmin/UPLOAD.md` §5 last bullet.
- **Finding:** The Connect IQ Mobile SDK is not bundled in either phone build. The phone cannot send a Scene, manifest, player snapshot or ACK to any Garmin, and cannot receive commands from one.
- **Evidence:** `UPLOAD.md`: "the phone cannot talk to a watch at all… Nothing below matters until this is done." Both transports' `availableDevices()` return `sdkLinked:false`.
- **Requirement type:** Official Garmin requirement **[VERIFY exact wording]** that submitted apps function as described / companion requirements be met, plus the spec's P0 "Reviewer cannot access core functionality".
- **Impact:** Every installer, including the Store reviewer, sees "Waiting for round" forever. Rejection is near-certain.
- **Recommendation:** Vendor the Connect IQ Mobile SDK on iOS (xcframework + URL scheme) and Android (Maven), implement the commented calls, and prove one round end-to-end on hardware before any upload. Also add a watch-side hint on the no-round face ("Start a round in Clarity Caddy on your phone").

### GA-002
- **Severity:** P0 · **Status:** BLOCK · **Category:** Runtime
- **Location:** whole `garmin/` build; `garmin/UPLOAD.md` §0 ("It has never run"); `garmin/README.md` line 3 (stale "never been compiled").
- **Finding:** No runtime evidence of any kind — never launched in the simulator, never on a device.
- **Requirement type:** Spec §33 "Core application crash — treat as blocker unless strong evidence proves otherwise"; Garmin review rejects apps that crash on launch **[GARMIN-DOC]**.
- **Impact:** Unknown crash surface (touch API shape, `KEY_LAP`, `drawBitmap2` options, Storage limits, bitmap memory on FR 55).
- **Recommendation:** Run in the simulator on all five devices with a GPX track and a fake phone message (the simulator can inject `Communications` messages), then on at least one CIQ-3 MIP device and one S70. Record evidence in this file.

### GA-003
- **Severity:** P0 · **Status:** BLOCK · **Category:** Architecture / Runtime
- **Location:** `garmin/source/Session/GarminSessionManager.mc` `face()` lines 85-95 and `mapsExpectedCount()` lines 72-79; `garmin/source/Maps/GarminMapStore.mc` `bitmapFor()` (only caller: `GarminMapView.onUpdate` line 110).
- **Finding:** The RECEIVING face is a dead end. Hole images are fetched only from the map view while PLAYING. When a round exists but the phone is driving, `face()` returns RECEIVING while `mapsHeldCount() < mapsExpectedCount()`, and nothing ever downloads, so the watch shows "Receiving course 0/18" indefinitely and never reaches READY, where SELECT would send TAKE_OVER. `mapsExpectedCount()` also ignores the manifest's course key, so a manifest for another course produces the same dead end.
- **Evidence:** static call-graph; no other call site of `requestHole`/`bitmapFor`.
- **Requirement type:** Caddy architectural invariant; spec P0 "Critical failure state causes infinite loading".
- **Impact:** Watch-initiated take-over is impossible whenever a manifest is present; only a phone-initiated handover escapes.
- **Recommendation:** Smallest fix: make READY not depend on maps (maps are lazy on Garmin by design), i.e. drop the RECEIVING branch or gate it on `readyHoleCount(courseKey) > 0`; and check `manifest.courseKey` in `mapsExpectedCount()`. Alternatively prefetch the current hole from `receiveScene`.

### GA-004
- **Severity:** P0 · **Status:** BLOCK · **Category:** Architecture (ID + revision)
- **Location:** `garmin/source/Maps/GarminMapDownloader.mc` `onImageResponse()`/`currentlyAwaitedHole()` lines 75-88; `GarminMapStore.receiveManifest()` lines 83-96 (does not clear `downloader.inFlight`).
- **Finding:** A downloaded raster is attributed to "the first key in `inFlight`". `inFlight` can hold more than one hole (hole changes while a fetch is pending, since `bitmapFor` is called every frame for the *current* hole) and survives a manifest/course change. Dictionary key order is not guaranteed. The image can be stored, drawn and **persisted as ready** under the wrong hole or course.
- **Evidence:** static; README's "only one is ever in flight" claim is not enforced in code.
- **Requirement type:** Caddy invariant (§14 "Incompatible map cannot silently attach to scene"); spec P0 "Wrong course/hole data can silently become authoritative".
- **Impact:** Player aims on hole 3's picture while overlays and coordinates are hole 4's; the mis-aim is sent to the phone as a valid `AIM_AT`.
- **Recommendation:** Keep a single `awaiting = {courseKey, version, holeNumber}` set at request time, refuse new requests while one is pending, and discard any response whose `awaiting` no longer matches the current scene hole/manifest. Clear it in `receiveManifest`.

### GA-005
- **Severity:** P1 · **Status:** REVIEW · **Category:** Runtime / Architecture (command identity)
- **Location:** `GarminSessionManager.mc` `nowEpochMillis()` lines 395-397 and `uuid()` lines 404-406; `GarminLocationManager.mc:72`; consumers `GarminLockedShot.isStillShowing`, `GarminOutbox.staleCommandIds`, `GarminLocationObservation.build`.
- **Finding:** `Time.now().value() * 1000.0` is `Number × Float` → a 32-bit `Float` ≈ 1.76e12 whose resolution is 2^17 ≈ 131 s. Every age/elapsed test in the app (20 s lock expiry, 10 s retry idle, 30 s fix age) is quantised to 0 or ~131 s. `uuid()` then calls `.toNumber()` on that Float, overflowing 32-bit, so the id's time component is meaningless and uniqueness rests on an unseeded `Math.rand()`.
- **Evidence:** Monkey C numeric semantics (Float is 32-bit; a Float literal is Float; Number×Float promotes to Float) **[ENG-REC, VERIFY by printing `nowEpochMillis()` in the simulator]**. Compare `GarminMapManifest.mc:37-38`, which already notes the same overflow hazard for the manifest version and uses Double.
- **Requirement type:** Engineering recommendation + human verification.
- **Impact:** If `Math.rand()` restarts from a fixed seed per launch **[VERIFY]**, ids repeat across relaunches and the phone's `seenCommands` returns `accepted:true, duplicate:true` for a real new LOCK/NEXT_HOLE — silent loss. Timing bugs: LOCKED badge may vanish immediately or linger; retries fire late.
- **Recommendation:** Use `Time.now().value().toDouble() * 1000.0d` (or `toLong() * 1000`), format ids from a Long/Double plus a per-launch counter, and seed with `Math.srand(Time.now().value())`.

### GA-006
- **Severity:** P1 · **Status:** REVIEW · **Category:** Device
- **Location:** `garmin/source/Maps/GarminMapView.mc` `drawBitmapCropped()` lines 231-247.
- **Finding:** Scaled drawing uses `dc.drawBitmap2` with `:destWidth/:destHeight`, `has`-guarded with a plain unscaled `drawBitmap` fallback. Overlays (player, target, ring, aim line) are always placed through the scaled camera transform, so on the fallback path they are misaligned with the picture whenever `camera.scale ≠ 1` — which is nearly always (scale is `viewWidth/imageWidth` up to 3×).
- **Evidence:** **[VERIFY]** My recollection: `drawBitmap2` exists from CIQ 4.2.1, so Approach S62, fenix 6 and Forerunner 55 (CIQ 3.x) take the fallback; and the documented scaling option is `:transform => AffineTransform`, not `:destWidth/:destHeight`, so even the S70 may draw the bitmap unscaled.
- **Requirement type:** Garmin documentation guidance + human verification.
- **Impact:** Wrong-looking map on 3 of 5 devices; possible mis-aim.
- **Recommendation:** On the Mac, open the SDK's `Dc.html` and confirm the option keys and `Since` level; either use `AffineTransform` scaling, or pre-request the bitmap at exactly the display size (`:maxWidth/:maxHeight` = scaled size) so `drawBitmap` at 1:1 is correct on every device, or drop devices that cannot scale.

### GA-007
- **Severity:** P1 · **Status:** REVIEW · **Category:** Runtime / Performance
- **Location:** `GarminMapStore.bitmapFor()` line 50 → `GarminMapDownloader.requestHole()`; `ClarityCaddyApp.onTick` (1 Hz redraw).
- **Finding:** Any failed image fetch (non-200, decode failure, no phone, no internet, 404 from the proxy) is retried on the next frame with no backoff, no attempt cap and no failure state. UI stays on "Loading map...".
- **Requirement type:** Engineering recommendation; spec prefers explicit failure over hidden retry.
- **Impact:** Infinite loading state; continuous BLE/network traffic while the map face is open; battery.
- **Recommendation:** Track `lastFailure{holeNumber, code, at}`; back off (e.g. 5 s, 15 s, 60 s), show "Map failed (code) — BACK for numbers", and reset on manifest change or hole change.

### GA-008
- **Severity:** P1 · **Status:** REVIEW · **Category:** UX / Garmin
- **Location:** `garmin/source/CaddyInputDelegate.mc` `onBack()` lines 43-46; `onAction` BACK branch lines 164-177.
- **Finding:** `onBack` always returns `true`, so the system never pops the root view. The user cannot leave the app with BACK from the Numbers face.
- **Requirement type:** Garmin UX guideline that BACK exits a watch app from its top-level view **[GARMIN-DOC, VERIFY wording]**; reviewers do test this **[COMMUNITY]**.
- **Impact:** Trapped user; likely review remark.
- **Recommendation:** Return `false` from the BACK handler when on the Numbers face with nothing to dismiss (or show a "Exit?" confirmation).

### GA-009
- **Severity:** P1 · **Status:** REVIEW · **Category:** Architecture (Local Caddy)
- **Location:** `garmin/source/UI/NumbersView.mc` lines 50-57 (`scene.distanceFrontM()` etc.); `garmin/source/Maps/GarminMapManifest.mc` `fromDict` lines 114-123 (drops `greenShape`, `tee`, `route`); compare `ios/App/ClarityCaddyWatch/WatchSessionManager.swift:83` and `app/js/watch-map-delivery.js` `manifestReference()` which ships them.
- **Finding:** Front/centre/back on the Garmin are the phone's numbers at the phone's position, refreshed only when a Scene arrives. The Apple wrist computes them locally from `greenShape`; the Garmin manifest parser discards `greenShape` so it cannot.
- **Requirement type:** Caddy architectural invariant (Local Caddy) + parity with the existing Apple implementation.
- **Impact:** With the phone in a bag/cart, F/C/B are wrong by the phone-to-player distance; with the phone disconnected they freeze.
- **Recommendation:** Parse `reference.greenShape`/`tee`/`route` in `GarminMapManifest.fromDict` and port `WristDistances` (front/back = nearest/farthest green-outline vertex along the bearing) so the Numbers face uses the trusted local fix.

### GA-010
- **Severity:** P1 · **Status:** REVIEW · **Category:** Architecture (Round)
- **Location:** `GarminSessionManager.initialize()` (no Scene restore); `GarminTransport.swift` (no republish on reachability); `app/js/caddy-watch.js:355` (`REQUEST_LATEST_SCENE` already supported, never sent by the watch).
- **Finding:** After any relaunch the watch has no round until the phone happens to publish a new Scene.
- **Requirement type:** Caddy invariant (round survives restart deterministically) + engineering recommendation.
- **Impact:** "Waiting for round" mid-round after glancing at the watch face.
- **Recommendation:** Send `{command: {type:"REQUEST_LATEST_SCENE", …}}` on start (and when `scene == null`), and republish the latest Scene from the phone on Garmin device-connected events once the SDK is wired.

### GA-011
- **Severity:** P1 · **Status:** REVIEW · **Category:** Architecture (Scene)
- **Location:** `GarminSessionManager.receiveScene()` lines 243-263.
- **Finding:** The revision guard applies only when `roundId` matches. A Scene for a different round — including a delayed one from an *older* round — or a no-round Scene replaces the current Scene unconditionally and (for no-round) wipes lock state and stops GPS.
- **Requirement type:** Caddy invariant ("no stale source silently overwrites higher-authority state").
- **Impact:** Depends on whether the Mobile SDK guarantees in-order delivery of queued messages after reconnect **[VERIFY]**. If not, a queued end-of-round Scene from round A can arrive after round B's first Scene.
- **Recommendation:** Have the phone stamp Scenes with a monotonic `publishedAt`/global sequence and reject anything older than the held one regardless of round; treat a Scene with an unparsable `roundId` as invalid, not as "no round".

### GA-012
- **Severity:** P1 · **Status:** REVIEW · **Category:** Runtime (GPS trust)
- **Location:** `GarminLocationManager.mc` lines 74-99; `GarminSessionManager.playerPoint()`/`localBubble()`.
- **Finding:** (a) `lastFix` has no age-out; it remains "the player" until another position event arrives. (b) `QUALITY_POOR` maps to 75 m and counts as usable, so a poor fix drives the dot, the Bubble and `LOCK_AT`. (c) The "accuracy in metres" branch is dead (`accuracy` is always the quality enum **[VERIFY]**).
- **Requirement type:** Caddy invariant (trusted fix) + engineering recommendation.
- **Impact:** Stale or poor position presented and locked as trusted.
- **Recommendation:** Age `lastFix` (null after 30 s without an event); treat `QUALITY_POOR` as unusable or at least mark the display; delete the dead branch.

### GA-013
- **Severity:** P1 · **Status:** REVIEW · **Category:** Device / Runtime
- **Location:** `CaddyInputDelegate.onTouch()` lines 116-142; `onKey()` lines 91-102; `onNextPage/onPreviousPage` lines 66-82.
- **Finding:** Touch-event API shape, `KEY_LAP` delivery through `BehaviorDelegate.onKey`, and the UP/DOWN ↔ next/previous-hole direction are all unverified. Guards prevent crashes but not wrong behaviour (e.g. no drag at all on the S70, no LOCK from the map on fenix 6).
- **Requirement type:** Human verification required.
- **Recommendation:** Verify on the simulator per device, then on one touch and one button device; note the results here.

### GA-014
- **Severity:** P1 · **Status:** REVIEW · **Category:** Runtime (memory)
- **Location:** `GarminMapDownloader.requestHole()` lines 55-58; `GarminMapStore.persistManifest()` lines 117-141.
- **Finding:** Full-size rasters (up to 448×1536) are requested and decoded into app memory on CIQ 3.x devices; the 18-hole manifest is written as one Storage value. Neither has been checked against `appMemory` or Storage limits for FR 55 / S62 / fenix 6 **[VERIFY]**.
- **Requirement type:** Engineering recommendation + human verification (README item 6 already open).
- **Impact:** Out-of-memory crash on the map face on the smallest device; Storage write silently failing (caught) so the manifest is not persisted.
- **Recommendation:** Request at the display size needed (see GA-006), check `System.getSystemStats().usedMemory` in the simulator's memory view per device, and persist only the current-hole manifest entry if the full one exceeds the limit.

### GA-015
- **Severity:** P1 · **Status:** REVIEW · **Category:** Store (reviewer testability)
- **Location:** `scripts/clarity-garmin.js` (membership gate); `GarminTransport.*` `entitled` flag; `garmin/UPLOAD.md` §7.
- **Finding:** Core features need a paid membership, the phone app, a paired device and a course with baked maps. No reviewer instructions, test account, demo course or GPX exist.
- **Requirement type:** Garmin review guidance (reviewers must be able to test) **[GARMIN-DOC, VERIFY]**.
- **Recommendation:** Prepare a review kit: membership-enabled test account, demo course key, GPX near it, and numbered steps; put it in the Store "review notes".

### GA-016
- **Severity:** P1 · **Status:** REVIEW · **Category:** Privacy / Store
- **Location:** `privacy.html` §Location; Store listing (absent).
- **Finding:** Privacy policy does not mention wearables; the listing does not yet disclose the phone-app and membership dependency or justify permissions.
- **Requirement type:** Garmin submission requirements (privacy policy URL; accurate description) **[GARMIN-DOC]** + engineering recommendation.
- **Recommendation:** Add a "Watches" paragraph (what leaves the watch: GPS position at LOCK, aim point, map inventory; where it goes; retention) and write the listing per §29.

### GA-017
- **Severity:** P1 · **Status:** REVIEW · **Category:** Garmin package
- **Location:** `garmin/build.sh` (SDK auto-detect, no pin); `garmin/README.md:3`; `.github/workflows/structural-smoke.yml` (no `test:garmin`).
- **Finding:** No `.iq`, hash, size, SDK build or build log is recorded; the SDK is whatever the Mac has current; README contradicts UPLOAD.md; the Garmin unit tests are not in CI.
- **Requirement type:** Engineering recommendation (provenance for later bisection, spec §30).
- **Recommendation:** Pin `CIQ_SDK` in `build.sh` or a `.ciq-sdk-version` file, run `npm run test:garmin` in CI, fix the README header, and fill the §4 provenance table from the actual package before upload.

### GA-018
- **Severity:** P1 · **Status:** REVIEW · **Category:** Architecture (command ordering)
- **Location:** `GarminSessionManager.sendAim()` lines 193-200 (no pending check); `reconcileOutbox()`/`GarminOutbox.staleCommandIds()`; phone `caddy-watch.js:335` (only `future-revision` is rejected).
- **Finding:** Multiple `AIM_AT`s can be pending; a lost older `AIM_AT` is retried after a newer one was accepted and is applied again, since the phone accepts any `baseRevision ≤ latest`.
- **Requirement type:** Caddy invariant (out-of-order commands cannot corrupt state).
- **Impact:** Target jumps back to a stale aim after reconnect.
- **Recommendation:** When enqueuing an `AIM_AT`, remove older pending `AIM_AT`s (last-writer-wins on the watch), or have the phone reject an `AIM_AT` whose `baseRevision` is below the revision at which the last aim was applied.

### GA-019
- **Severity:** P2 · **Status:** REVIEW · **Category:** Runtime
- **Location:** `GarminMapStore.restore()` lines 165-167; `inventory()`; `GarminSessionManager.answeredHandovers`.
- **Finding:** `readyHoles` is restored from Storage although no bitmap is resident, so "Receiving 18/18" and the `watchMapHave` report claim holes the watch must still re-download; `answeredHandovers` is never pruned.
- **Recommendation:** Do not persist `readyHoles` (it is meaningless without the bitmaps), or rename the concept to "seen". Prune `answeredHandovers` on round change.

### GA-020
- **Severity:** P2 · **Status:** REVIEW · **Category:** Performance
- **Location:** `ClarityCaddyApp.onStart` (1 Hz timer for life); `NumbersView.onUpdate:64`; `GarminMapView.onUpdate:124`.
- **Finding:** Full Bubble engine + 168-point ring + projection every second on every face; timer runs on the no-round face too.
- **Recommendation:** Cache `localBubble()` keyed on (fix, target, snapshot fingerprint, heldClub); stop the timer outside PLAYING; only re-project the ring when the Bubble or camera changes.

### GA-021
- **Severity:** P2 · **Status:** REVIEW · **Category:** Architecture (Bubble parity)
- **Location:** `dev/fixtures/bubble-engine-parity.json`; `garmin/README.md` "Parity fixtures".
- **Finding:** Monkey C engine never validated against the shared fixtures — the project's own completion bar.
- **Recommendation:** Generate a `.mc` table from the fixtures and assert in the simulator (tolerances 0.1 m / 0.01° / 1e-7).

### GA-022
- **Severity:** P2 · **Status:** REVIEW · **Category:** UX
- **Location:** `resources-icons/35/`; `garmin/README.md` item 7.
- **Finding:** 35 px icon (S62, FR 55) is a downscale that the README itself calls "mush"; also `GarminScene.revision()` treats a missing revision as 0; `GarminPlayState.hole` is written but never read.
- **Recommendation:** Hand-simplified 35 px mark; reject a Scene with no revision; delete the unused field.

### GA-023
- **Severity:** P2 · **Status:** REVIEW · **Category:** UX
- **Location:** `StatusView`, `NumbersView`, `GarminMapView`.
- **Finding:** No explicit copy for "acquiring GPS", "no GPS", "phone not connected", "membership required" or "start a round on your phone". Every degraded state is a silent fallback.
- **Recommendation:** One status line on each face; the spec repeatedly prefers explicit failure.

### GA-024
- **Severity:** P1 · **Status:** REVIEW · **Category:** UX / Architecture (command failure explicit)
- **Location:** `GarminSessionManager.lastRejection` (set at `receiveAcknowledgement:323`, cleared in `dismissRejection`); no view reads it.
- **Finding:** A Marshal rejection (`marshal-rejected`, `invalid-location`, `future-revision`, `play-unavailable`) is never shown; the only visible effect is the LOCK button reverting.
- **Requirement type:** Caddy invariant ("Command failure is explicit").
- **Recommendation:** Draw `lastRejection.reason` on the Numbers face until BACK dismisses it (the dismiss path already exists).

### GA-025
- **Severity:** P3 · **Status:** PASS · **Category:** Security
- **Finding:** No secrets, credentials, dev endpoints, unexpected binaries or libraries in the watch source or resources. Map URLs are public-by-design and the proxy holds the only secret server-side. (Package not scannable — see §30.)

---

## 33-35. Blocker / risk / improvement lists

**P0 BLOCKERS:** GA-001 (phone SDK not bundled — no path for any user or reviewer), GA-002 (never run anywhere), GA-003 (RECEIVING dead end blocks watch take-over), GA-004 (map raster can attach to the wrong hole/course and be persisted as ready).

**P1 RISKS:** GA-005 (Float timestamps / command-id uniqueness), GA-006 (`drawBitmap2` fallback misalignment on CIQ 3.x devices; option keys), GA-007 (infinite map retry loop), GA-008 (BACK never exits), GA-009 (F/C/B not local; parity gap vs Apple), GA-010 (Scene lost on relaunch; no request/republish), GA-011 (cross-round Scene ordering), GA-012 (stale/poor fix trusted), GA-013 (touch/LAP/UP-DOWN unverified), GA-014 (bitmap and Storage sizes on small devices), GA-015 (no reviewer path), GA-016 (privacy/listing text), GA-017 (no package provenance; SDK unpinned; tests not in CI), GA-018 (stale `AIM_AT` replay), GA-024 (rejections invisible).

**P2 IMPROVEMENTS:** GA-019 (ready-set persisted without bitmaps), GA-020 (1 Hz full recompute), GA-021 (parity fixtures), GA-022 (35 px icon, missing-revision default, dead field), GA-023 (explicit failure copy).

---

## 36. Final audit report

```
CLARITY CADDY — GARMIN AUDIT

GARMIN PACKAGE       🟠 REVIEW   no .iq to hash; compile claimed (SDK 9.2.0) but not reproducible here; SDK unpinned; README stale
DEVICE COMPATIBILITY 🟠 REVIEW   static only; 3/5 devices take the unscaled-bitmap fallback; touch/LAP unverified; FR55 memory unknown
CADDY ARCHITECTURE   🔴 BLOCK    GA-001, GA-003, GA-004 (+ GA-009/010/011/018 as P1)
RUNTIME HARDENING    🔴 BLOCK    GA-002 (never run) (+ GA-005/007/008/012/014 as P1)

P0 BLOCKERS:
  GA-001  Connect IQ Mobile SDK not bundled on iOS/Android — phone cannot reach any Garmin; no reviewer path
  GA-002  App has never been launched in the simulator or on hardware
  GA-003  RECEIVING face never progresses (maps fetched only from the map view) — watch take-over unreachable
  GA-004  Downloaded raster attributed to "first in-flight hole" — wrong hole/course map can be shown and persisted

P1 RISKS:
  GA-005  32-bit Float epoch-millis (≈131 s resolution) and overflowing/unseeded command ids
  GA-006  drawBitmap2 fallback misaligns overlays on CIQ 3.x devices; :destWidth/:destHeight keys suspect
  GA-007  Map fetch failure → silent 1 Hz retry forever, no failure state
  GA-008  BACK never exits the app
  GA-009  F/C/B are phone numbers, not computed from the wrist fix (Apple does this locally)
  GA-010  Scene not persisted / not re-requested after relaunch
  GA-011  Cross-round Scene ordering unguarded; malformed roundId wipes state
  GA-012  lastFix never ages out; QUALITY_POOR counted usable
  GA-013  Touch event shape, KEY_LAP, UP/DOWN direction unverified
  GA-014  Full-size bitmaps and 18-hole manifest vs FR55/S62 memory and Storage limits unverified
  GA-015  No reviewer kit (membership, phone app, paired device, demo course)
  GA-016  Privacy policy and listing do not describe the watch data flow / dependencies
  GA-017  No package provenance; SDK unpinned; test:garmin not in CI
  GA-018  Stale AIM_AT can be retried and re-applied after a newer one
  GA-024  Command rejections never shown

P2 IMPROVEMENTS:
  GA-019  readyHoles persisted without bitmaps; answeredHandovers unpruned
  GA-020  Full Bubble + ring recompute at 1 Hz on every face; timer runs on no-round face
  GA-021  Bubble parity fixtures never run against the Monkey C port
  GA-022  35 px icon legibility; missing revision defaults to 0; unused GarminPlayState.hole
  GA-023  No explicit GPS / phone / membership status copy

ARCHITECTURE TRACE:

ROUND                         REVIEW   (single authoritative Scene ✓; not persisted; cross-round ordering unguarded)
  ↓
AUTHORITATIVE SCENE          REVIEW   (schema + same-round revision guards ✓; expected-map count ignores course key)
  ↓
GPS → TRUSTED FIX            REVIEW   (validation layer exists ✓; no age-out; POOR accepted; timestamps quantised)
MAP → VERSIONED ASSET        BLOCK    (versioned ✓; response→hole attribution unsafe; RECEIVING dead end; retry loop)
  ↓
LOCAL CADDY                  REVIEW   (Bubble/aim local ✓; hole change and F/C/B are phone round-trips; no map offline)
  ↓
BUBBLE + INPUT               REVIEW   (engine local and version-gated ✓; parity unrun; touch/LAP unverified; BACK traps)
  ↓
COMMAND                      REVIEW   (id/round/revision carried ✓; ids may repeat; stale AIM_AT replay; rejections hidden)
  ↓
ID + REVISION               REVIEW   (see §19 table; two boundaries lack identity: image response, cross-round Scene)
  ↓
PHONE                       BLOCK    (transport is a stub — SDK not linked on either platform)

FINAL STATUS:
NOT READY
```

### What would move this to CONDITIONALLY READY

1. Wire the Connect IQ Mobile SDK on at least one phone platform and complete one round end-to-end on hardware (GA-001, GA-002).
2. Fix GA-003 and GA-004 (small, local changes in `face()`/`mapsExpectedCount()` and `GarminMapDownloader`).
3. Fix GA-005 (Double timestamps, seeded/unique ids) and GA-008 (BACK exits) — both are a few lines.
4. Resolve GA-006 against the SDK docs on the Mac and pick one scaling strategy.
5. Run the simulator on all five devices with a GPX and record memory (GA-013, GA-014); fill in the §4 provenance table from a real `.iq`.
6. Write the review kit and privacy/listing text (GA-015, GA-016).

The remaining P1s (GA-009/010/011/012/018/024) are the "make it robust" list for the round after that; none of them is a Store blocker on its own, but GA-009 and GA-024 are the ones a golfer will notice first.

---

## 37. Sources used

- Repository files cited inline (paths and line numbers are against commit `c611f66`).
- Garmin documentation: **could not be fetched** from this environment (proxy blocks `developer.garmin.com`). Statements tagged [GARMIN-REQ]/[GARMIN-DOC] are from memory of the SDK docs and are marked [VERIFY] wherever an exact API level, option key or guideline wording matters. Verify against the docs bundled with your installed SDK (`<sdk>/doc/`) before acting on them.
- Community/forum observations are tagged [COMMUNITY] and were not treated as requirements.

## 38. Constraints honoured

No source changed, nothing built, deployed, published or altered in the Store; no permissions or targets removed; no finding silently fixed. This document is the only file added.
