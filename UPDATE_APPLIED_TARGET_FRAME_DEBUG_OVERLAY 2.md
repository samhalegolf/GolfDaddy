# Update Applied — Target Frame Debug Overlay

## Purpose
Added a temporary visual testing overlay for Sam's behind-the-scenes camera frames.

The goal is to let the on-phone test clearly show whether the app is using the intended screen areas for:

- green / hole frame,
- lock-in frame,
- green / landing zoom frame,
- tee frame.

## Behaviour
- The app now draws light dotted frame rectangles over the GPS screen.
- These frames are visual guides only.
- They do not intercept taps or drags.
- They do not change shot state, lock state, bubble state, or map controls.
- They are intended for tuning and can be removed/gated later.

## Code added
- `gdEnsureTargetFrameDebugOverlay()`
- `gdUpdateTargetFrameDebugOverlay()`
- `gdSetTargetFrameDebug(on)`

The overlay uses the existing `gdScreenTargetFrameConfig(kind)` values, so the boxes shown on screen should match the camera-frame logic being tested.

## Testing notes
Use this to verify the next framing update:

1. Green reachable: green/shot bubble should fill the intended green/lock/zoom frame.
2. Green not reachable: the larger fairway landing bubble should fill the lock/landing frame.
3. Green zoom button should fit the current shot object into the zoom frame.
4. Camera should not chase the bubble in fairway mode unless the bubble is pulled toward the frame edge.

## Removal later
When the frame sizes are tuned, either:

- remove `gdSetTargetFrameDebug(true)`, or
- default it to false and expose it only in admin/dev mode.
