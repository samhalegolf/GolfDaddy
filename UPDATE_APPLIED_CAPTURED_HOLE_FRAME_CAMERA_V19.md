# Update Applied - Captured Hole Frame Camera V19

## Intent

Return the camera model to the original Hole Frame concept:

```text
captured/scanned Hole Frame image -> active object bounds -> chosen screen box
```

V17/V18 made the camera wait on a strict confirmed-green loading gate. That drifted too far from the captured Hole Frame approach and could cover the home/course flow before the player was actually in a playable hole frame.

## Main changes

- Added `gdCapturedHoleFrameCameraV19` as the final camera owner after V18.
- Scoped the V18 loading gate so it cannot block normal home/course navigation.
- Re-enabled a captured Hole Frame manifest path instead of pausing it during fresh camera testing.
- Fits the captured green into `GREEN / HOLE FRAME`.
- Fits the active shot object into `LOCK FRAME`.
- Fits the active target object into `GREEN / LANDING ZOOM`.
- Uses native map fitting only as a fallback when no captured frame can be built.

## Public helpers

```js
gdBuildHoleImageCaptureManifest("manual")
gdLoadHoleImageCaptureManifest()
gdRenderHoleImageCamera()
gdShowHoleImageCamera(true)
gdFitCapturedHoleFrameToBoxV19(bounds, "hole")
gdResetHoleImageFresh()
```

## Validation

- Local build should be run with `npm run build:netlify`.
- Manual browser check should verify that home/course navigation is not covered by `Scanning green`.
- GPS pre-lock should show the captured Hole Frame image fitted into the labelled boxes instead of waiting on strict-green fallback logic.
