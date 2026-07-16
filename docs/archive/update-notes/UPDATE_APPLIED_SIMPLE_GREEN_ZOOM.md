# Update Applied — Simple Green Zoom / Target Frame Rollback

## Reason
The previous locked-in green zoom update was too heavy. It introduced a separate locked-in toolbar/focus behaviour that could fight the existing lock-in state, hide the bubble, and create confusing camera behaviour.

This update rebuilds the feature from the cleaner repo baseline and keeps only the useful concept:

- a reusable screen target frame,
- one optional green zoom button,
- camera zoom/framing around the active bubble/green/landing point,
- no separate locked-in toolbar,
- no assumed green focus mode.

## Main changes

### 1. Added a reusable target frame model
Added helpers:

- `gdScreenTargetFrameConfig(kind)`
- `gdTargetFramePadding(kind)`
- `gdFrameAroundPoint(point, kind)`

These define the useful play window based on the marked screenshot area. The camera can now frame a bubble, green centre, landing target, or future hole-frame object into that area without needing a separate visual mode.

### 2. Simplified green zoom
Added one button:

- `#gdGreenZoomBtn`
- handler: `gdToggleSimpleGreenZoom(event)`

Behaviour:

- Appears in GPS/play UI.
- First tap saves the current camera view and zooms tightly around the active bubble/landing target.
- Second tap returns to the previous camera view.
- Does not clear shot state.
- Does not hide the bubble.
- Does not change lock/unlock state.
- Does not introduce a separate locked-in toolbar.

### 3. Restored slope/playing-distance card slot
Kept the slope-card repair from the previous patch, but without the heavy locked-in toolbar.

Added:

- `gdRenderShotCardSlope(tilePlays, slopeData)`

Normal render now computes slope data once and renders it into `#tilePlays`.

### 4. Green outline is not hidden
Green outline is kept visible but made very subtle:

- very thin stroke,
- low opacity,
- very low fill,
- still interactive for long-press/edit behaviour.

### 5. Removed heavy locked-in tool rail idea
This clean build does not add the prior locked-in toolbar system. Existing unlock/reset/shot-end controls are left in place.

## Acceptance checks

1. Lock in a shot and confirm the bubble remains visible.
2. Tap green zoom: view zooms tightly around the bubble/landing target.
3. Tap green zoom again: camera returns to the previous view.
4. Existing lock/unlock state remains unchanged.
5. No green focus/tail-spin behaviour should trigger automatically.
6. Slope/playing distance still populates in the shot card when elevation resolves.
7. Green outline remains visible but subtle.
8. Mobile layout should keep the zoom button on the existing right rail without creating a new toolbar.

## Build check

- `npm run build:netlify` passed.
