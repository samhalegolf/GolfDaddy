# UPDATE APPLIED — Simple Object Frame Camera V13

## Intent

V12 had too many camera layers still competing with each other. The fix is deliberately simpler:

```text
object bounds -> chosen frame -> scale/translate
```

The camera should not fit the whole hole. It should not include tee/start in lock. It should not let saved mapped-course or saved hole-image objects influence the current test pass.

## What changed

Added `gdSimpleObjectFrameCameraV13` at the end of `index.html` so it wins after the older V8/V9/V10/V11 camera systems load.

### Main behaviours

- Setup / pre-frame now fits a fresh green object into the `GREEN / HOLE FRAME`.
- Lock now fits the active shot bubble/object into the `LOCK FRAME`.
- Target zoom now fits the same active shot object into the `GREEN / LANDING ZOOM` frame.
- Tee/start is used only for orientation where available, not as part of setup/lock bounds.
- Debug overlay remains visible for testing.
- A small debug readout appears when frame debug is on, showing:
  - owner
  - object
  - frame
  - fresh/saved source
  - zoom

## Saved object pause

For fresh camera testing, V13 pauses the saved camera-object path by default:

- removes localStorage keys matching:
  - `green_truth_cluster_v1`
  - `hole_image_manifest_v1`
- blocks new writes to those keys while `window.gdSimpleFrameFreshCamera !== false`
- makes `gdLoadHoleImageCaptureManifest()` return `null`
- makes `gdBuildHoleImageCaptureManifest()` return `null`

This does not delete the actual course library data. It only prevents the camera test from being polluted by the saved V11 hole-image/green-truth cache.

## New test helpers

```js
gdResetHoleImageFresh()
```

Clears the saved hole-image / green-truth camera cache again.

```js
gdSimpleFrameUseSavedCourseObjects(false)
```

Default. Keeps the camera using fresh live objects only.

```js
gdSimpleFrameUseSavedCourseObjects(true)
```

Allows old saved/derived green bounds again if needed for comparison.

```js
gdSimpleFrameSetup()
gdSimpleFrameLock()
gdToggleTargetZoom()
```

Manual test entry points.

## Functions overridden last

V13 overrides these after older systems:

- `gdFrameMappedPreLockPreset`
- `gdFrameMappedPreLockHoleView`
- `gdQueueMappedPreLockHoleFrame`
- `gdFocusMappedPreLockHole`
- `gdReturnToPreLockPrompt`
- `gdFrameActiveShot`
- `frameShotView`
- `lockFrame`
- `gdToggleTargetZoom`
- `gdToggleSimpleGreenZoom`

## Why this should fix the V12 screenshots

### Screenshot 1

The previous setup camera was still framing tee + green / whole-hole composition.

V13 setup now uses:

```text
fresh green bounds -> GREEN / HOLE FRAME
```

The tee/start no longer gets to pull the green down or zoom the whole hole out.

### Screenshot 2

The lock camera was still using old padding/fill logic and could be influenced by the wrong object/frame.

V13 lock now uses:

```text
active shot bubble bounds -> LOCK FRAME
```

No tee. No full hole. No green/hole frame for lock.

## Validation

- Extracted inline script blocks and ran `node --check` against them.
- Ran `npm run build:netlify` successfully.
- Confirmed V13 appears in both root `index.html` and `dist/index.html`.

## Testing notes

1. Hard refresh the deployed app.
2. Run this in console if needed:

```js
gdResetHoleImageFresh()
```

3. Start a fresh hole test.
4. In setup, confirm green moves into `GREEN / HOLE FRAME` rather than framing the whole hole.
5. Lock a shot.
6. Confirm bubble/object fills the `LOCK FRAME`.
7. Tap target zoom.
8. Confirm the same active object fills `GREEN / LANDING ZOOM`.
9. Watch the debug readout to confirm the active owner/frame/object.
