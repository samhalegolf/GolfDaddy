# Clarity Caddie — Tight Target Frame Fit Update

## Why this update exists
The debug frame overlay proved the camera frames were sitting too low and the map was not zooming aggressively enough. The previous implementation was still too close to a point-based camera placement system.

## Product correction
The frame boxes are now treated as real behind-the-scenes camera frames. The app should fit the current shot object into the selected frame:

- Green reachable: fit the green / hole object into the frame.
- Green not reachable: fit the shot bubble / fairway landing object into the frame.
- Zoom button: fit the same active object into the larger green / landing zoom frame.

The camera should not include the tee/start point when fitting the locked-in frame. The tee can bleed outside the screen.

## Specific changes
- Moved the debug frame boxes higher to match the marked screenshot more closely.
- Reduced the lock and zoom frame sizes to match the intended boxes rather than using overly large low boxes.
- Added object-bounds framing helpers:
  - `gdGreenObjectBounds()`
  - `gdBubbleObjectBounds()`
  - `gdShotTargetObjectBounds()`
  - `gdFitObjectBoundsToTargetFrame()`
- Changed `frameShotView()` so it first tries to fit object bounds into the lock frame.
- Changed the green / landing zoom button so it fits object bounds into the zoom frame, rather than just centring on a point.
- Reintroduced green/fairway shot target mode handling:
  - `greenTarget`
  - `fairwayLanding`
- Fairway mode uses the bubble as the object to frame.
- Fairway mode keeps a stable camera and only nudges if the bubble is pulled near/outside the lock frame.

## Testing notes
Use the visible dotted debug frames to verify:

1. The frames sit high enough under the player badge and above the bottom controls.
2. Lock-in fits the green or bubble into the lock frame.
3. Green/landing zoom fills the larger zoom frame more aggressively.
4. On a short par 4, pulling the bubble from green back into layup/fairway mode shifts the frame to the bubble/landing area.
5. Fairway mode does not chase the bubble; it only nudges near the frame edge.

## Debug overlay
The dotted frames are intentionally visible for testing. They can be disabled later by calling:

```js
gdSetTargetFrameDebug(false)
```
