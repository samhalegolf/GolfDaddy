# UPDATE APPLIED — Framed Box Camera Rebuild V10

## Purpose

Fix the V9 aggressive framed-box camera causing grey/white “Map data not yet available” satellite tiles at high zoom.

## Root cause

The framed camera was finally zooming aggressively enough, but the map tile layer was being allowed to request native satellite tiles above the reliable imagery zoom level. ArcGIS/imagery tiles can return placeholder “Map data not yet available” tiles at those zooms.

This was not a frame-position problem. It was a tile-provider/native-zoom problem caused by the new aggressive camera doing its job.

## Change

V10 keeps the aggressive framed-camera zoom, but forces raster map layers to upscale safe native imagery instead of requesting unavailable high-native zoom tiles.

- Visual map zoom remains high for the frame fit.
- Tile native requests are capped at zoom 20.
- Leaflet tile layers are patched via `_getZoomForUrl()` so z21+ visual zoom does not request unavailable z21+ imagery.
- Existing tile layers are updated to:
  - `maxNativeZoom: 20`
  - `maxZoom: 23.5`
- Framed camera entry points now call `gdForceRasterUpscaleForAggressiveFrames()` before and after camera fits.

## Debug

Added:

```js
window.__gdFramedBoxCameraSystemV10
window.__gdV10RasterUpscale
window.gdForceRasterUpscaleForAggressiveFrames()
```

## Frame contract unchanged

- Inner = GREEN / HOLE FRAME
- Middle = LOCK FRAME
- Outer = GREEN / LANDING ZOOM
- Tee = setup only

## Acceptance check

When lock/zoom pushes in hard, the satellite imagery should remain visible/upscaled instead of turning into grey/white “Map data not yet available” tiles.
