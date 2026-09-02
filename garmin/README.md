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
      StatusView.mc                   noRound/receiving/ready/taking faces
    Device/
      DeviceCapabilities.mc           Screen shape/size/touch/memory-tier
      LayoutProfile.mc                Small layout derivations
  resources/
    strings/strings.xml
    drawables/drawables.xml, launcher_icon.png (105-byte placeholder — replace)
```

## Architectural decision: Garmin pulls map images by URL, not pushed bytes

`AppleWatchTransport.swift` pushes JPEG bytes over WatchConnectivity
(`sendMessage`/`transferFile`), because watchOS's WCSession has no concept of
the Watch fetching a URL itself. Garmin's Connect IQ SDK is different in a way
that matters here: `Communications.makeImageRequestWithDictionary(url, ...)`
fetches a web image and hands back an **already-decoded** bitmap — there is no
public Monkey C API for decoding an arbitrary JPEG/PNG byte buffer the app
assembled itself from chunked transmit messages. So:

- `GarminMapManifest`'s per-hole entry carries a Garmin-specific `url` field
  (in addition to the shared `courseKey`/`version`/`holeNumber`/`width`/
  `height`/`spatialReference`/`reference` fields every platform gets) —
  pointing at the same baked image `course_watch_maps` already serves.
- `GarminMapDownloader` fetches by URL and hands the decoded bitmap to
  `GarminMapStore`.
- **This means the phone-side manifest generation for Garmin needs to attach
  a fetchable URL per hole.** If `course_watch_maps`'s existing URLs are
  short-lived signed URLs, either the manifest needs a URL with a longer
  lifetime, or Garmin needs to re-request the manifest before each fetch.
  This is real, unresolved phone-side work — not something this device-side
  code can settle alone.

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
3. **`minSdkVersion="3.2.0"`** — plan step 29 prefers a 3.0 baseline;
   `registerForPhoneAppMessages`/`makeImageRequestWithDictionary` are most
   reliably documented from 3.2 onward. Relax if the actual devices in the
   Phase 1 matrix support less.
4. **`Position.Info.accuracy`** (`GarminLocationManager.estimateAccuracyMetres`)
   — some API levels report metres directly, others only a `QUALITY_*` enum.
   The code handles both defensively but the exact field shape per device in
   the Phase 1 matrix needs confirming on real hardware/simulator.
5. **`Communications.makeImageRequestWithDictionary`'s callback signature**
   (`GarminMapDownloader.onImageResponse`) — whether a request context
   argument is threaded through to the callback varies by API level; the
   code falls back to "whichever hole is currently awaited," which is safe
   under Phase 1's one-bitmap-resident discipline but should be tightened
   once the real callback shape is confirmed.
6. **`Application.Storage` capacity** — total and per-key limits vary by
   device and were not verified against the specific devices in the Phase 1
   matrix. The manifest and ready-hole set are small; if a full 18-hole
   manifest with per-hole `spatialReference` transforms proves too large for
   a given device's storage budget, trim what gets persisted (e.g. persist
   only the current hole's entry) rather than the whole manifest.
7. **The launcher icon** (`resources/drawables/launcher_icon.png`) is a
   105-byte solid-colour placeholder generated by this session, not real
   artwork. Replace it — check the SDK's per-product icon size table.
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

## Parity fixtures (plan step 15)

Not wired up — there is no Monkey C test runner available in this
environment to validate against `dev/fixtures/bubble-engine-parity.json`.
Once the SDK is installed, the fixture format matches the Bubble Engine's
input contract 1:1 (see `PlayerSnapshot.swift`'s header comment) — write a
small Monkey C test harness that reads the same JSON (or a generated `.mc`
constant table, since Monkey C has no JSON file I/O at compile time in the
general case) and asserts `GarminBubbleEngine.calculate()`'s output against
each case's expectations within the fixture's documented tolerances
(metres: 0.1, degrees: 0.01, coordinate: 1e-7). Do not consider Garmin
support complete until this passes — this is Phase 1's own stated
completion bar for the Bubble Engine.
