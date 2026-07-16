# Update Applied — Safe Raster Visual Zoom V15

## Purpose

Keep the simple V14 object-to-frame fitter, but stop Leaflet from requesting unavailable deep satellite tiles when the fitter needs an aggressive visual zoom.

The screenshot after Codex showed the fitter was selecting the right object/frame:

- camera owner: setupGreenFrame
- frame: hole
- object: fresh fit bounds around green size
- old camera calls blocked

The visible failure was tile availability: `Map data not yet available`.

## What changed

Added a final V15 layer after V14:

- `gdSafeRasterVisualZoomV15`
- Caps native raster tile requests to zoom 18 by default.
- Allows the Leaflet map to remain visually zoomed higher for frame composition.
- Forces tile layers to use safe `maxNativeZoom` and higher `maxZoom` for overzooming.
- Adds a transparent `errorTileUrl` for genuine missing tile errors.
- Wraps `map.setView` / `map.fitBounds` and the V14 frame functions so safe raster settings are applied before and after camera moves.
- Adds `gdForceSafeRasterVisualZoom()` for manual console forcing.
- Adds a small debug readout when frame debug is on.

## What did not change

- Did not rewrite the V14 simple object fitter.
- Did not re-enable saved V11 hole-image or green-truth camera manifests.
- Did not deploy or perform live/credit-draining checks.

## Testing done

- Inline script syntax check passed.
- `npm run build:netlify` passed locally.

## Console helpers

```js
gdForceSafeRasterVisualZoom()
window.__gdV15SafeRasterState
window.__gdV15LastVisualOverzoom
```
