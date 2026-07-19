# Course Location Ownership Map

Date: 2026-07-19  
Branch: `structural-rebuild`  
Current intended owner after this task: `scripts/gd-course-location.js` via `window.GDCourseLocation`

## Boundary

This report maps the current course-location ownership before behavior changes. The target owner is responsible only for the persistent course-location pin / course centre used by picker search, assumed-course matching, saved-course identity, and mapping entry.

It must not own Course Picker UI, AutoMapper internals, the native Course Geometry Resolver, Green Shape detection/refinement, one-tap live-map green fallback, live GPS lifecycle, shell routing, GPS Play camera, flag/pin placement, scorecard, Course Data shot records, Practice, Bag, Bubble, or shot-end systems.

Protected mapping order remains:

```text
saved playable course lookup
-> OSM AutoMapper
-> native Course Geometry Resolver / hole labeller
-> one-tap live-map green fallback
```

Green Shape Engine refinement remains an internal AutoMapper stage. The retired Claude hole labeller must not be restored.

## Baseline State

- `git status --short`: clean
- Branch: `structural-rebuild`
- `HEAD`: `0f4ef607caa4e47d83e2cb0c8b3120c941ce685a`
- `origin/structural-rebuild`: `0f4ef607caa4e47d83e2cb0c8b3120c941ce685a`
- Required commit present: `0f4ef60 Consolidate Course Picker ownership`
- Baseline tests passed before this report:
  - `npm run test:boot`
  - `node dev/course-picker-location.test.js`
  - `node dev/course-picker-owner.test.js`
  - `node dev/course-picker-behavior.test.js`
  - `node dev/course-mapping-controller.test.js`
  - `node dev/course-geometry-resolver.test.js`
  - `node dev/gps-location-lifecycle-owner.test.js`
  - `node dev/gps-play-runtime-owner.test.js`

## Current Split

There is no single owner for the persistent course-location concept today.

The active concepts are:

- `courseLat` / `courseLng`: saved course centre fields in local and cloud course-map records.
- `finderLat` / `finderLng` and `courseFinderLat` / `courseFinderLng`: saved "finder" or locator pin fields in local and cloud course-map records.
- `courseCentre` / `courseCenter`: mapping-request and debug-stage centre payloads.
- `lat` / `lng`: overloaded presentation and payload coordinates used by picker rows, active course identity, manual GPS, search results, saved records, and map framing.
- `gd_course_picker_course_pins_v1`: separate localStorage store for picker-confirmed pins.
- `gd_user_course_library_v1`: local saved course map library, including `courseLat`, `courseLng`, finder fields, objects, and holes.
- `gd_published_course_library_v1` plus `/api/course-maps`: published/cloud course map store, including course centre and finder fields.
- `gd_recent_course_picks_v1`: picker recents store.
- `gd_active_course_v1`: active-course compatibility store.

The current implementation mixes truth and presentation:

- A map viewport can become a stored picker pin through `gdConfirmCoursePin`.
- A stored picker pin is applied back into `lat`, `lng`, `courseLat`, `courseLng`, `finderLat`, and `finderLng`.
- The Course Library finder pin is stored separately from the picker pin store.
- AutoMapper and the native resolver receive a resolved centre through `mappingCourseSnapshot` and mapping requests, but that resolution is spread across picker, core bridge, and course library code.

## Ownership Map

| Function or state | Declaring file | Reads | Writes | Storage field / surface | Centre spelling | Source handling | Manual/simulated/live GPS handling | Truth vs presentation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GDCoursePicker` | `scripts/inline/gd-course-picker-search-v2.js` | `GDCoursePickerCoreBridge`, local recents, database course cache, `window.gdGpsState`, map center | picker state, recents, active selection globals, mapping status datasets | `gd_recent_course_picks_v1`, `window.__gdLiveCoursePickerSelection` | uses `lat` / `lng`, emits `courseCentre` only for pin-seeded mapping | `source` values include `recent-course`, `database-course`, `remote-search`, `course-picker`, `course-picker-pin` | rejects simulated/manual/map/click/tap/green-focus/pin GPS sources for nearby GPS; still accepts map center for currentPoint presentation | owner of picker orchestration, not persistent location truth |
| `basePayload` / `databaseCoursePayload` | `scripts/inline/gd-course-picker-search-v2.js` | search result, local known courses, cloud courses | normalized picker payload | row payload fields | converts `courseLat`, `courseLng`, finder fields into `lat` / `lng` | preserves incoming `source` | no confirmation model | presentation payload, not canonical truth |
| `mappingRequest` | `scripts/inline/gd-course-picker-search-v2.js` | selected course, pinned seed, `mappingCourseSnapshot` | mapping-controller request | `course`, `courseCentre` | emits `courseCentre` when pin-seeded | reason `course-picker` or `course-picker-pin` | pin seed is trusted only when `gdTrustedCoursePin` is set | mapping entry, but centre choice is delegated to scattered helpers |
| `gdCoursePickerReadPinStore` / `gdCoursePickerRememberPin` | `scripts/gd-app-core.js` | `gd_course_picker_course_pins_v1`, selected payload | local picker pin store | `lat`, `lng`, `courseName`, `pinnedAt`, `source` | none | stores `source:"course-picker-pin"` | saves map/payload/default point after explicit picker confirm; no cloud sync; no delete API | persistent picker pin truth, currently hidden inside app core |
| `gdCoursePickerApplyStoredPin` | `scripts/gd-app-core.js` | picker pin store | selected payload | `lat`, `lng`, `courseLat`, `courseLng`, `finderLat`, `finderLng`, `gdTrustedCoursePin` | none | `pinSource` from store | treats stored pin as trusted after prior confirm | mutates identity payload and mapping seed |
| `gdShowCoursePinScreen` / `gdConfirmCoursePin` / `gdCancelCoursePin` | `scripts/gd-app-core.js` | selected payload, map center, payload point, default point | picker pin store, pending globals, datasets | `gd_course_picker_course_pins_v1`, `window.__gdPendingCoursePinPayload` | none | `pinSource:"course-picker-pin"` | explicit confirm is required, but proposed point can be map center, payload point, or default point | minimal picker pin UI, not a stable location owner |
| `mappingCourseSnapshot` | `scripts/gd-course-library-pin-lock.js` | built-in course table, selected course, `courseCentre`, `courseCenter`, finder fields, nearest known course | normalized mapping snapshot | mapping/debug payload | reads both `courseCentre` and `courseCenter`, writes `courseCentre` | can set source to built-in / known-course-centre | may resolve assumed/manual sessions to nearest known course from `mapSessionCenter` | canonical mapping snapshot today, but mixes course identity and centre resolution |
| `mapSessionCenter` | `scripts/gd-course-library-pin-lock.js` | `courseObj`, `start`, recent GPS, map/session course fields | none | transient | none | none | for manual GPS, can use `start` then recent GPS; otherwise uses course point, `start`, recent GPS | transient presentation fallback, not persistent course truth |
| `courseCandidatePoint` / `savedCourseCandidates` / `nearbyKnownCourses` | `scripts/gd-course-library-pin-lock.js` | local saved courses, built-ins, finder fields | candidate objects | `courseLat`, `courseLng`, finder fields | none | sources `saved-course`, `built-in-course` | no simulated GPS write; nearby matching can be seeded by session center | matching helper, not owner |
| `ensureCourse` | `scripts/gd-course-library-pin-lock.js` | canonical/session course | local store | `gd_user_course_library_v1` fields | none | preserves canonical source indirectly | writes `courseLat`, `courseLng`, finder fields from canonical course; no confirmation distinction | local course-map persistence helper |
| `saveCourseFinderCoordinate` | `scripts/gd-course-library-pin-lock.js` | map center or `start`, session course | local store and active course store | `finderLat`, `finderLng`, `courseFinderLat`, `courseFinderLng`, `finderSource`, `finderUpdatedAt` | none | default source `play-hole` | rejects manual or assumed courses; can save current map center | persistent Course Library finder pin, separate from picker pin |
| `courseFinderPoint` / `focusCourseFinder` | `scripts/gd-course-library-pin-lock.js` | saved course finder fields | map marker/layer | Course Library detail UI | none | none | no GPS ownership | presentation for finder pin |
| `gdCLOpenCourseFromLibrary` | `scripts/gd-course-library-pin-lock.js` | saved course, finder fields | calls `openCourse`, mapping mode state | active course payload | none | none | uses finder as `lat` / `lng` when present | Course Library entry point, bypasses a canonical location owner |
| `gdCLOpenCourseLocatorFromLibrary` | `scripts/gd-course-library-pin-lock.js` | saved finder fields | calls `openCourse`, focuses finder | map locator layer | none | none | no GPS ownership | presentation only |
| `gdCLClearCourseFinder` | `scripts/gd-course-library-pin-lock.js` | local course store, active course store | deletes finder fields | `finderLat`, `finderLng`, `courseFinderLat`, `courseFinderLng`, `finderSource`, `finderUpdatedAt` | none | removes finder source | no GPS ownership | delete exists only for Course Library finder, not picker pin |
| `publishedCourseMapAvailability` | `scripts/gd-course-library-pin-lock.js` | published course maps, mapping snapshot | none | cloud map availability | `courseCentre` in snapshot | source `course-picker-db-map-check` | rejects manual GPS course | saved playable lookup helper |
| `courseToSupabaseRow` / `courseFromSupabaseRow` / `sanitizeCourse` | `functions/course-maps.mjs` | course map payload | Supabase row and response | `course_lat`, `course_lng`, `finder_lat`, `finder_lng` | none | preserves source only inside `course_json` | no simulated/manual guard here | cloud serialization, not runtime owner |
| `GDGreenShapeEngine`, AutoMapper, native resolver | `scripts/gd-course-library-pin-lock.js`, `scripts/gd-course-geometry-resolver.js` | `courseCentre`, `courseCenter`, `courseLat`, `courseLng`, map viewport | mapped geometry objects | holes/objects | resolver reads both spellings | internal mapping stage sources | no persistent course-location ownership | protected systems |
| GPS runtime live fix state | `scripts/inline/gd-gps-play-runtime-owner-v1.js` | `window.gdGpsState` | live and tap-standing GPS state | `lastFix`, `lastFixAt`, `__gdLastLiveGpsPoint` | none | live `gps-live`; tap-standing simulated | live fixes set `simulated:false`; tap/click set `simulated:true` | GPS lifecycle/runtime, not course-location truth |
| flag/pin owner | `scripts/gd-flag-pin.js` | pointer/map click | flag/pin placement through existing `placePin` | active pin/flag UI | none | pin placement source belongs to flag/pin system | no course-location persistence | protected flag/pin owner |

## Current Precedence

Current precedence is implicit and inconsistent:

1. Picker applies `gd_course_picker_course_pins_v1` first when present.
2. Picker database courses are read from `/api/course-maps` and can use published `courseLat` / `courseLng` or finder fields as `lat` / `lng`.
3. Course Library `mappingCourseSnapshot` prefers explicit `opts.courseCentre` / `opts.courseCenter`, then payload `courseCentre` / `courseCenter`, then `guideCoursePoint`.
4. `guideCoursePoint` prefers `courseLat` / `courseLng` / `lat` / `lng`, then finder fields.
5. Built-in course IDs override selected payload coordinates for known courses.
6. If a manual/assumed course is near a known course, `mappingCourseSnapshot` can rewrite identity to that known course.
7. If no course point exists, some presentation paths fall back to `start`, recent real GPS, or map center.

The target owner should replace this with explicit precedence:

1. confirmed manual saved course centre
2. published/cloud course centre
3. confirmed local Course Library centre
4. known built-in course centre
5. selected search-result centre
6. recent real picker GPS proposal only
7. map viewport proposal only

Manual, simulated, pretend, green-tap, pin-drop, and map-click points must never become silently confirmed course truth.

## Centre vs Center

The current app accepts both spellings in mapping stages:

- `courseCentre`: dominant app/mapping/debug spelling.
- `courseCenter`: compatibility input spelling.
- `center`: generic resolver/debug/map viewport spelling.

The new owner should expose canonical `centre:{lat,lng}` while normalizing:

- `courseCentre`
- `courseCenter`
- `courseLat` / `courseLng`
- `lat` / `lng`
- `latitude` / `longitude`

Compatibility output should continue to attach `courseCentre`, `courseLat`, `courseLng`, `lat`, and `lng` where existing mapping and GPS Play surfaces require them.

## Storage Map

| Storage | Current owner | Fields | Problem to resolve |
| --- | --- | --- | --- |
| `gd_course_picker_course_pins_v1` | `gd-app-core.js` picker pin helpers | `lat`, `lng`, `courseName`, `pinnedAt`, `source` | separate from Course Library finder pin; no remove API in picker; not cloud synced |
| `gd_user_course_library_v1` | `gd-course-library-pin-lock.js` | `courseLat`, `courseLng`, finder fields, objects, holes | finder pin and course centre are not explicitly separated by owner/confirmation |
| `gd_published_course_library_v1` | `gd-course-library-pin-lock.js` | published local mirror of course maps | published centre/finder fields feed picker and mapping without a canonical resolver |
| `/api/course-maps` / Supabase | `functions/course-maps.mjs` | `course_lat`, `course_lng`, `finder_lat`, `finder_lng`, `course_json` | serializer stores fields but does not decide precedence or confirmation |
| `gd_recent_course_picks_v1` | `GDCoursePicker` | `lat`, `lng`, identity fields | recents are presentation history, not confirmed course truth |
| `gd_active_course_v1` | compatibility code in picker/library/core | selected course payload | currently receives finder fields from Course Library helpers |
| `window.gdGpsState` | GPS location lifecycle / picker request / GPS runtime | live fix fields | must remain GPS truth only; no course-location persistence |

## Load Order

Current relevant order in `index.html`:

1. `scripts/gd-app-core.js`
2. `scripts/gd-flag-pin.js`
3. `scripts/gd-course-geometry-resolver.js`
4. `scripts/gd-course-library-pin-lock.js`
5. `scripts/gd-course-play-pipeline.js`
6. `scripts/inline/gd-course-picker-search-v2.js`
7. `scripts/inline/gd-gps-play-runtime-owner-v1.js`

The new `scripts/gd-course-location.js` should load after `gd-app-core.js` and before `gd-course-library-pin-lock.js` / `gd-course-picker-search-v2.js` consumers. It can then be used by Course Library mapping snapshots and the Course Picker without introducing shell ownership.

## Target Carve

`window.GDCourseLocation` should become the single owner for:

- read/normalize/resolve confirmed course centre
- proposed vs confirmed location state
- explicit manual confirmation/update/remove
- sync into selected-course identity
- exposure to picker search and mapping requests
- structured events/datasets for diagnostics
- stale/simulated/manual guardrails

Suggested API:

```js
window.GDCourseLocation = {
  init,
  normalize,
  resolve,
  get,
  propose,
  confirm,
  update,
  remove,
  attachToCourse,
  getState,
  destroy
};
```

Canonical model:

```js
{
  courseId,
  courseName,
  centre: { lat, lng },
  source,
  confidence,
  confirmed,
  updatedAt,
  selectedAt,
  userId,
  accountId
}
```

Integration points after this report:

- Picker: call `GDCourseLocation.resolve/attachToCourse` before database-map lookup, mapping decisions, recents writes, and mapping-controller invocation.
- Picker GPS: use recent real picker GPS only as a nearby-search/proposal point, not as persistent truth.
- Core bridge: remove picker pin storage ownership and delegate pin UI confirmation to `GDCourseLocation.confirm/update/remove`.
- Course Library: delegate `courseFinderPoint`, finder save/clear, and mapping snapshot centre resolution to `GDCourseLocation`, while preserving Course Library ownership of holes/objects/AutoMapper.
- Mapping controller: receive a resolved centre from selected-course identity and not independently choose GPS/map/search/assumed centre.
- Course Database/admin: display resolved centre, source, confirmation state, last updated, edit location, and remove.

## Non-Goals For This Task

- Do not redesign Course Picker ownership from PR #51.
- Do not change AutoMapper, Green Shape Engine, native resolver internals, one-tap fallback internals, GPS Play runtime, shell routing, camera behavior, scorecard, flag/pin ownership, Course Data ownership, Bubble, Bag, Practice, or shot-end systems.
- Do not persist live GPS history as course-location truth.
- Do not treat manual GPS, tap/click/green-focus, pretend GPS, hole green, flag/pin, shot origin/end, or camera centre as confirmed course location.
