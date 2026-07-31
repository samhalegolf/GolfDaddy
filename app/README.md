# Fresh app surface

The rebuild described in `../MOBILE_APP_ARCHITECTURE_HANDOVER_2026-07-31.md`.
Read that doc and `../PRE_BUILD_AUDIT_2026-07-31.md` before touching this tree.

The whole app, one paragraph: fetch the course package, draw the objects on a
live map, and if the server published a playing surface for the hole, show it
instead. The app is a pure consumer — it never captures, composites, flattens,
or writes course data back.

## Ground rules (enforced, not aspirational)

1. **One canonical course key** — `js/course-key.js` is the only slug function.
2. **The live map is the default** — nothing hides `#map` by default; a
   published surface earns its way on top and is removed on failure.
3. **No `setInterval`** — a grep for it in `app/` should return nothing.
   Transitions do their own cleanup, bounded and cancellable.
4. **Absence is a state** — "no surface for this hole" is cached per hole and
   answering it twice does no work the second time.
5. **The app authors nothing** — no writes to any course/surface table or
   legacy key space. `captured_surfaces` and `gd_captured_hole_frame_v19_*` do
   not exist here.
6. **Integer `captureZoom`** — the projection in `js/play-surface.js` asserts it.

## Layout

- `index.html` — the shell. Home + play, `#map` visible by default.
- `js/course-key.js` — canonical course key (rule 1).
- `js/course-library.js` — GET `/api/course-library` consumer for the picker,
  fail-open to an empty list.
- `js/course-package.js` — GET `/api/course-package` consumer, fail-open.
- `js/play-surface.js` — published-surface lookup (`/api/course-visuals`) and
  the mercator-image projection. Pure functions are node-requirable for tests.
- `js/distance.js` — pure distance math: haversine, front/centre/back of green
  in metres. Node-requirable.
- `js/position.js` — the player's position, one value one owner. Sources:
  `tee` (hole entry heads to the tee), `tap` (tap where you are standing, on
  map or surface), `gps` (real fixes, adopted only within 1.5km of the hole so
  off-course testing is never clobbered). Policy lives in `play.js`.
- `js/gps.js` — `watchPosition` wrapper. Event-driven, fail-open; "no fix" is a
  state the play surface renders fine, not an error.
- `js/play.js` — play state machine: enter/leave hole, frame from objects,
  present/remove surface, render the GPS fix on map and surface. Owns the
  Leaflet map.
- `js/boot.js` — wiring. Sets `ClarityApp.booted` as the test canary.

Test: `node dev/fresh-app-boot.test.js` (registered in structural-smoke CI) —
projection unit checks in node, then boots `/app/index.html` in headless
Chromium and fails on any uncaught exception.
