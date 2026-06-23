# Update Applied — Framed Box Camera Rebuild V5

## Intent
This update makes the framed-box camera system bold enough to replace the old broad hole-fit behaviour.

## Key changes
- Added a final V5 override at the end of `index.html` so older camera paths cannot win after render.
- Removed broad-hole fallback from lock/zoom framing.
- Lock-in now fits only the active target object into the LOCK FRAME:
  - green target mode = green-sized target bounds only.
  - fairway landing mode = bubble bounds only.
- Tee frame is only a setup / hole-frame reference and is not used by lock-in or target zoom.
- Replaced cautious Leaflet `fitBounds` behaviour with direct projected-pixel fitting:
  - measures object pixel size at current zoom,
  - calculates the zoom needed for the object to fill the chosen screen frame,
  - recentres the object inside the frame,
  - allows fractional zoom with `zoomSnap = .01`.
- Increased lock fill ratio and zoom fill ratio.
- Green bounds are kept green-sized; fairway / whole-hole shapes are rejected.
- Layup/fairway mode only happens when the target/bubble is genuinely off the green, not from a cautious reach fallback.
- Debug frame overlay CSS is forced on and remains visible when `window.gdTargetFrameDebug !== false`.

## Acceptance focus
- Green should be much tighter in the lock frame.
- Zoom should be very aggressive.
- Tee/start must not pull the camera back out during lock-in.
- No old broad hole framing should run after lock/render.

## Build check
- Ran `npm run build:netlify` successfully.
