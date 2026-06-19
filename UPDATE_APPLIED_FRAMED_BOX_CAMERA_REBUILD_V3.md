# Update Applied — Framed Box Camera Rebuild V3

This patch tightens the framed-box camera system based on live screenshots showing that lock-in was still too broad and the tee frame was sitting too high.

## Main changes

- Added `gdFramedBoxCameraSystemV3` as the final override layer after earlier camera patches.
- Moved `TEE FRAME` lower on the screen. It is now treated as a hole-frame/setup guide only, not part of lock-in framing.
- Made lock-in aggressively frame only the active shot object:
  - reachable green: green bounds/green centre,
  - fairway/layup: shot bubble bounds.
- Reduced over-guarding in reach logic:
  - the camera now stays in green framing unless the green is clearly out of reach or the shot is explicitly a layup.
- Added stronger green-bound sanitising so a broad hole/fairway shape cannot accidentally become the lock target.
- Replaced the shy `fitBounds` behaviour with a frame-centred camera calculation:
  - compute object bounds,
  - compute desired zoom for the selected frame,
  - boost zoom slightly so the target fills/bleeds the box,
  - place the object centre at the selected frame centre.
- Relaxed Leaflet `zoomSnap` for this camera system so fractional zoom can be used.
- Re-overrode:
  - `gdScreenTargetFrameRect`,
  - `gdTargetFramePadding`,
  - `gdGetGreenObjectBounds`,
  - `gdGetBubbleObjectBounds`,
  - `gdGetActiveShotObjectBounds`,
  - `gdFitObjectBoundsToScreenFrame`,
  - `gdFrameActiveShot`,
  - `gdToggleTargetZoom`,
  - `gdToggleSimpleGreenZoom`,
  - `frameShotView`,
  - `lockFrame`.

## Live test focus

1. Confirm dotted boxes are visible on load.
2. Confirm `TEE FRAME` is now low and is not influencing lock-in.
3. Set start + green, then lock in.
4. Confirm green fills the `LOCK FRAME` much more aggressively.
5. Tap zoom and confirm green/landing target fills the `GREEN / LANDING ZOOM` frame.
6. Pull the bubble shorter / lay up and confirm the camera uses the bubble instead of the green.

## Notes

This patch intentionally prioritises the framed-box product behaviour over older broad-hole safeguards. Lock-in is now a camera framing state around the shot decision, not a whole-hole view.
