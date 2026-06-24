# Safe Patch Bundle Report

## Source archive

`Archive 2.zip`

## Scope

Applied only safe, scoped GPS UI/flow fixes. I did not patch the camera/framing orientation or transition-flash issues because those touch the protected framed-box camera model and should be audited before code changes.

## Files changed

- `index.html`
- `dist/index.html`
- `docs/reports/SAFE_PATCH_BUNDLE_REPORT.md`

## Fixes included

### 1. Back/Home GPS visibility

Verified already present in this package.

The GPS Back/Home selectors are scoped through `#shellTop`, which keeps the existing buttons visible in active GPS states without changing their click behaviour.

### 2. Next-hole popout visibility

Verified already present in this package.

The legacy top-centre hole switcher is hidden only outside active GPS states, instead of being globally suppressed.

### 3. Green Focus / Shot End no-save flow

Verified already present in this package.

`gdFinishActiveGreenFocus(...)` attempts Course Data saving only when a pending/held shot exists, then clears Green Focus, advances to the next hole state, and shows either:

- `Shot saved · H# ready`
- `No shot saved · H# ready`

This preserves Course Data integrity while avoiding a stuck Green Focus flow.

### 4. Wind active tool persistence

Added.

When Wind is active, the Wind button remains visible as a compact on-screen control even when the full tool rail is closed.

Added class ownership:

- `gdWindToolActive`

This class is synced from the existing `gdHasWindVector()` state inside `gdSyncWindButton()`.

### 5. Wind origin/current visual indicator

Refined.

The existing wind effect line is now more subtle and includes:

- small origin/aim dot
- thin dashed line
- small current/landing dot

This keeps Wind readable without turning it into a data dashboard.

## What was not changed

- GPS camera/framing owner
- Hole-frame transition logic
- Shot-framing orientation logic
- Bubble maths
- Practice systems
- Green Wand
- Auto Course Mapper
- Course Data transaction rules
- Pretend GPS
- Legacy Two-Tap
- Green Zoom / Green Focus ownership
- Wind live-feed logic

## Checks run

- All 46 inline `index.html` script blocks passed `node --check`.
- `scripts/gd-shot-events.js` passed `node --check`.
- `scripts/gd-course-library-pin-lock.js` passed `node --check`.
- `scripts/clarity-build.js` passed `node --check`.

## Known remaining issues requiring audit first

### Hole transition flash / lingering map surface

Likely involves captured frame timing, blackout layer timing, or live-map/captured-surface ownership. Do not patch casually.

### Shot framing not always straight down screen

Likely involves local fairway route axis, shot orientation, or camera owner logic. This belongs to the framed-box camera audit/patch sequence, not a quick UI patch.
