# Course search audit — 2026-09-09

Scope: the "Find course" picker in `index.html` (`#courseScreen`), its owner
`scripts/inline/gd-course-picker-search-v2.js`, the legacy handlers still live in
`scripts/gd-app-core.js`, and the click-driven sync in
`scripts/gd-course-library-pin-lock.js`. Reproduced in Node with the repo's own fake-DOM
picker harness plus a verbatim copy of the core's capture click handler
(scratch script, not committed).

## Symptoms reported

1. Good result ordering appears, then gets replaced by something else a moment later.
2. Buttons in the picker sometimes ignore the first tap.

Both are real, and both come from the same root cause: there is no single owner of
"what is on screen right now". Four different pieces of code render into the same two
DOM nodes (`#courseList`, `#gdCourseAssumedOption`), each on its own timer.

## Findings

### F1. One search renders the list six times and ends on a list the player did not ask for

`searchOwner()` (picker v2 ~line 1040) runs three independent renders for a single query:

| step | trigger | what `#courseList` shows | count line |
|---|---|---|---|
| 1 | synchronous | ranked local matches (database + known + recents) | "Searching" |
| 2 | course-maps + Nominatim resolve | ranked local + remote, top 12, name-scored | "N found" |
| 3 | `showArea()` → `/api/courses-near` resolves | **everything within 5.2 km of the first result, sorted by distance from that point, query ignored, no cap** | "N nearby" |

Step 3 is the "overtaken" behaviour. `clusterAreas()` groups results within 25 km, and
when there is exactly one area the code treats "one place" as "expand the place" and
replaces the ranked list with the nearby list. In the reproduction, searching
"akarana" went `1 found → Searching → 6 nearby`, with five courses the player never
typed. The query-ranked order from step 2 survives only as the anchor point.

Additional ordering problem inside `rank()` (~line 470): when a real GPS fix is
present, the comparator sorts by distance first and only falls back to the name score
within 25 m. So with GPS on, the name-match score is effectively never used for a
typed query.

### F2. Pressing Enter runs the search twice

Two keydown listeners are bound to `#searchInput`:

- `scripts/gd-app-core.js:17087` → `manualSearch()` (which v2 overrides to `api.search`)
- picker v2 `bindListeners()` → `searchOwner()`

Each call bumps `searchRun`, so the first run is discarded, but both fire a Nominatim
request in the same millisecond. Nominatim's policy is one request per second; the
second (the one that counts) is the one at risk of a 429, which surfaces as
"No course found" for a query that works when the on-screen Search button is used.
Reproduction: 2 Nominatim requests per Enter press.

### F3. The nearby block and list are rebuilt on every click, from outside the owner

`scripts/gd-course-library-pin-lock.js:6246`:

```js
document.addEventListener('click',()=>setTimeout(syncCoursePickerAssumption,130),true);
```

Any click anywhere in the app, 130 ms later, calls `gdRefreshCourseAssumedOption(candidate)`
→ v2 `renderNearby()`, which does `option.innerHTML = …` and throws away every
`.courseAssumedBlock` under the player's finger. If the list happens to be empty at that
moment (it always is while "Searching"), it also calls `renderCourses([candidate])`, which
clears the list again and flips the count line back to "Search" mid-search.

On top of that, `renderNearby()` is called unconditionally by `renderCoursesOwner`,
`renderAreasOwner`, `showFacilityChooser`, `searchOwner`, the GPS callback, the
course-maps load callback, `init()`, `open()` and the `enterGpsModule` wrapper. In the
reproduction, `open()` alone rebuilt the nearby block 7 times and the list 4 times;
one search rebuilt each 6 more times.

This is the first-tap failure. A touch that starts on a node that is removed before
touchend never becomes a click. The rebuilds cluster in exactly the first second or two
after the picker opens and during every search, which is when the player is tapping.

### F4. A tap on a course gives no feedback, and a second tap cancels the first

`selectCourseForPlay()` (~line 830) first runs `bridge().databaseMapAvailable(course)`,
which goes through `publishedCourseMapAvailability` → `syncPublishedCourseMaps` →
`fetchCourseLibraryManifest()`: a network round-trip on every tap, even for rows that
came from the database and already carry `hasDatabaseMap:true` with holes.

While that is in flight the only state change is three `body.dataset` attributes that no
CSS reads. The row looks idle, the count line is unchanged, the screen stays open. The
player taps again; the second tap issues a new `state.activeToken`, so when the first
check returns it hits `if(state.activeToken!==token)return false` and is thrown away.
From the player's side: "the first tap did nothing, the second one worked", and on a
slow connection "nothing works until the third tap".

### F5. The facility "Choose" row is hijacked by the core's capture handler

`scripts/gd-app-core.js:17050` (`gdWireCoursePickerPlay`) registers a **document-level
capture** click handler for `#courseScreen .course`. It skips rows carrying
`__gdAreaPayload` but not rows carrying `__gdFacilityPayload`, and it calls
`stopImmediatePropagation`, so the picker's own `#courseScreen` handler (which knows
about facility rows) never runs for them.

Reproduction: clicking the "Te Arai Links · 2 courses here · Choose" row selected a
course named "Te Arai Links" with `lat:null, lng:null` and started the database check,
instead of showing the North/South chooser. The existing tests pass because the harness
has no core capture handler.

The same handler is also why *all* normal course rows are handled by the core path
(`gdOpenCoursePickerSelectionFromElement` → `api.selectFromElement`) rather than the
picker's own listener: two handlers for one row, with the legacy one winning.

### F6. Smaller items

- `dev/course-picker-owner.test.js` fails at baseline: it asserts the change-course
  delegate uses `returnTarget:"gps"` but the picker says `"home"`. Pre-existing.
- The static markup in `index.html:313` still carries `onclick="gdConfirmAssumedCourse(event)"`
  on the assumed block; `renderNearby()` replaces that markup on first render, so the
  attribute is dead code that suggests a path that does not exist.
- `openOwner()` renders recents, then re-renders identical recents when course-maps
  loads (only the nearby block needed refreshing).
- `showArea()` sets the count line to "Searching" while the good list is still showing,
  and `nearbyPayloads()` drops `distanceM`, so rows lose their "1.5km away" text after
  the nearby render.

## Root cause

Nobody owns the answer to "what should the list and the nearby block show right now".
Rendering is a side effect scattered across: the picker's search pipeline (three stages,
each rendering), the picker's nearby refresh (called from nine places), the pin-lock
click sync (any click, +130 ms), and the core's legacy capture handlers. Selection has
the same shape: two click handlers, a silent async check, and a token that lets the
newest tap silently cancel the previous one.

## Status: implemented 2026-09-09

The owner below is in `scripts/inline/gd-course-picker-search-v2.js` (a `view` model,
`requestRender`, `render`, `showRows`, `expandArea`, `setSelecting`). Supporting changes:
`gd-app-core.js` capture click/keydown handlers and Enter listener return early when
`window.GDCoursePicker` exists; `gd-course-library-pin-lock.js` `syncCoursePickerAssumption`
calls `GDCoursePicker.refreshAssumed` instead of writing rows; `gd-app-base.css` gains
`.courseListDivider` and `.course.selecting`; `index.html` drops the inline
`gdConfirmAssumedCourse` handlers and bumps the four cache keys. Regression coverage is
`dev/course-search-owner.test.js`, which lifts the real core handlers into the harness.
One deliberate deviation from item 6: the published-map availability check still runs on
every tap, because it is what fills the local map store the play entry reads. The visible
"Opening…" acknowledgement covers the wait instead.

## Recommended fix: one search-result owner

Keep `GDCoursePicker` as the public API, but give it a single model and a single render.

1. **State, not calls.** `model = {query, run, phase: idle|searching|results|areas|chooser,
   rows[], areas[], nearby: {key, blocks[]}, selecting: courseKey|null}`. Every input
   (Search button, Enter, area tap, facility tap, GPS fix, course-maps load, pin-lock
   candidate) updates the model through the owner and requests one render, coalesced
   with `requestAnimationFrame`.
2. **Render by diff.** `#courseList` is rebuilt only when `rows`/`phase` changed;
   `#gdCourseAssumedOption` only when `nearby.key` (course keys + GPS point) changed.
   Nothing outside the owner writes `innerHTML` on either node.
3. **Search decides once.** Stages 1–2 stay (immediate local, then merged remote), but
   stage 3 becomes additive: with one area, append "Also near <place>" rows *below* the
   ranked rows, keep the query-ranked order and the 12-row cap, never drop a
   query-matched row, and never reset the count line to "Searching" while rows are shown.
   With more than one area, keep the "Which one?" chooser as today.
4. **Rank by name when there is a query.** Distance-first ordering only for the
   empty-query nearby list.
5. **One Enter, one click path.** In `gd-app-core.js`: the Enter listener and
   `gdWireCoursePickerPlay` return early when `window.GDCoursePicker` exists. Facility
   and area rows are then handled where they are defined. (Alternatively, remove the
   core listeners entirely; nothing on the page works without the picker script.)
6. **Selection feedback and idempotence.** On tap: set `model.selecting`, mark the row
   `.selecting`, set the count line to "Opening <name>…", and ignore further taps on the
   same course key while the check runs (the mapping stage already does this via
   `selectionKey`; the database-check stage does not). Skip
   `publishedCourseMapAvailability` for rows that came from the course-maps cache with
   holes, which is the common case.
7. **Pin-lock stops rendering the picker.** Replace the click-driven
   `syncCoursePickerAssumption` write with a call to `GDCoursePicker.refreshAssumed(candidate)`
   only when the candidate key actually changed, and drop its `renderCourses([candidate])`.
8. **Tests.** Extend `dev/course-picker-behavior.test.js` with the core capture handler
   and the second Enter listener (as in the reproduction), assert: one Nominatim request
   per Enter; list rebuild count per search; facility row opens a chooser; a tapped row
   is still attached after the search settles; a second tap on the same course while a
   check is in flight is a no-op. Fix the stale `returnTarget` assertion in
   `dev/course-picker-owner.test.js`.
