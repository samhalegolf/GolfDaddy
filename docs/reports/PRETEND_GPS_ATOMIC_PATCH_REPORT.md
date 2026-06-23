# PRETEND GPS ATOMIC PATCH REPORT

Version: 1.0  
Source: Pretend GPS atomic gesture patch report from the Clarity Caddy stabilisation workflow.

---

## Files Changed

- `index.html` only.
- `scripts/gd-shot-events.js` remained byte-for-byte unchanged.

---

## Exact Pretend GPS Gesture Rules Added

A Pretend GPS pointer-up now atomically:

1. Stores the active position with `simulated:true` and source `pretend-gps-position`.
2. Sets that same coordinate as the shot origin.
3. Attempts mapped-green selection once.
4. Finishes in aim when a mapped green is available, otherwise ready.
5. Never changes to the Legacy green step or displays a second-green-tap prompt.

---

## Events Suppressed

For the 1.6-second camera-settle window, map/captured-frame pointerdown, pointerup, touchstart, touchend, click, and dblclick events are intercepted.

Green Focus entry is blocked during that window, and automatic Green Focus polling now requires a fresh real GPS fix. A simulated Pretend GPS fix therefore remains ineligible after the guard expires.

---

## Legacy Two-Tap Boundary

Pretend GPS no longer:

- Calls `gdRememberTwoTapPlacement`.
- Falls back to `gdCompleteTwoTapPlacement`.
- Requests the Legacy second green tap.

Explicitly invoked Legacy Two-Tap remains unchanged:
- first tap sets the start and requests the green
- second tap sets the green and enters aim

---

## What Was Not Changed

- Camera construction
- Course Data logic
- Bubble mathematics
- Practice systems
- Green Wand
- Auto Course Mapper
- Green Zoom
- Legacy Two-Tap implementation

The existing Course Data transaction owner was preserved unchanged.

---

## Build/Test Result

Passed.

- All 46 inline JavaScript blocks parsed successfully.
- `scripts/gd-shot-events.js` syntax passed and retained its original checksum.
- `npm run build:netlify` completed successfully in a disposable build copy.
- Browser test confirmed follow-on click/tap and camera-settle sequence did not alter the simulated fix, shot origin, mapped green, transaction content, or persisted Course Data/shot storage.
- Green Focus and Legacy Two-Tap were not entered.
- Explicit Legacy Two-Tap still completed correctly.
- Patched archive integrity test passed.
