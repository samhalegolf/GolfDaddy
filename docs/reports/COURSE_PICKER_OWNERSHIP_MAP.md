# Course Picker Ownership Map

Date: 2026-07-19  
Branch: `structural-rebuild`  
Owner: `scripts/inline/gd-course-picker-search-v2.js` via `window.GDCoursePicker`

## Boundary

The Course Picker owns picker presentation and selection orchestration only. It calls the mapping controller boundary, `runCourseMappingAttempt` / `gdRunCourseMappingAttempt`, and does not call AutoMapper, the native Course Geometry Resolver, Green Shape Engine, live GPS watches, one-tap fallback internals, GPS Play internals, or shell routing internals.

Mapping order remains inside `scripts/gd-course-library-pin-lock.js`:

```text
saved playable course
-> OSM AutoMapper
-> native Course Geometry Resolver / hole labeller
-> one-tap live-map fallback
```

## File Map

### `index.html`

- Before: the Play tile directly changed shell classes, showed `#courseScreen`, requested picker GPS, and rendered resume-round UI inline.
- Now: the Play tile calls `window.GDCoursePicker.open({ source: "home-play", returnTarget: "home" })`.
- Retained fallback: a narrow `gdOpenChangeCourse(event)` fallback remains for load-order safety only.

### `scripts/inline/gd-course-picker-search-v2.js`

Public owner: `window.GDCoursePicker`.

Owns:
- `init`
- `open`
- `close`
- `search`
- `renderCourses`
- `refreshNearby`
- `refreshAssumed`
- `requestLocation`
- `rememberLocation`
- `centerMapOnLocation`
- `selectCourse`
- `selectFromElement`
- `resumeRound`
- `getState`
- `destroy`

State:
- initialization/listener binding
- open/source state
- active selected course
- active mapping key/token/promise
- last mapping result
- last search query
- last nearby and resume presentation

Selection path:
1. normalize course payload
2. apply existing stored pin bridge, without taking ownership of pin persistence
3. check published database map availability
4. decide whether the pin prompt is required
5. handle Manual GPS through the core bridge
6. enter GPS directly only for trusted saved playable data
7. otherwise build one immutable mapping-controller request
8. invoke `runCourseMappingAttempt` / `gdRunCourseMappingAttempt` once
9. record playable/fallback/failed/stale result
10. hand off to GPS Play only when `result.playable`

Compatibility aliases retained here and delegated to the owner:
- `renderCourses`
- `manualSearch`
- `gdRefreshCourseAssumedOption`
- `gdRefreshCourseAssumedNearby`
- `gdConfirmAssumedCourse`
- `gdOpenChangeCourse`
- `gdOpenCoursePickerCourse`
- `gdOpenCoursePickerSelectionFromElement`
- `gdCoursePickerRequestGps`
- `gdCoursePickerRememberGps`
- `gdCoursePickerCenterMapOnGps`

### `scripts/gd-app-core.js`

No longer owns picker selection orchestration.

Retains:
- core helper functions still used by older GPS/course surfaces
- pin prompt UI internals for this transitional task
- `window.GDCoursePickerCoreBridge`, a narrow bridge used by `GDCoursePicker`
- compatibility fallback for `gdOpenCoursePickerCourse` if the owner has not loaded yet

Removed from active ownership:
- partial `GDCoursePickerOwner`
- direct picker-owned mapping result handling
- direct picker-owned mapping-controller invocation

### `scripts/gd-route-audit.js`

Does not own picker UI. It now delegates stable picker opens to:

```js
window.GDCoursePicker.open(...)
```

Retained direct DOM fallback exists only for load-order safety before the picker owner is available. Shell consolidation remains out of scope.

### `scripts/gd-course-library-pin-lock.js`

Owns:
- saved playable-course storage/readiness helpers
- published course map availability
- `runCourseMappingAttempt`
- AutoMapper stage
- native Course Geometry Resolver stage
- one-tap manual fallback opening

Does not own:
- picker open/close
- picker search/rendering
- selected-course UI identity

### `scripts/inline/gd-course-picker-resume-round-v1.js`

This source file is not present in the current branch. Resume-round picker UI and resume selection currently live inside `scripts/inline/gd-gps-play-runtime-owner-v1.js` and are exposed through:

- `gdEnsureResumeRoundPicker`
- `gdResumeRoundFromPicker`
- `gdEndRoundFromPicker`
- `gdStartNewRoundFromPicker`

`GDCoursePicker.resumeRound()` delegates to those GPS runtime functions. The picker owns presentation placement/selection entry; the GPS runtime still owns restoring a GPS round.

### `scripts/inline/gd-gps-beta-mode-shell.js`

Does not own picker opening. The generated Play tile now calls `GDCoursePicker.open(...)`, with a narrow legacy fallback.

### `scripts/inline/gd-gps-play-runtime-owner-v1.js`

Owns GPS runtime and resume restoration internals.

The Play tile hook now delegates picker opening to `GDCoursePicker.open(...)` when available. Resume-round internals remain here, exposed to the picker as a narrow delegate.

## Duplicate Globals

Retained legacy globals are aliases only. New work should call `window.GDCoursePicker`.

Duplicate active owners removed:
- inline Play tile DOM mutation
- beta-shell Play tile DOM mutation
- route-audit picker open ownership when owner is loaded
- core partial `GDCoursePickerOwner`

## Load Order

Current order remains compatible:

1. `gd-app-core.js` defines compatibility helpers and `GDCoursePickerCoreBridge`.
2. `gd-course-library-pin-lock.js` defines mapping controller and course-map availability.
3. `gd-route-audit.js` can fall back before picker owner loads.
4. `gd-course-picker-search-v2.js` assigns `window.GDCoursePicker`.
5. `gd-gps-play-runtime-owner-v1.js` exposes resume-round delegates and defers Play tile opens to the picker owner.

No shell consolidation was performed.
