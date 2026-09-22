# Clarity Caddy — Garmin Connect IQ app

Phase 1 + Phase 2 of the Garmin implementation plan. **This code has never been compiled.**
There is no Connect IQ SDK installed in the environment this was written in, so
everything here is a careful, line-by-line port of the existing Swift/JS
source of truth, unverified against the actual `monkeyc` compiler or
simulator. Build it, fix whatever the compiler flags, and treat the items
below as the known list of things most likely to need adjustment.

## What this is

A direct architectural mirror of the Apple Watch app
(`ios/App/ClarityCaddyWatch/`, `ios/WatchBubbleEngine/`), talking to the same
JavaScript Marshal contract (`app/js/caddy-watch.js`, `app/js/marshal.js`) —
**no JS changes were needed**. `caddy-watch.js`'s own header already says it
has "no DOM, Leaflet, Swift, Kotlin, or Garmin assumptions," and both
`LOCATION_SOURCES` (caddy-watch.js) and the `allowed` list
(marshal.js's `observationPoint`) already include `"garmin"` as a valid
location-observation source. The command vocabulary (`LOCK`, `LOCK_AT`,
`AIM_AT`, `VIEW_NEXT_HOLE`, `VIEW_PREVIOUS_HOLE`, `TAKE_OVER`, `HAND_BACK`) is
used verbatim — see `GarminCommand.mc`.

## Directory map

```
garmin/
  manifest.xml              Connect IQ app manifest (needs a real app id — see below)
  monkey.jungle              Build config
  source/
    ClarityCaddyApp.mc        App entry point, owns GarminSessionManager
    CaddyAppView.mc            Root view: StatusView vs NumbersView by face()
    CaddyInputDelegate.mc       BehaviorDelegate -> InputRouter -> GarminSessionManager
    Session/
      GarminWire.mc              Dictionary-safety helpers (shared)
      GarminScene.mc              Mirrors WatchScene.swift
      GarminCommand.mc            Mirrors CaddyWatchCommand / CommandPayload / WatchCommandAcknowledgement
      GarminOutbox.mc             Mirrors WatchSessionManager's pendingCommands + persistence
      GarminSessionManager.mc     Mirrors WatchSessionManager.swift
      GarminLockedShot.mc          Mirrors WatchLockedShot.swift
    GPS/
      GarminLocationManager.mc    Mirrors WatchLocationManager (Toybox.Position)
    Player/
      GarminPlayerSnapshot.mc     Mirrors WatchPlayerSnapshot.swift (incl. fingerprint format)
      GarminPlayerStore.mc         Mirrors WatchPlayerStore.swift
    Bubble/
      GarminInputs.mc              Mirrors Inputs.swift (Coordinate/WatchClub/WatchBagSnapshot/WatchBubbleProfile)
      GarminBubbleMath.mc           Mirrors BubbleMath.swift (JS + Geo modules)
      GarminBubbleTables.mc         Mirrors BubbleTables.swift
      GarminBag.mc                  Mirrors Bag.swift
      GarminBubbleProfile.mc        Mirrors BubbleProfile.swift + VisualBubble
      GarminBubblePayload.mc        Mirrors BubblePayload.swift
      GarminBubbleEngine.mc         Mirrors BubbleEngine.swift
      GarminEngineVersion.mc        Mirrors EngineVersion.swift
      GarminPlayState.mc            Mirrors WatchPlayState.swift (club hysteresis)
    Maps/
      GarminMapManifest.mc          Mirrors WatchMapManifest — Garmin-specific `url` field added per hole
      GarminMapProjection.mc         Mirrors WatchMapSpatialReference — the imagePoint()/coordinate() transform
      GarminMapStore.mc              Mirrors WatchMapStore.swift's INTENT (not its filesystem implementation)
      GarminMapDownloader.mc         Pulls hole rasters by URL — see its own header for why this differs from Apple
      GarminMapCamera.mc              Phase 2: mirrors WatchMapCamera.swift's resting framings (play/bubble) + render transform
      GarminMapView.mc                Phase 2: mirrors HoleMapView.swift + AimableHoleMap.swift's Canvas block (read-only; no drag/crown/edge-pan)
    UI/
      InputRouter.mc                 Semantic action vocabulary (plan step 12)
      NumbersView.mc                  Phase 1's numbers-first playing face
      StatusView.mc                   noRound/ready/taking faces (no `receiving` — see GarminSessionManager)
    Device/
      DeviceCapabilities.mc           Screen shape/size/touch/memory-tier
      LayoutProfile.mc                Small layout derivations
  resources/
    strings/strings.xml               Everything identical on every device
  resources-icons/
    35/ 40/ 60/ 70/                   One launcher icon per required size,
                                      each with its own drawables.xml;
                                      monkey.jungle picks per product
```

### Why the launcher icon is four folders

Connect IQ asks a different icon size per device and re-encodes whatever
source bitmap it is given to that size at compile time. A wrong-size source
therefore **still builds** — it is silently resampled, and the only symptom is
a soft icon on a device nobody looked at. Worse, because the compiler
re-encodes, the `.prg` comes out the *same length* either way (verified
2026-09-19: fenix6 built from a 40x40 and from a 70x70 source gave two
191,788-byte files with different hashes), so build size tells you nothing.

So each size is its own folder and `base` deliberately has no icon at all: a
product with no `resourcePath` line fails the build outright with "A bitmap
resource matching the provided launcher icon can't be found", which is a loud
error at the moment you add the product rather than a soft icon discovered
later. `npm run test:garmin` checks the wiring and the sizes, reading the
expected size from the installed SDK's own device definitions rather than a
list anyone has to maintain.

The images are the app icon (`ios/.../AppIcon-512@2x.png`) cropped square to
the pin — the source has wide margins, and cropping lifts the mark from 62% to
89% of the frame, which is the difference between legible and mush at 35px —
then resized with `sips`.

## Architectural decision: Garmin pulls map images by URL, not pushed bytes

`AppleWatchTransport.swift` pushes JPEG bytes over WatchConnectivity
(`sendMessage`/`transferFile`), because watchOS's WCSession has no concept of
the Watch fetching a URL itself. Garmin's Connect IQ SDK is different in a way
that matters here: `Communications.makeImageRequest(url, parameters, options,
callback)` fetches a web image and hands back an **already-decoded** bitmap — there is no
public Monkey C API for decoding an arbitrary JPEG/PNG byte buffer the app
assembled itself from chunked transmit messages. So:

- `GarminMapManifest`'s per-hole entry carries a Garmin-specific `url` field
  (in addition to the shared `courseKey`/`version`/`holeNumber`/`width`/
  `height`/`spatialReference`/`reference` fields every platform gets) —
  pointing at the same baked image `course_watch_maps` already serves.
- `GarminMapDownloader` fetches by URL and hands the decoded bitmap to
  `GarminMapStore`.
- **Done (2026-09-19).** `app/js/watch-map-delivery.js` attaches an absolute
  `url` to every manifest hole, pointing at `/api/course-watch-map-assets`.
  The lifetime worry recorded here was unfounded: that endpoint is a
  read-only proxy over imagery that is public by design
  (`functions/course-watch-map-assets.mjs` says so in its own header), it
  takes no `Authorization` header — which matters, because `makeImageRequest`
  cannot send one — and it serves `immutable, max-age=31536000` over a
  versioned `vN` path. Nothing is signed and nothing expires, so a URL is
  good for as long as the package is. Covered by two checks in
  `dev/watch-map-delivery.test.js`; a relative URL (the web case, where there
  is no origin to resolve against) is omitted rather than sent unusable.

This also happens to be the literal reading of the original Garmin Phase 1
plan's step 22 wording: "Garmin then obtains each hole image using Connect IQ
communications/**image request** APIs."

## Known unverified items (verify against the installed Connect IQ SDK)

1. ~~**`manifest.xml`'s app id** is a placeholder.~~ **Done.** A real UUID
   (`fac5991c…`) is now in `manifest.xml`. Note the earlier claim here was
   wrong: the app UUID is *developer*-generated, not minted by the portal —
   the portal issues a separate *Store* UUID at publish time. Never
   regenerate the app UUID once published; it would orphan the listing.
2. **Product ids** — `approachs70` was not a valid id (the S70 has a separate
   id per case size) and has been replaced with `approachs7042mm` +
   `approachs7047mm`. Still cross-check the whole list against the SDK
   Manager's device list; `./build.sh check` does this for you.
3. ~~**`minSdkVersion="3.2.0"`**~~ — **settled 2026-09-19: now `3.0.0`.** The
   3.2.0 was a guess and it locked out the Approach S62 entirely (that device
   tops out at CIQ 3.0.12, and the compiler refused it outright). Checked
   against SDK 9.2.0 before relaxing: `registerForPhoneAppMessages` is since
   API 1.0.0 and `makeImageRequest` since 1.2.0, both far below 3.0. All five
   products build.
4. **`Position.Info.accuracy`** (`GarminLocationManager.estimateAccuracyMetres`)
   — some API levels report metres directly, others only a `QUALITY_*` enum.
   The code handles both defensively but the exact field shape per device in
   the Phase 1 matrix needs confirming on real hardware/simulator.
5. ~~**`Communications.makeImageRequestWithDictionary`'s callback signature**~~
   — **settled 2026-09-19.** That method does not exist. The real API is
   `makeImageRequest(url, parameters, options, responseCallback)`: four
   arguments, **no request-context argument**, callback
   `(responseCode as Number, data as BitmapResource|BitmapReference|Null)`.
   So the hole number genuinely cannot be threaded through the request.
   `GarminMapDownloader` therefore allows exactly one request at a time and
   records the hole, course key and package version it was made for; a
   response is credited to that record only while the store still holds the
   same package. (The earlier "whichever hole is currently awaited" over a
   set of in-flight holes could credit hole 3's picture to hole 4 after a
   hole change mid-fetch.) What remains unconfirmed is only the API's
   cross-relaunch caching behaviour.
6. **`Application.Storage` capacity** — total and per-key limits vary by
   device and were not verified against the specific devices in the Phase 1
   matrix. The manifest and ready-hole set are small; if a full 18-hole
   manifest with per-hole `spatialReference` transforms proves too large for
   a given device's storage budget, trim what gets persisted (e.g. persist
   only the current hole's entry) rather than the whole manifest.
7. ~~**The launcher icon**~~ — **settled 2026-09-19.** The placeholder is
   gone; the real Clarity Caddy pin ships at each device's own size from
   `resources-icons/`, wired per product in `monkey.jungle` and guarded by
   `npm run test:garmin`. See "Why the launcher icon is four folders" above.
   One honest caveat: at 35x35 (Approach S62, Forerunner 55) the G's counter
   closes up and the ball reads as a dot. The pin silhouette still carries it,
   but a hand-simplified mark for the small sizes would read better than the
   downscale.
8. **`WatchUi.BehaviorDelegate`'s `onNextPage`/`onPreviousPage`** are mapped to
   hole navigation (`CaddyInputDelegate.mc`) on the assumption that Connect
   IQ maps these to whatever the device's natural "next/previous" gesture or
   button is (UP/DOWN on 5-button devices, swipe on touch). Confirm this
   feels right on the actual Phase 1 device matrix — plan step 25's suggested
   button pattern (`UP/DOWN` for vertical movement) is about **aiming**
   (Phase 3), not hole navigation, so there is room to disagree about which
   physical input should mean "next hole" once real devices are in hand.

## Phase 2: map rendering (read-only)

`GarminMapView` draws the delivered hole raster with the camera crop applied,
a dashed player->aim line, the green ring, a target dot + club label, the
player dot, and — when `GarminSessionManager.localBubble()` can compute
(engine-version agreement, a trustworthy fix) — the actual 168-point Bubble
ring rather than an approximation, exactly mirroring
`AimableHoleMap.swift`'s Canvas block. When it cannot compute locally, the
view falls back to a plain target dot + club label, exactly matching
`HoleMapView.swift`'s (the phone-authoritative, read-only) behaviour.

- `GarminMapCamera` ports `WatchMapCamera.swift`'s `resting`/`play`/`bubble`
  framings and the `origin`/`place` render transform. It deliberately does
  NOT port `panned()`/`zoomed()`/`edgeDirection()` — those are live
  drag/crown interaction, Phase 3 territory.
- The camera is recomputed only on a hole change, never on every GPS tick or
  Scene revision — the same "camera should not continuously jump" stability
  rule `AimableHoleMap.swift` gets from only calling `settle()` on
  appear/hole-change/first-fix. This IS the ported mechanism, not a
  separately invented damping formula.
- Numbers <-> Map navigation is on the MENU input (`CaddyInputDelegate.onMenu`)
  and BACK-from-map. MENU was chosen because it is the one semantic action
  every device in the Phase 1 matrix is expected to expose (button or touch);
  revisit once real devices are in hand — plan step 24 wants touch devices to
  also get a tap/swipe path, which is not wired yet.
- **UNVERIFIED**: `dc.drawBitmap2` (scaled bitmap draw, needed whenever the
  camera's PLAY/BUBBLE framing magnifies past 1x) is feature-detected via
  `dc has :drawBitmap2` with a plain unscaled `drawBitmap` fallback. If a
  device in the Phase 1 matrix lacks `drawBitmap2`, the fallback will
  misalign the overlay markers (which are always computed through the full
  camera transform) against the unscaled image — confirm this against real
  hardware/simulator before trusting the fallback path in practice.
- The manifest's `metresPerPixel` field (used for the nominal-Bubble-extent
  camera fallback when no ring exists yet) is now parsed in
  `GarminMapProjection.mc`'s `fromDict`/persisted round-trip — it was
  omitted from the Phase 1 port since Phase 1 never needed it.

## Phase 3: interactive aiming

`GarminMapView` now drives `GarminSessionManager.playState` directly:
touch drag and button nudge both move `playState.target` locally (recomputing
the Bubble on every frame via `GarminPlayState.moveTarget`, including club
hysteresis and the bag-roof clamp — the same engine call Phase 1/2 already
had, just now driven by the player instead of only by the Scene), and
`AIM_AT` is sent exactly once, on release/confirm — never per frame.

- **Local vs. authoritative target**: `GarminSessionManager.localBubble()`
  (used by both `NumbersView` and `GarminMapView`, Phase 1/2's code, unchanged
  in shape) now prefers `playState.bubble` once a local target has been
  placed, falling back to the Scene's target otherwise. Apple's own
  architecture keeps two separate engine instances for this (`WatchSessionManager
  .localBubble` vs. `AimableHoleMap`'s private `WatchPlayState`); Garmin
  shares one `GarminPlayState` instance and gets the same outcome — see
  `GarminSessionManager.localBubble()`'s header comment.
- **GPS during an aim**: `onLocationFix` now re-runs `moveTarget` against
  whatever target is already held (if any) on every fix, so distance and the
  ring track the walk — the target itself never moves from a GPS update
  (plan step 31), only from a drag/nudge/AIM_AT correction.
- **Hole change**: `receiveScene` now calls `playState.enter(holeNumber)` on
  a detected hole-number change (and resets `playState` entirely when the
  round ends) — everything about the old target/held-club/Bubble goes,
  matching plan step 30.
- **Image-bounds clamp** (`GarminMapView.applyImagePoint`): drag/nudge
  results are clamped to `[0, imageWidth] x [0, imageHeight]` before being
  turned back into a coordinate — a LOCAL UX constraint only, so the target
  stays drawable. This is NOT the Caddy aim-roof/bag-clamp authority (plan
  step 19's explicit distinction) — that clamp is
  `GarminPlayState.clampedToBag`, already inside `moveTarget` since Phase 1,
  ported from `WatchPlayState.swift` exactly (Apple's own wrist applies the
  same local bag-roof clamp — it is not a Marshal-only rule).
- **Command ordering** (plan step 22, "`AIM_AT` then `LOCK_AT` must not lock
  the old target"): no extra guard code was added. `GarminOutbox` sends
  commands in the order they were enqueued over one reliable
  `Communications.transmit` channel, and each command carries its own
  `baseRevision`; trusting that FIFO ordering rather than inventing a
  "block LOCK while an AIM_AT is in flight" state is the literal instruction
  in the plan ("use the existing command revision/order system rather than
  inventing special Garmin lock state").
- **Button layout decision**: SELECT enters/confirms Aim Mode (plan step 25);
  BACK cancels an in-progress aim or backs out to Numbers; UP/DOWN nudge
  vertically while aiming, navigate holes otherwise; `WatchUi.KEY_LAP` is
  LOCK-from-the-map (plan step 22) since SELECT was already needed for aim
  entry/confirm. **No lateral (LEFT/RIGHT) nudge is wired for button
  devices** — none of the Phase 1 device matrix (Approach S62/S70, Fenix 6,
  Forerunner 55) has a physical left/right control, and inventing an
  unproven axis-toggle UX without real hardware to validate it against would
  be a guess, not a decision. Touch devices get full 2D freedom via drag.
  Revisit once real devices are in hand.
- **NEW unverified items** (in addition to Phase 1/2's list):
  - Whether `WatchUi.KEY_LAP` reaches `onKey()` on a `BehaviorDelegate`
    subclass at all, and whether that constant name is current.
  - The touch-event API shape (`CaddyInputDelegate.onTouch`) — constant
    names for start/move/end and the coordinate-accessor shape are this
    session's best guess, wired defensively with `has :symbol` checks so an
    unrecognised SDK shape degrades to a no-op (or, for a bare unrecognised
    touch report, a tap-and-send fallback) rather than crashing. This is the
    single least-certain piece of the whole Garmin build — confirm early
    against the real SDK before relying on continuous drag.

## What's deliberately NOT done yet

- Real device/simulator testing of any of the above — none of it has run.
- No touch-drag polish (edge panning while dragging near the screen bounds,
  live pinch/crown zoom) — `WatchMapCamera.swift`'s `panned()`/`zoomed()`
  were deliberately not ported; add them here if real-device testing shows
  the fixed resting-camera framing is too tight to aim comfortably within.
- No Scene schema v2 (`surface.active.platform`/`deviceId` — original plan
  step 6). Not required for Phase 1: `surface.active == "watch"` already
  covers "a wrist is driving," Apple or Garmin alike, and the `device` field
  on a command is free-form and unvalidated by Marshal. Worth doing before
  Garmin and Apple Watch could plausibly be paired to the same phone at once
  and need to be told apart in the UI — not before.

## Parity fixtures (plan step 15) — done, and they pass

`npm run test:garmin:parity` runs all 11 cases of
`dev/fixtures/bubble-engine-parity.json` through this port's
`GarminBubbleEngine` on the simulated watch and prints a verdict:

```
parity: RESULT PASS 11/11
```

It needs the Connect IQ simulator already running, and a parity build:

```bash
connectiq &                                  # if it is not up
cd garmin && CIQ_PARITY=1 ./build.sh build   # writes ClarityCaddy-<device>-parity.prg
cd .. && npm run test:garmin:parity          # exits 0 on PASS, 1 on anything else
```

Three pieces, none of which ship:

- `dev/generate-garmin-parity-fixture.js` compiles the JSON into
  `source/Test/GarminParityFixture.mc`. Monkey C has no file I/O and no JSON
  parser, so the fixture has to become source — and `npm run test:garmin`
  runs the generator with `--check` so an edited fixture that was never
  regenerated fails a test instead of quietly testing old numbers.
- `source/Test/GarminParityHarness.mc` is a direct port of
  `BubbleEngineParityTests.testEveryCaseMatchesTheJavaScriptEngine`: same bag
  (`expect.bagSent`, because the wrist is sent a finished bag rather than
  deriving the ghost stand-in), same default-target call first, same fields at
  the same per-field tolerances.
- `tools/run-parity.js` pushes the build and reads the verdict off monkeydo's
  stdout.

All three are annotated `(:parity)` and excluded by `monkey.jungle`, so the
store package carries neither the harness nor the ~600-line fixture table.

### What running them actually found

Ten of eleven cases passed first time. The eleventh,
`driver-off-the-tee`, gave `visualWidthM` 41.5 against the JavaScript's 41.6,
and the cause was not the visual step at all:

**Monkey C decimal literals are 32-bit Floats.** `205 * 0.19` is exactly 38.95
in Double, which `gdRound` takes up to 39.0; in Float it is 38.949997, which
rounds DOWN to 38.9. That 0.1m in the cluster width multiplied through to 0.1m
in the visual width. Every decimal literal in `GarminBubbleTables`,
`GarminBubbleProfile`, `GarminBubblePayload`, `GarminBubbleEngine`,
`GarminBubbleMath` and `GarminBag` now carries a `d` suffix (214 of them), so
the arithmetic runs at the same precision as the JavaScript it was ported
from. **Keep it that way** — a new bare literal in any of those files is a
rounding bug waiting for the right carry distance.

Worth knowing for anything else ported here: the failure was invisible to the
compiler, invisible in the simulator, and would have shipped. Only the fixture
caught it, and only once it was actually run.

### Two things the harness had to work around

- **`String.toDouble()` does not exist** on this API level — it compiles and
  then dies at runtime with "Could not find symbol 'toDouble'". The fixture's
  numbers are strings (a bare literal would be a Float, which is the very
  thing being tested), so the harness parses them digit by digit with
  `toNumber()`.
- **All eleven cases in one call trips the watchdog** ("Code Executed Too
  Long"). Not slowness — the live map builds the same 168-point ring every
  frame of a drag — but a limit on how long one callback may run. Each case
  therefore runs on its own timer tick.
