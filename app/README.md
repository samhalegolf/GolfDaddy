# Fresh app surface

The rebuild described in `../MOBILE_APP_ARCHITECTURE_HANDOVER_2026-07-31.md`.
Read that doc and `../PRE_BUILD_AUDIT_2026-07-31.md` before touching this tree.

The whole app, one paragraph: fetch the course package, draw the objects on a
live map, and if the server published a playing surface for the hole, show it
instead. The app is a pure consumer — it never captures, composites, flattens,
or writes course data back.

## Ground rules (enforced, not aspirational)

1. **One canonical course key** — `js/course-key.js` is the only slug function.
2. **The live map is the fallback, never blocked** — nothing hides `#map` by
   CSS; it is created the moment absence or failure is the answer for a hole,
   never earlier. A hole whose package declares a visual presents
   surface-first with no OSM underneath, and every load path settles: paint,
   error → map, or a bounded transition-scoped stall timer → map.
3. **No `setInterval`** — a grep for it in `app/` should return nothing.
   Transitions do their own cleanup, bounded and cancellable.
4. **Absence is a state** — "no surface for this hole" is cached per hole and
   answering it twice does no work the second time.
5. **The app authors nothing** — no writes to any course/surface table or
   legacy key space. `captured_surfaces` and `gd_captured_hole_frame_v19_*` do
   not exist here.
6. **Integer `captureZoom`** — the projection in `js/play-surface.js` asserts it.
   The live map's frame is solved at an integer reference zoom for the same
   reason, through the same `worldPx` assert.
7. **One projection seam** — `projector()` in `js/play.js` answers
   lat/lng ↔ viewport pixels for whichever presentation is up (published =
   image pixels through the frame matrix, live = Leaflet container pixels
   through the live frame matrix). Every overlay — dot, bubble rings, aim
   line, wind line, middle guide, pin, green ring — goes through it and so
   draws on both. Nothing may reach for `surfaceImage.dataset.playSurface`
   directly to place a point; that is what made the live map bare.

## Layout

- `index.html` — the shell. Home + play, `#map` visible by default.
- `js/course-key.js` — canonical course key (rule 1).
- `js/course-library.js` — GET `/api/course-library` consumer for the picker,
  fail-open to an empty list.
- `js/course-package.js` — GET `/api/course-package` consumer, fail-open.
- `js/play-surface.js` — published-surface lookup (`/api/course-visuals`) and
  the mercator-image projection. Pure functions are node-requirable for tests.
- `js/bubble-engine.js` — GENERATED (dev/generate-bubble-engine-client.js):
  the real shot bubble engine copied verbatim from gd-app-core.js (bag, ghost
  bag, dispersion profiles, payloads, bag-roof clamp, green-or-layup target
  rule) plus pin-lock's route layup helpers. Never hand-edit; change the
  engine and re-run the generator. The adapter at the bottom supplies shot
  state and the projection seam for drawing its lat/lng rings on the surface.
- `js/distance.js` — pure distance math: haversine, front/centre/back of green
  in metres. Node-requirable.
- `js/position.js` — the player's position, one value one owner. Sources:
  `tee` (hole entry heads to the tee), `tap` (tap where you are standing, on
  map or surface), `gps` (real fixes, adopted only within 1.5km of the hole so
  off-course testing is never clobbered). Policy lives in `play.js`.
- `js/gps.js` — `watchPosition` wrapper. Event-driven, fail-open; "no fix" is a
  state the play surface renders fine, not an error.
- Green focus lives in `js/play.js` (ported from gd-app-core's
  `gdEnterActiveGreenFocus`/`gdEnsureGreenFocusBall`): inside 40m of the green
  the position dot becomes a draggable golf ball, and Shot End records where
  the BALL is rather than the fix. It is sticky — walking off the green does
  not close it, and the camera keeps holding the green being logged, so the
  placement can be done later from the next tee with the ball parked at a
  fixed pickup point. Only Shot End or a hole change ends it.
- `js/plays-like.js` — what a shot plays to once elevation is counted, ported
  from gd-app-core's elevation channel: one Open-Meteo lookup for both ends of
  the shot, cached per point, debounced. Opportunistic by contract — a
  third-party call over the network during play, so every failure answers null
  and the card just shows the flat number.
- `js/pin.js` — the pin/flag position, player-set and separate from the
  package's green centre/shape. Per-hole, mirrors shot.js's shape (pure data,
  no DOM); an unset pin is a normal state. Placement is armed from the tool
  rail and consumed by play.js's existing tap handlers.
- `js/bag.js` — the tool-rail bag editor (clubs, carry, firmness). Owns its own
  storage (`clarity:bag:v1`, not the legacy per-account profile bag) and feeds
  the engine through `GDBubbleEngine.setBag` — see the `gdShotActiveProfile`
  rebind in `dev/generate-bubble-engine-client.js`.
- `js/wind.js` — the tool-rail wind tool: tap cycles level, long-press opens a
  compass to set direction. Drives `GDBubbleEngine.setWind`/`clearWind`, which
  only ever swaps the *display* target the shot card/rings render against —
  never the dispersion shape.
- `js/scorecard.js` — score entry + running total. Par is read from the
  existing `/api/scorecard-store` cache (fail-open, same pattern as
  course-library.js/course-package.js); score state is its own storage
  (`clarity:scorecard:v1`), keyed by course.
- `js/play.js` — play state machine: enter/leave hole, frame from objects,
  present/remove surface, render the GPS fix on map and surface. Owns the
  Leaflet map, the projection seam (rule 7) and both stage cameras.
  The live map frames against the SAME guide-box contract as the published
  surface (`stageFrame` in play-surface.js): the solved similarity's scale
  becomes Leaflet's own zoom so tiles stay native-resolution, and only the
  rotation rides in a CSS matrix on `#map`, which is over-provisioned to the
  viewport diagonal so a rotated corner can never show through. Leaflet's
  gestures and its `e.latlng` are both bypassed while framed — a rotated
  container makes both wrong. **Tilt is published-surface only**; Leaflet has
  no 3D camera.
- `js/gps-settings.js` — the four legacy GPS Settings that survived the
  rebuild: units (m/yd), show aim line, shot-up frame, lock frame tightness.
  Owns its own storage (`clarity:gps-settings:v1`). The other nine controls
  on the old panel (`../index.html` #settingsPanel) described decisions the
  app no longer lets a player make — map source is chosen by imagery licence
  and region, mapped-vs-manual is decided by whether the package has
  geometry, and render/bias/texture were dev toggles the engine now bakes in.
- `js/tool-rail.js` — the tab/rail toggle, and wires each rail button to its
  tool module's entry point. Each tool module wires its own panel/popover
  internals itself.
- `js/boot.js` — wiring. Sets `ClarityApp.booted` as the test canary.

Test: `node dev/fresh-app-boot.test.js` (registered in structural-smoke CI) —
projection unit checks in node, then boots `/app/index.html` in headless
Chromium and fails on any uncaught exception.
