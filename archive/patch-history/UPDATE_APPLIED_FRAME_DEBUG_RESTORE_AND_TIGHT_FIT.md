# Update Applied — Frame Debug Restore + Tight Object Fit

This patch restores the visible target-frame debug overlay and tightens the camera framing behaviour.

## What changed

- Restored `gdSetTargetFrameDebug(true)` by default for testing.
- Added visible dotted debug boxes for:
  - `GREEN/LANDING ZOOM`
  - `LOCK FRAME`
  - `GREEN/HOLE FRAME`
  - `TEE FRAME`
- Moved the frame boxes higher on the screen.
- Changed `frameShotView()` so it first tries to fit the active object bounds into the lock frame:
  - green shape / green outline when green-target mode applies,
  - shot bubble bounds when fairway-landing mode applies.
- Only falls back to the old broader hole fit if object-bounds fitting fails.

## Testing expectation

In locked-in mode, the app should now try to make the green or shot bubble fill the visible lock frame much more aggressively. The frame boxes remain visible so the framing can be tuned directly from the phone screenshot.

## Turning off debug frames later

Call:

```js
gdSetTargetFrameDebug(false)
```

or change the startup call from `gdSetTargetFrameDebug(true)` to `gdSetTargetFrameDebug(false)`.
