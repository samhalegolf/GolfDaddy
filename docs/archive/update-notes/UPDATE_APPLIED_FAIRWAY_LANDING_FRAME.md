# Update Applied — Fairway Landing Frame + Stable Camera

## Product correction
When the selected/current playable club cannot reach the green, the shot should stop using the green as the camera focus. In that scenario the fairway landing point / bubble centre becomes the active target frame point.

## Changes made

### Active shot target mode
Added a lightweight shot target mode resolver:

- `greenTarget` when the current club/shot can reasonably reach the green.
- `fairwayLanding` when the target is a layup or the current selected club/shot cannot reach the green.

This is based on the current shot state, not only the hole state.

### Short par 4 behaviour
The app can now handle the test case discussed:

1. A short par 4 starts with the bubble on/near the green if the selected club can reach.
2. If the user pulls the bubble shorter and the selected/suggested club changes into a club that cannot reach the green, the shot mode switches to `fairwayLanding`.
3. The camera reframes around the fairway/bubble landing area instead of continuing to prioritise the green.

### Stable fairway camera
Fairway/layup mode now behaves like a stable workbench:

- The camera frames the landing zone once.
- The bubble can move inside that frame.
- The camera does **not** chase the bubble during normal dragging.
- If the bubble is pulled near the edge of the usable frame, the camera gently nudges just enough to keep it usable.

### Green / landing zoom
The existing simple zoom button now zooms to the active shot focus point:

- Green reachable: zooms around the green/bubble target.
- Green not reachable: zooms around the fairway/bubble landing point.

The button remains intentionally simple. It does not create a new locked toolbar, does not trigger green focus mode, and does not change shot state.

### Anti-tail-spin guard
Added hysteresis around the club-can-reach-green decision so the app does not rapidly flip between green and fairway mode when the chosen club is right on the edge of reaching the green.

## Files changed

- `index.html`
- `dist/index.html` regenerated via `npm run build:netlify`

## Checks

- `npm run build:netlify` passed.
- Inline script syntax check passed.

## On-device checks still needed

- Short par 4: start with bubble on green, pull shorter into 3W/fairway landing behaviour.
- Confirm camera reframes once, then stays stable.
- Confirm dragging near the edge nudges gently rather than chasing constantly.
- Confirm green/landing zoom returns to previous view.
