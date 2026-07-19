# Green Wand Engine Extraction Map

Date: 2026-07-19
Branch: `structural-rebuild`
Baseline: `6bdbaf9 Consolidate GPS scorecard owner`

## Product Decision

Green Wand is no longer protected as a standalone user-facing GPS tool. The protected boundary is now the working green-shape detector that can serve AutoMapper later.

Historical restrictions that are superseded:

- Preserve the standalone Wand screen entry.
- Preserve the GPS rail Wand button as a product surface.
- Preserve floating/compact Wand panel chrome.
- Preserve open/close rescue wrappers and duplicate DOM observers.
- Preserve standalone save orchestration as the long-term mapping path.

Restrictions that still apply until tests protect behavior:

- Do not change image/tile crop sampling behavior casually.
- Do not change colour/tone segmentation, probe selection, ridge detection, magnetic boundary growth, shell/polygon generation, confidence inputs, size/rejection gates, or pixel-to-map conversion behavior during extraction.
- Do not let the detector open UI, mutate GPS state, move the map, save records, or decide AutoMapper acceptance.

## Current Script And Core Counts

- Source script tags in `index.html`: 60 after extraction; 59 before extraction.
- `scripts/gd-app-core.js`: 26,322 lines after extraction; 26,977 before extraction.
- `scripts/gd-green-shape-engine.js`: 658 lines.
- Wand/engine source scripts currently loaded directly: `scripts/gd-green-shape-engine.js`, `scripts/inline/gd-wand-belt-layers-v1.js`, and `scripts/inline/gd-wand-flow-layers-v1.js`.
- Wand CSS currently loaded directly: `styles/inline/gd-wand-root-cause-clean-css-v1.css`, `styles/inline/gd-wand-robust-known-good-css-v1.css`, `styles/inline/gd-wand-compact-flow-css-v1.css`, `styles/inline/gd-wand-floating-mapper-css-v1.css`.

## A. Detection Engine

Preserve/move after behavior fixtures pass:

- `scripts/gd-green-shape-engine.js`: `window.GolfDaddyGreenWandEngine` / `window.ClarityCaddieGreenWandEngine` / `window.GDGreenShapeEngine`.
- `GREEN_WAND_MODE_PRESETS`, `GREEN_WAND_MODE_ORDER`, `buildFilterString`, `polygonPath`, `analyzeGreenWand`, `getModeDefaults`.
- Internal detector helpers around the same block: pixel sampling, tone/luma scoring, local contrast, radial probe generation, neighbour support, continuity selection, ridge line construction, ridge snap profile, healthy bubble fitting, outer shell/inset shell generation, inside/outside edge comparison, smoothing, centroid/radius helpers.
- Readers: `scanGreen()` in `scripts/gd-app-core.js`; `currentWandPreset()` in `scripts/gd-app-core.js`; new behavior fixture.
- Writers/globals: assigns `window.GolfDaddyGreenWandEngine` once and aliases `window.ClarityCaddieGreenWandEngine`.
- DOM/map globals used by core detector: `document.createElement("canvas")` only. It does not use Leaflet, body classes, `map`, `greenCentre`, course records, or Wand panel DOM.
- Classification: algorithm.
- AutoMapper impact: none today.
- Recommendation: preserve in `scripts/gd-green-shape-engine.js`; add a narrower `detect()` wrapper in a later commit after deciding whether `gdValidateWandOutline` belongs inside the engine contract or adapter validation.

## B. Engine Adapters

Preserve now; move or rewrite after engine extraction:

- `scripts/gd-app-core.js`: `gdGetGreenCentreForTileCrop`, `gdBuildGreenCentredTileCropV2`, `gdWandSeedForBuiltCanvas`, `gdWandCanvasPointToLatLng`, `gdTilePos`, `gdCanvasHasUsefulPixels`, `tryBuildMapCanvas`.
- `scripts/gd-app-core.js`: `getMapMetersPerPixelAt`, `captureWandScaleLock`, `getWandScaleLock`, `getExpandedWandOptions`, `normalizeSandboxWandShell`.
- `scripts/gd-app-core.js`: `gdValidateWandOutline` currently owns final geometry rejection for tiny, oversized, drifting, or weak edge-family results. The raw detector still returns a shell for weak/no-match imagery, so this guard must move with the future engine contract or become an explicit adapter validation step.
- Readers/writers: read `map`, `greenCentre`, `target`, `lockedFrame`, Leaflet tile DOM, `snapshotPixelSource`, map-source fallback; write `greenPixelAccessOk`, `wandScaleLock`, `window.__lastWandCanvasBuild`.
- DOM elements used: `#map`, Leaflet tile images and panes.
- Classification: adapter.
- AutoMapper impact: indirect only. Mapping mode can hydrate a green centre for Wand, but AutoMapper does not call the detector.
- Recommendation: rewrite as an AutoMapper-facing crop/projection adapter later. Keep with standalone UI for the temporary compatibility step.

## C. Standalone Wand UI

Delete after extraction, not now:

- `index.html`: `#gdWandPanel`, calibration sliders, scan/accept/reject/exit buttons, `#greenFinderToggle` retired row.
- `scripts/gd-app-core.js`: `toggleGreenWand`, `closeWandPanel`, `gdRequestWandControlRescan`, `setWandBaseBubble`, `setWandClusterPull`, `setWandMode`, `setWandSensitivity`, `updateWandStatus`, `runGreenWandScan`, `drawQuickShapeGreen`, `drawFallbackGreen`, `makeWandResult`, `clearWandHandles`, `makeEditableGreen`, `acceptGreenWand`, `rejectGreenWand`, `importGreenWandResult`, `drawGreenPolygon`, `drawGreenDistances`, `openGpsWand` hotfix block.
- `scripts/inline/gd-wand-flow-layers-v1.js`: compact open/scan/accept/exit flow, floating mapper panel positioning, Wand layer body class sync.
- `styles/inline/gd-wand-robust-known-good-css-v1.css`, `gd-wand-compact-flow-css-v1.css`, `gd-wand-floating-mapper-css-v1.css`, `gd-wand-root-cause-clean-css-v1.css`.
- DOM elements used: `#gdWandPanel`, `#gdWandScanBtn`, `#gdWandAcceptBtn`, `#gdWandRejectBtn`, `#gdWandExitBtn`, `#gdWandSensitivity`, `#gdWandBaseBubble`, `#gdWandClusterPull`, `#greenToolBtn`, `#dockGreen`, `#tolValue`.
- Map globals used: `map`, `L`, `greenCentre`, `greenPolygon`, `greenOutline`, `greenSoft`, `greenLabel`, `frontLabel`, `backLabel`, `target`, `start`.
- Classification: UI and UI-to-engine orchestration.
- AutoMapper impact: mapping tools can open this UI as a manual fallback path.
- Recommendation: keep only until the engine is isolated, then delete or replace with a small mapper debug/manual review surface.

## D. Diagnostics

Preserve only the useful AutoMapper debugging parts:

- `scripts/inline/gd-wand-belt-layers-v1.js`: inert `collectWandDiagnostics` / `showWandDiagnostics` compatibility stubs remain. The unreachable UI body and dead CSS were deleted after the startup/dependency audit.
- `scripts/inline/gd-wand-belt-layers-v1.js`: inert `gdShowWandSampleTruth` compatibility stub remains. The unreachable sample-truth panel body and dead CSS were deleted after the startup/dependency audit.
- `scripts/gd-app-core.js`: `drawWandDebugAnalysis` and `gdWandDebugOverlayEnabled`. Useful for future AutoMapper debugging if converted to diagnostics data rather than Leaflet overlays.
- Deleted in the startup/dependency audit: `styles/inline/gd-wand-diag-style.css`, `gd-wand-sample-truth-style-v1.css`.
- Classification: diagnostics.
- Recommendation: rewrite after extraction as optional engine diagnostics returned from `detect`/`refine`; delete inert buttons/panels when standalone UI is removed.

## E. Obsolete Patches And Guards

Delete after extraction when no standalone Wand UI depends on them:

- `scripts/inline/gd-wand-belt-layers-v1.js`: overlay-clean wrapper replacing `openGpsWand`, `toggleGreenWand`, `closeWandPanel`; document click guard hiding course picker.
- `scripts/inline/gd-wand-belt-layers-v1.js`: robust-known-good calibration wrapper and `wrap("openGpsWand")` / `wrap("runGreenWandScan")`.
- `scripts/inline/gd-wand-belt-layers-v1.js`: chrome sync wrapper around open/toggle/close/accept/reject.
- `scripts/inline/gd-wand-flow-layers-v1.js`: compact flow wrapper, delayed re-installs, floating panel observer, panel drag code, body `gdWandLayerActive` observer.
- `scripts/gd-route-audit.js`: `openWandStable`, dockGreen interception, route hiding of `#gdWandPanel`.
- `scripts/gd-course-library-pin-lock.js`: mapper wrappers around `acceptGreenWand`, `importGreenWandResult`, `rejectGreenWand`, `closeWandPanel`; `startMapperGreenWand` opening the standalone Wand UI.
- Classification: obsolete patch/guard around old Wand UI instability.
- Recommendation: delete after the engine exists and mapper fallback uses an explicit adapter/debug surface. Do not delete immediately because current manual mapper fallback still routes through it.

## Current AutoMapper/Wand Relationship

AutoMapper does not currently invoke the Green Shape Engine directly.

Current data flow:

1. Course mapping tries saved maps, AutoMapper, then native resolver in `runCourseMappingAttempt()`.
2. If automatic resolution fails, it can enter interactive mapper/manual fallback.
3. Mapper tools can call `startMapperGreenWand()`, which hydrates saved/current green state into globals and opens the standalone Wand UI.
4. The Wand UI runs `scanGreen()`, which calls `window.GolfDaddyGreenWandEngine.analyzeGreenWand(...)`.
5. `acceptGreenWand()` updates `greenPolygon` / `lastWandResult`; `gd-course-library-pin-lock.js` wraps accept/import and then calls `saveCurrentGreen("wand_accepted")`.
6. Saved green geometry is persisted as course object data and can later be consumed by GPS/course play.

Shared globals such as `greenCentre`, `greenPolygon`, and `greenShape` are compatibility state for the standalone Wand surface. AutoMapper's live path now uses the narrower adapter in `scripts/gd-course-library-pin-lock.js`: it builds a captured-surface crop around the candidate green, calls `GDGreenShapeEngine.detect()`, validates map geometry, and then delegates accepted polygons to the existing `saveCourseObject()` path through `saveOsmAutoHole()`.

## Future Engine Contract

Recommended narrow API:

```js
window.GDGreenShapeEngine = {
  detect(input),
  validate(result, constraints)
};
```

`detect(input)` input:

```js
{
  image,
  imageData,
  imageWidth,
  imageHeight,
  cropBounds,
  candidateCentrePx,
  projection,
  constraints,
  options
}
```

`detect(input)` output:

```js
{
  ok,
  polygonPixels,
  polygonLatLng,
  confidence,
  rejectionReason,
  diagnostics
}
```

The first extracted version may keep `analyzeGreenWand(canvas, width, height, options)` as a compatibility method while `detect()` wraps it. The engine must not open screens, mutate body classes, save course records, select courses/holes, move the Leaflet camera, own GPS state, display toasts, or decide whether AutoMapper accepts the result.

## Extraction Decision

Boundary status: clear enough for behavior fixtures.

Extraction status: completed after the fixture commit. The detector block moved from `scripts/gd-app-core.js` to `scripts/gd-green-shape-engine.js` with compatibility aliases preserved.

AutoMapper handoff status: the live `2146605` handoff is test-covered by `dev/automapper-green-refinement-owner.test.js` and `dev/automapper-green-refinement-behavior.test.js`. Coverage includes the single mapping-owned adapter, engine load order, captured-surface crop source, accepted result delegation through the existing save path, source metadata, dedupe, repeatability, stale attempt isolation, no Wand UI/global state calls, no GPS camera/shell/hole changes, and controlled rejection for no imagery, invalid projection, engine no-match, engine exception, low confidence, invalid polygon, non-finite polygon points, polygon drift from the candidate, stale attempt, course mismatch, hole mismatch, and stronger existing geometry.

Standalone Wand retirement status: still intentionally left for a later commit. Do not remove the standalone Wand surface until these AutoMapper refinement tests and structural CI pass.
