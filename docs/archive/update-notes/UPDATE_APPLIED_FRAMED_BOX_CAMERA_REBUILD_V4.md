# UPDATE APPLIED — Framed Box Camera Rebuild V4

This patch fixes the issue found across the last two framed-box deploys.

## Diagnosis

V2 contained the debug-frame CSS and visible dotted boxes, but the camera fit was still too broad/shy.

V3 added the stronger camera-fitting override, but the packaged deploy accidentally only included a tiny CSS correction for the tee label and did not include the base debug-frame CSS (`#gdTargetFrameDebugOverlay`, `.gdTargetFrameBox`, and `body.gdTargetFrameDebugOn`). Result: the JS could create the boxes but they could be invisible. This made it look like the deploy had reverted or the debug overlay had disappeared.

The old broad frame systems were also still present earlier in `index.html`, so this V4 patch appends a final override at the very end of the file. That makes the framed-box camera the last system to win.

## What V4 changes

- Restores full debug overlay CSS in the final deploy.
- Keeps the tee frame low and treats it as a setup/hole-frame guide only.
- Reasserts `frameShotView`, `lockFrame`, `gdToggleTargetZoom`, `gdFitObjectBoundsToScreenFrame`, `gdGetActiveShotObjectBounds`, and `gdSetTargetFrameDebug` at the end of the file.
- Makes lock-in fit only the active object into the lock frame:
  - green bounds when the current shot can target the green,
  - bubble bounds when the shot is a fairway/layup target.
- Adds a short delayed refit sequence after lock/render so older render or state-sync calls cannot immediately pull the camera back to the broad hole view.
- Keeps fairway landing camera stable with safe-zone nudging instead of repeated full `fitBounds` while dragging.

## Acceptance checks

1. Dotted frame boxes should be visible immediately on app load.
2. Tee frame should be low, near the bottom/start region, and only relevant to setup/hole framing.
3. Lock-in should ignore the tee/start and fit the green or bubble into the lock frame.
4. Zoom button should fit the active green/bubble into the zoom frame and tap again should restore the prior view.
5. If the camera still reverts, check browser console for `window.__gdFramedBoxCameraSystemV4 === true` and inspect which function is calling `map.fitBounds` after lock.
