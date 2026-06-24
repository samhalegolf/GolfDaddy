# Patch 1 — Ownership Quarantine

## Files Changed

- `index.html`
- `scripts/gd-shot-events.js`
- `scripts/gd-course-library-pin-lock.js`
- `scripts/clarity-build.js`
- `dist/` refreshed by `npm run build:netlify`

## Exact Behaviour Changes

- Pretend GPS / GPS Override tap now means only: use the tapped point as the active player position.
- Normal manual positioning no longer transitions into `mode="green"` or asks for a second green tap when mapped green truth is unavailable.
- Head-to-Tee no longer enters the shared Two-Tap placement function.
- Head-to-Tee now visibly fails if mapped tee/green/fairway ownership is unavailable.
- GPS locate/refresh updates the active GPS/start position but no longer performs live-map camera jumps.
- Captured-camera failures now surface as visible unavailable states instead of silently calling legacy camera functions.
- Green Focus stores its result point separately and no longer mutates `gdGpsState.lastFix`.
- Green Focus no longer uses Green Zoom CSS/state as its active state marker.
- Green Zoom failure now shows a visible unavailable state instead of falling through to old simple zoom, point framing, or live-map zoom.

## Legacy Paths Isolated

- Legacy Two-Tap green placement is guarded behind `window.__gdLegacyTwoTapShotBuilderActive === true`.
- Pretend GPS start placement calls `gdCompleteStandingStartPlacement` as a one-tap position placement only.
- The shared `mode="green"` placement state is no longer considered active for normal GPS map placement.
- Spring Clean’s manual standing-point handler no longer falls back to `gdCompleteTwoTapPlacement`.
- Head-to-Tee sets the tee/start point directly and only continues if mapped green lock succeeds.

## Fallbacks Removed

- V19 `fallbackNative(...)` no longer calls the older native/live map camera.
- Manual-start lock no longer falls back to `lockFrame(...)`.
- Bubble long-press zoom no longer falls back to `gdToggleSimpleGreenZoom(...)` or `gdFrameAroundPoint(...)`.
- Green Zoom return no longer falls back to `lockFrame(...)`.
- State Stabilizer / Green Focus no longer falls back to live `map.fitBounds(...)`.
- External snap-zoom fallback no longer cycles mapped presets, green focus, or `map.zoomIn(...)`.
- GPS locate/refresh no longer calls `map.setView(...)` / `panTo(...)` as a camera fallback.
- Head-to-Tee lay-up no longer falls back to straight-to-green projection when fairway lay-up is unavailable.

## Course Data Save Rules

- Course Data saving now requires a valid previous pending / held Bubble state.
- Shot End no longer creates a planned shot just to make an outcome pairable.
- `gdLogBallPositionForTracking(...)` now uses `logOutcomeForPending(...)` only.
- If the Course Data owner is unavailable, the result is rejected instead of saved through a weak fallback.
- `scripts/gd-shot-events.js` now rejects pairings when:
  - there is no pending planned shot;
  - the round does not match;
  - the hole does not match;
  - the player scope does not match;
  - the result event is the origin event;
  - the result has already been paired;
  - the result is older than the plan, too stale, or low confidence;
  - GPS accuracy is outside the accepted threshold.
- Invalid or rejected outcome events are not saved merely to preserve a fallback trail.

## What Was Not Changed

- Patch 2 was not implemented.
- Patch 3 was not implemented.
- The camera system was not rebuilt.
- Bubble maths were not changed.
- Practice systems were not changed.
- Green Wand was not changed.
- Auto Course Mapper internals were not changed.
- No deployment was performed.

## Build/Test Result

- `node --check scripts/gd-shot-events.js` passed.
- `node --check scripts/gd-course-library-pin-lock.js` passed.
- `node --check scripts/clarity-build.js` passed.
- All 46 inline `index.html` script blocks passed `node --check` parsing.
- `npm run build:netlify` passed and refreshed `dist/`.
