# Update Applied — Framed Box Camera Rebuild

This patch rebuilds the lock-in / zoom camera path around the handover's framed box system.

## Changed

- Added real screen-relative target frame rectangles for `hole`, `lock`, `zoom`, and `tee`.
- Added a visible-by-default dotted debug overlay controlled by:
  - `window.gdTargetFrameDebug = true/false`
  - `gdSetTargetFrameDebug(enabled)`
- Replaced green zoom button behaviour with `gdToggleTargetZoom()`.
- Rewired `gdToggleSimpleGreenZoom` to the new target-based zoom so old calls still work.
- Rewired `frameShotView()` and `lockFrame()` so lock-in fits the active object bounds into the `LOCK FRAME` rather than broadly fitting start + target + hole context.
- Added active shot target mode resolver:
  - `greenTarget` when current selected shot can reach the green.
  - `fairwayLanding` when the current selected shot cannot reach the green.
- Added hysteresis to reduce mode flicker near the reach threshold.
- Added object bounds helpers:
  - `gdGetGreenObjectBounds()`
  - `gdGetBubbleObjectBounds()`
  - `gdGetFallbackPointBounds()`
  - `gdGetActiveShotObjectBounds()`
- Added `gdFitObjectBoundsToScreenFrame(objectBounds, frameName, options)`.
- Added fairway landing safe-zone nudge logic so dragging the bubble inside the usable frame does not constantly refit the map.
- Made green outlines subtle rather than hidden.

## Important behaviour

- Lock-in no longer includes tee/start in the camera fit.
- Zoom no longer triggers old green focus mode or changes shot state.
- If the green is unreachable by the currently selected shot/club, the bubble becomes the framed object.
- The debug boxes should appear on load for live testing.

## Test focus

1. Dotted frame boxes are visible on load.
2. Lock-in frames the green/bubble tightly into `LOCK FRAME`.
3. Zoom frames the green/bubble more aggressively into `GREEN / LANDING ZOOM`.
4. Layup / unreachable shots frame the fairway landing bubble, not the whole hole.
5. Dragging the bubble inside the fairway frame does not cause full repeated refits.
