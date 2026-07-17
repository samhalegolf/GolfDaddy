# Clarity Caddy — V11 Hole Image + Green Truth Cluster Foundation

## Intent

This update starts the captured-hole-image direction without adding another forced camera workaround.

The key product rule is now explicit in code:

> Green truth beats tee/start truth. The tee is an orientation helper. The green cluster is the shot-decision anchor.

## Added

### Green Truth Cluster

New global helpers:

- `window.gdBuildGreenTruthCluster(reason)`
- `window.gdLoadGreenTruthCluster()`
- `window.gdGreenTruthClusterBounds()`
- `window.gdValidateGreenTruthConsensus()`

The cluster stores:

- green centre
- front/back/left/right markers
- optional green polygon
- marker offsets from centre in metres
- marker bearings/distances from centre
- confidence and source

Markers are derived from the generated/saved green shape where possible. If a shape is unavailable, the system creates a low-confidence centre-radius estimate only.

### Consensus handling

The green shape/markers are treated as a relationship cluster, not individual points.

Rules:

- If most markers agree with their saved relationship to centre, the cluster is trusted.
- If one marker is off, it can be rejected.
- If all markers are scattered/off, the cluster fails consensus and should be manually confirmed/re-scanned.
- Green cluster alignment is prioritised over tee/start alignment.

### Geo-registered Hole Image Manifest

New global helpers:

- `window.gdBuildHoleImageCaptureManifest(reason)`
- `window.gdLoadHoleImageCaptureManifest()`
- `window.gdRenderHoleImageCamera()`
- `window.gdShowHoleImageCamera(enabled)`
- `window.gdLatLngToHoleImagePx(latLng, manifest)`

The manifest stores:

- active tile URLs at a safe capture zoom
- image width/height
- world pixel origin
- green truth cluster
- green marker pixel coordinates
- tee pixel coordinate when available
- capture zoom and source tile layer

This is the base for the future static/captured hole-image renderer. It avoids trying to use a dumb screenshot; it keeps lat/lng-to-image-pixel mapping.

### Camera integration

The existing framed-box camera now asks the green truth cluster for green bounds first.

Lock/zoom still use the V9/V10 framed camera path, but the object being framed is now based on the preserved green cluster instead of trusting any oversized old green scan/object bounds.

## Non-goals in this patch

This does not fully replace the live Leaflet view with the static hole-image camera by default yet. The static layer can be rendered for debug using:

```js
window.gdShowHoleImageCamera(true)
```

That is deliberately not forced on in normal play until the overlay/bubble renderer is moved onto the image coordinate system.

## Debug globals

- `window.gdGreenTruthCluster`
- `window.__gdLastGreenTruthCluster`
- `window.__gdLastGreenTruthConsensus`
- `window.gdHoleImageCaptureManifest`
- `window.__gdLastHoleImageCaptureManifest`
- `window.__gdHoleImageCameraRendered`

## Checks

- Netlify build script passed.
- V11 script syntax passed.
