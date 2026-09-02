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

1. **`manifest.xml`'s app id** is a placeholder. Register the app at
   apps.garmin.com (Connect IQ Developer Portal) and replace
   `GARMIN-APP-ID-PLACEHOLDER`.
2. **Product ids** (`approachs62`, `fenix6`, `fr55`, `approachs70`) — cross-check
   against the Connect IQ SDK Manager's current device list; Garmin revises
   these strings between SDK releases.
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

## What's deliberately NOT done yet

- No interactive aiming UI (drag/button nudge) — Phase 3. `sendAim()` and the
  full `AIM_AT` plumbing exist in `GarminSessionManager`/`GarminPlayState`
  now so Phase 3 does not need to touch this layer, but nothing calls them
  yet.
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
