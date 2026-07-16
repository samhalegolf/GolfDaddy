# Update Applied — Manual Target Green Camera V16

Purpose: fix the remaining post-V15 issue without another large camera rebuild.

V15 proved the safe raster/overzoom path works better than requesting impossible satellite zooms. The remaining issue was object source: setup could still derive the green object from stale live/mapped/course objects or a stale polygon instead of the current manual green/target.

## Changes

- Added `gdManualTargetGreenCameraV16` as the final override layer.
- Setup/pre-frame now uses the current manual target/green point first:
  1. `target`
  2. `window.target`
  3. `greenCentre`
  4. `window.greenCentre`
  5. `targetMarker.getLatLng()`
  6. `greenMarker.getLatLng()`
- Setup does **not** use mapped course payloads as a source.
- Green polygon/outline is accepted only if it is within 32m of the current target/green point.
- If no valid local polygon exists, setup uses a simple current-green circle bounds of about 21m.
- Lock still uses the active shot object first, but falls back to current manual green instead of full-hole bounds.
- Head-to-tee, mapped prelock, queue prelock, focus prelock, `frameShotView`, and `lockFrame` are re-pointed through the V16 simple flow.
- Lowered the native raster tile cap from z18 to z17 to avoid tile providers returning baked “Map data not available” imagery at z18.
- Kept visual zoom allowed up to ~z23.5 so the frame can still be aggressive without requesting deeper native tiles.

## Debug helpers

```js
gdCurrentManualGreenLLV16()
gdCurrentManualGreenBoundsV16()
gdForceRasterCapV16()
window.__gdV16LastSetup
window.__gdV16Installed
```

## Not done

- No deployment.
- No live browser checks.
- No large screenshot/capture rebuild.
- No new hole-image manifest system.

