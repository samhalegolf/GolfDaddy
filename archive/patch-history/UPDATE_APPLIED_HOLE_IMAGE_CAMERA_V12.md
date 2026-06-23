# Update Applied — Hole Image Camera V12

## Source handover
Built against: `clarity-caddie-hole-image-camera-system-handover(1).md`.

## What changed

Added a final `gdHoleImageCameraV12` ownership layer at the end of `index.html` so it wins over earlier V8/V9/V10/V11 camera patches without deleting them.

### Added camera ownership contract

Exposes:

```js
window.GD_CAMERA_OWNER = {
  LIVE_MAP: "liveMap",
  HOLE_FRAME_SETUP: "holeFrameSetup",
  SHOT_LOCK: "shotLock",
  TARGET_ZOOM: "targetZoom",
  HOLE_IMAGE_QA: "holeImageQa"
};

window.SHOT_TARGET_MODE = {
  GREEN_TARGET: "greenTarget",
  FAIRWAY_LANDING: "fairwayLanding"
};
```

### Added Hole Image QA modes

Exposes:

```js
gdSetHoleImageCameraTestMode("off")
gdSetHoleImageCameraTestMode("overlay")
gdSetHoleImageCameraTestMode("imageOnly")
```

Behaviour:

- `overlay`: live Leaflet remains visible; geo-registered tile manifest renders over it at partial opacity.
- `imageOnly`: Leaflet is hidden/dimmed; hole image layer renders by itself.
- `off`: restores normal live-map behaviour.

### Added Hole Image lock/zoom renderer

Exposes:

```js
gdFrameActiveShotOnHoleImage("lock")
gdFrameActiveShotOnHoleImage("zoom")
```

When a valid hole image manifest exists:

- `lockFrame()` switches visual ownership to the Hole Image Camera.
- `gdToggleTargetZoom()` uses the Hole Image Camera and restores the previous shot transform on second tap.
- Active object is resolved from the existing green/bubble bounds logic.
- Green polygon, truth markers, tee marker, aim line, active object bounds, and fairway bubble ellipse render from image coordinates.

If no valid manifest exists, the code falls back to the previous lock/zoom behaviour.

### Added defensive camera gate

V12 installs a final `map.setView()` / `map.fitBounds()` guard. While V12 owns the camera, older broad-hole/green-focus/arrival/map refit paths are blocked unless explicitly allowed with `__gdV12Allow`.

Debug counters:

```js
window.__gdV12CameraBlocked
window.__gdCameraOwnerV12
window.__gdHoleImageCameraState
window.__gdHoleImageCameraTransform
```

## Main code conflicts found

These were the likely systems fighting the new behaviour:

- Older `frameShotView()` uses `map.fitBounds()` and includes start/green/pin context.
- Multiple historical `gdToggleTargetZoom()` overrides still exist from earlier patches.
- V9 created a camera gate but still worked by moving the live Leaflet map.
- V10 capped native tile requests but still depended on aggressive Leaflet zoom.
- V11 built the green truth cluster and hole-image manifest, but then wrapped and called the old lock/zoom paths, allowing Leaflet camera ownership to continue.
- Course-library mapped-hole functions in `scripts/gd-course-library-pin-lock.js` still contain `setView()` / `fitBounds()` calls; V12 blocks these while shot lock/target zoom/QA owns the camera.

## Validation run

- Extracted all inline scripts and ran `node --check` against each script block.
- Ran `npm run build:netlify` successfully.
- Confirmed V12 is present in both `index.html` and `dist/index.html`.

## Manual QA

1. Map/select a hole with green centre/shape.
2. In console, run:

```js
gdSetHoleImageCameraTestMode("overlay")
```

Confirm live map remains visible and the hole-image layer lines up with the green.

3. Run:

```js
gdSetHoleImageCameraTestMode("imageOnly")
```

Confirm the captured hole image appears without jumping to a random location.

4. Run:

```js
gdSetHoleImageCameraTestMode("off")
```

Confirm normal map returns.

5. Lock a shot. Confirm:

- no unavailable grey/white satellite tiles,
- old green focus does not fire,
- tee/start is not included in the locked composition,
- active green/bubble is fitted into the lock frame.

6. Tap target zoom. Confirm:

- active object fits into the larger zoom frame,
- second tap returns to the previous shot camera transform,
- the old green-focus path does not take over.
