# UPDATE APPLIED — Simple Camera Rebuild V14

## Intent

This pass implements the clean camera model from the handover:

```text
object bounds -> frame rect -> scale/translate
```

V14 is added as the final camera owner layer at the end of `index.html`. Older V8-V13 camera code remains in place for history, but V14 reasserts the public camera entry points after the delayed V13 boot so the old broad-hole and green-focus paths cannot win afterward.

## Main behavior

- Setup / pre-frame fits the fresh green object into `GREEN / HOLE FRAME`.
- Lock fits the active shot object into `LOCK FRAME`.
- Target zoom fits the same active shot object into `GREEN / LANDING ZOOM`.
- Tee/start is used for orientation only and is not included in setup, lock, or target zoom fit bounds.
- Fresh mode bypasses saved camera-derived objects by default.
- Old `setView`, `fitBounds`, `panTo`, and `flyTo` calls are blocked while setup, lock, or target zoom owns the camera unless the move is explicitly marked as a V14/simple-camera move.

## Public helpers

```js
gdEnterSetupGreenFrame()
gdEnterShotLockFrame()
gdToggleTargetZoomSimple()
gdResolveSetupGreenObject()
gdResolveActiveShotObject()
gdGetFrameRect(frameName)
gdFitObjectToFrame(objectBounds, frameName, options)
gdApplySimpleCameraTransform(transform, owner, options)
gdSimpleFrameUseSavedCourseObjects(false)
gdResetSimpleCameraFresh()
```

## Debug readout

When frame debug is on, the small readout now reports:

```text
camera owner
frame
object
source
fit bounds
scale
blocked old camera calls
```

## Saved object handling

Fresh camera mode is the default. It clears/bypasses only camera-derived cache keys such as green-truth cluster and hole-image manifest state. It does not delete user course data, course library objects, profile data, or shot data.

Use this only for comparison:

```js
gdSimpleFrameUseSavedCourseObjects(true)
```

Use this before a clean QA pass:

```js
gdResetSimpleCameraFresh()
```
