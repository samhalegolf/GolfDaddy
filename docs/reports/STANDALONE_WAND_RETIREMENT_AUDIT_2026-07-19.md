# Standalone Wand Retirement Audit

Date: 2026-07-19
Branch: `structural-rebuild`
Baseline HEAD: `bfe5995a3715aced18b001f11896f4db2e701c0d`

## Baseline Gate

- `git status --short`: clean before audit.
- `git branch --show-current`: `structural-rebuild`.
- `git fetch origin`: completed.
- `git rev-parse HEAD`: `bfe5995a3715aced18b001f11896f4db2e701c0d`.
- `git rev-parse origin/structural-rebuild`: `bfe5995a3715aced18b001f11896f4db2e701c0d`.
- `git log -5 --oneline`: `bfe5995`, `a90ab15`, `2146605`, `541c991`, `744f740`.
- `npm run test:boot`: passed.
- `node dev/green-shape-engine-owner.test.js`: passed.
- `node dev/green-shape-engine-behavior.test.js`: passed.
- `node dev/automapper-green-refinement-owner.test.js`: passed.
- `node dev/automapper-green-refinement-behavior.test.js`: passed.

No code was edited before this audit map.

## Product Boundary

Green Wand is no longer a standalone user-facing GPS feature. The retained product boundary is:

1. `scripts/gd-green-shape-engine.js` as the detector owner.
2. AutoMapper's constrained green-refinement adapter in `scripts/gd-course-library-pin-lock.js`.
3. Diagnostics returned through the engine/AutoMapper refinement path.

Everything whose only job is opening, styling, calibrating, accepting, rejecting, dragging, saving, or route-preserving the old standalone Wand panel is a retirement candidate.

## Classification Map

### 1. Retain Engine

- `scripts/gd-green-shape-engine.js`
- `window.GolfDaddyGreenWandEngine`
- `window.ClarityCaddieGreenWandEngine`
- `window.GDGreenShapeEngine`
- `GREEN_WAND_MODE_PRESETS`
- `GREEN_WAND_MODE_ORDER`
- `buildFilterString`
- `polygonPath`
- `analyzeGreenWand`
- `detect`
- `validateDetection`
- `getModeDefaults`
- Internal detector helpers for sampling, luminance scoring, tonal edge candidates, neighbour support, continuity selection, ridge lines, magnetic healthy-bubble fitting, shell/inset generation, confidence, and validation.

Reason: this file has no route ownership, no panel ownership, no storage ownership, no map ownership, and no save behavior. It only creates canvases for analysis and exports detector APIs.

### 2. Retain AutoMapper Adapter

- `automapperGreenShapeEngine()`
- `automapperCaptureKey()`
- `automapperRenderableManifest()`
- `automapperReadCapturedManifest()`
- `automapperLatLngToManifestPx()`
- `automapperManifestPxToLatLng()`
- `automapperConstrainedCropBounds()`
- `automapperLoadCropImage()`
- `automapperTileUrl()`
- `automapperTileIntersectsCrop()`
- `automapperBuildGreenShapeCrop()`
- `automapperGreenShapeVerdict()`
- `automapperRunGreenShapeRefinement()`
- The `saveOsmAutoHole()` call to `await automapperRunGreenShapeRefinement(...)`.
- Persistence through `saveCourseObject()` using `osm_auto_green_refined` and `greenShapeRefinement`.

Reason: this path calls `GDGreenShapeEngine.detect()` directly from a captured-surface crop, validates the resulting geometry, records accepted/rejected/skipped diagnostics, and delegates persistence to the existing course object save path.

### 3. Retain Internal Diagnostics

- AutoMapper debug events:
  - `automapper-green-shape-refinement-skipped`
  - `automapper-green-shape-refinement-rejected`
  - `automapper-green-shape-refinement-accepted`
- Engine `detect()` diagnostics:
  - `confidence`
  - `metrics`
  - `rejectionReason`
  - `diagnostics.validation`
- Test fixture diagnostics in `dev/automapper-green-refinement-behavior.test.js`.

Reason: these are useful for the retained AutoMapper/engine path and do not expose standalone Wand UI.

### 4. Delete Standalone UI

- `index.html`: `#gdWandPanel`, its close button, calibration details, sliders, save button, scan button, accept button, reject button, exit button, and inline handlers.
- `index.html`: hidden retired `Green Finder` and `Snapshot pixels` settings rows, plus `#snapshotInput` and `#snapshotCanvas`.
- `index.html`: script tags `#gdWandBeltLayersV1` and `#gdWandFlowLayersV1`.
- `index.html`: stylesheet tags `#gdWandRootCauseCleanCssV1`, `#gdWandRobustKnownGoodCssV1`, `#gdWandCompactFlowCssV1`, and `#gdWandFloatingMapperCssV1`.
- `scripts/inline/gd-wand-belt-layers-v1.js`.
- `scripts/inline/gd-wand-flow-layers-v1.js`.
- `styles/inline/gd-wand-root-cause-clean-css-v1.css`.
- `styles/inline/gd-wand-robust-known-good-css-v1.css`.
- `styles/inline/gd-wand-compact-flow-css-v1.css`.
- `styles/inline/gd-wand-floating-mapper-css-v1.css`.
- `styles/inline/gd-gps-tool-toggle-polish-style.css` selectors for `#gdWandPanel`, `#gdWandAcceptBtn`, `#gdWandExitBtn`, and `#greenToolBtn.gdWandLive`.
- `styles/inline/gd-gps-polish-priority-v1.css` selectors for `body.gdWandLayerActive`, `#gdWandPanel`, and `.gdWandHandle`.
- `styles/inline/gd-app-base.css` standalone Wand panel and handle CSS.

Reason: all of this directly renders, opens, positions, or styles the old panel.

### 5. Delete Compatibility Wrappers

- `scripts/gd-app-core.js`: `openGpsWand()` and the hotfix `window.toggleGreenWand` wrapper.
- `scripts/gd-app-core.js`: `toggleGreenWand()`, `closeWandPanel()`, `runGreenWandScan()`, `scanGreen()`, `acceptGreenWand()`, `importGreenWandResult()`, and related calibration/open/close functions.
- `scripts/gd-course-library-pin-lock.js`: `startMapperGreenWand()` as an opener for standalone Wand UI.
- `scripts/gd-course-library-pin-lock.js`: wrappers around `acceptGreenWand`, `importGreenWandResult`, `rejectGreenWand`, and `closeWandPanel`.
- `scripts/gd-route-audit.js`: `oldOpenGpsWand`, `openWandStable()`, and `#dockGreen` interception.
- `scripts/inline/gd-auth-gate-v1.js`: `openGpsWand` auth guard.
- `scripts/inline/gd-brand-icon-render.js`: `#greenToolBtn` rail spec and handler.
- `scripts/inline/gd-inline-gps-tool-toggle-polish-v1-samebutton.js`: Wand live chrome, `gdToggleWandTool`, and accept/reject wrappers.
- `scripts/inline/gd-gps-play-flow-layers-v1.js`: `closeMappedWand()`.
- `scripts/inline/gd-gps-play-runtime-owner-v1.js`: optional Wand clear/scale calls and `#gdWandPanel` event-blocker selectors.

Reason: these exist to preserve a user-facing panel that is no longer a product surface.

### 6. Keep Temporarily Because Still Inbound

- `drawGreenPolygon()` and `drawGreenDistances()` in `scripts/gd-app-core.js`.
- `greenCentre`, `greenPolygon`, `greenOutline`, `greenSoft`, `greenLabel`, `frontLabel`, and `backLabel` globals.
- Course-library calls to `drawGreenPolygon(..., 'saved green', { settled: true })`.
- GPS/runtime uses of `greenCentre` and `greenPolygon` for saved greens, framing, undo state, captured-hole frame context, and mapped play.
- `green` and `Green pin` mapper UI.

Reason: these are not standalone Wand-only. They are shared saved-green/GPS geometry surfaces.

## `gd-app-core.js` Standalone-Only Functions

Delete now:

- `openGreenSandboxNotice`
- `toggleGreenFinderBeta`
- `confirmGreenAndClose`
- `saveGreenFinderSample`
- `clearWandScaleLock`
- `captureWandScaleLock`
- `getWandScaleLock`
- `getExpandedWandOptions`
- `normalizeSandboxWandShell`
- `healthyBubbleMetersToSandboxPx`
- `sandboxPxToHealthyBubbleMeters`
- `currentWandPreset`
- `toggleGreenWand`
- `closeWandPanel`
- `gdRequestWandControlRescan`
- `gdMarkWandCalibrationLive`
- `setWandBaseBubble`
- `setWandClusterPull`
- `clearWandDebugLayers`
- `addWandDebugLayer`
- `pointToLatLngSafe`
- `gdWandDebugOverlayEnabled`
- `drawWandDebugAnalysis`
- `setWandMode`
- `setWandSensitivity`
- `updateWandStatus`
- `adjustGreenTol`
- `retryGreen`
- `runGreenWandScan`
- `chooseSnapshotSource`
- `loadSnapshotSource`
- `clearSnapshotSource`
- `trySampleMapPixel`
- `sampleGreenSurfacePixels`
- `sampleAverage`
- `rawColourDistance`
- `distanceToSampleSet`
- `pixelAllowed`
- `fallbackGreenRadius`
- `scanGreen`
- `drawQuickShapeGreen`
- `drawFallbackGreen`
- `makeWandResult`
- `clearWandHandles`
- `makeEditableGreen`
- `acceptGreenWand`
- `importGreenWandResult`
- `drawMaskOutline`
- `openGpsWand`

Retain:

- `drawGreenPolygon`
- `drawGreenDistances`
- shared green/target/pin/framing state.

## Mapper Fallback UI References

Only standalone UI and compatibility:

- `mapperGreenRecordForWand()`
- `hydrateMapperGreenForWand()`
- `window.gdMapperHydrateGreenForWand`
- Map Tools drawer copy saying `Use Green Wand`
- Flyout `data-map-tool="greenwand"`
- `startMapperGreenWand()`
- `greenToolBtn` click fallback.
- `gdCompactWandOpen`, `gdToggleWandTool`, `openGpsWand`, and `wand.click()` fallback chain.
- `saveFullMappingMode()`, `clearCurrentMapperHole()`, and `startMapperGreenPinCapture()` optional `closeWandPanel()` calls.
- `wrapGpsFunctions()` accept/import/reject/close wrappers for Wand output.
- `addForgetGreenButton()` targeting `#gdWandPanel .gdWandActions`.

Retained mapper behavior after deletion should use `Green` as a normal green-pin capture tool, not `Green Wand`.

## AutoMapper Dependency Answer

AutoMapper refinement uses `GDGreenShapeEngine.detect()` directly. It does not require:

- `openGpsWand`
- `toggleGreenWand`
- `gdCompactWandOpen`
- `gdToggleWandTool`
- `acceptGreenWand`
- `rejectGreenWand`
- `importGreenWandResult`
- `gdWandPanel`
- `greenToolBtn` Wand behavior
- `gdWandLayerActive`

The retained AutoMapper path is:

`saveOsmAutoHole()` -> `automapperRunGreenShapeRefinement()` -> `automapperBuildGreenShapeCrop()` -> `GDGreenShapeEngine.detect()` -> `automapperGreenShapeVerdict()` -> `saveCourseObject()`.

## Startup Work Removed By Retirement

Expected startup deletions:

- Two standalone Wand script loads.
- Four standalone Wand stylesheet loads.
- All inline Wand panel event handlers.
- `gd-wand-belt-layers-v1.js` startup work:
  - document click guard
  - DOMContentLoaded listener
  - delayed installs
  - delayed wrappers
  - localStorage calibration reads/writes
  - global assignments for calibration, diagnostics, sample truth, open/toggle/close, reject, and chrome sync
- `gd-wand-flow-layers-v1.js` startup work:
  - DOMContentLoaded listener
  - delayed compact/floating installs
  - delayed chrome sync
  - document click listener
  - window resize listener
  - panel class MutationObserver
  - panel drag pointer listeners
  - global assignments for compact open/exit/toggle
- Route-audit `openWandStable()` and `dockGreen` click interception.
- Auth-gate wrapping of `openGpsWand`.
- Brand rail creation of `#greenToolBtn`.
- GPS play screen attempts to close or clear Wand panel/live state.
- Core map-source snapshot/stale listener and security retry path tied only to `scanGreen()`.

## Tests To Update

- `dev/green-shape-engine-owner.test.js`
  - Assert engine loads before core and AutoMapper.
  - Assert `index.html` no longer includes `#gdWandPanel`, `#gdWandBeltLayersV1`, `#gdWandFlowLayersV1`, or standalone Wand CSS.
  - Assert removed Wand files do not exist.
  - Assert core no longer owns standalone open/scan/accept/import functions.
  - Keep assertions for retained engine exports and AutoMapper adapter.
- `dev/green-shape-engine-behavior.test.js`
  - Stop querying `#gdWandPanel`.
  - Assert the panel is absent and engine analysis/detect still works.
- `dev/automapper-green-refinement-owner.test.js`
  - Flip assertions from fallback-present to fallback-retired.
  - Keep direct `engine.detect()` and load-order checks.
- `dev/automapper-green-refinement-behavior.test.js`
  - Remove fake standalone Wand globals from the harness.
  - Assert no standalone Wand globals are installed after mapper load.
  - Keep behavior coverage for accepted, rejected, skipped, stale, dedupe, and no-route/no-GPS side effects.

## Implementation Decision

Proceed with one contained implementation pass that retires standalone Wand UI and compatibility wrappers, while retaining the detector, AutoMapper refinement adapter, and shared saved-green drawing.

## Implementation Result

- Deleted standalone Wand panel markup, script/style loads, startup layers, route wrappers, rail button creation, and panel styling.
- Retained `scripts/gd-green-shape-engine.js` and AutoMapper's `GDGreenShapeEngine.detect()` refinement adapter in `scripts/gd-course-library-pin-lock.js`.
- Retained shared green drawing/distance functions for saved-green and mapped-play behavior.
- Updated focused owner/behavior tests to assert the retired UI stays absent while the engine and AutoMapper path remain active.
- Post-implementation checks passed:
  - `npm run test:boot`
  - `node dev/green-shape-engine-owner.test.js`
  - `node dev/green-shape-engine-behavior.test.js`
  - `node dev/automapper-green-refinement-owner.test.js`
  - `node dev/automapper-green-refinement-behavior.test.js`
