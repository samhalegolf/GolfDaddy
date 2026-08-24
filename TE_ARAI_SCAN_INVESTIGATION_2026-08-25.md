# Te Ārai Links scan — what actually happened

**Course:** Te Ārai Links, Mangawhai NZ. Two 18s (North + South), 36 holes.
**Result:** published as a 6-hole course, `status: done`, no warnings, full visual chain completed.
**Job:** `1946086f-e65a-4c53-b333-d483d04ddbc3`, 2026-08-24 20:38:36 UTC, mapper v2.

The system did not crash. It ran end to end in 2m40s, produced a confident, internally
consistent, completely wrong answer, and every guard designed to catch that was blind for a
different reason. That is what makes this a good case study.

---

## The 6 holes it kept

| Hole | Green centre | Source |
|---|---|---|
| 9  | -36.187858, 174.660253 | `osm_auto_green_polygon` |
| 10 | -36.187737, 174.656007 | `osm_auto_green_polygon` |
| 12 | -36.186368, 174.661788 | `osm_auto_green_polygon` |
| 13 | -36.182969, 174.658714 | `osm_auto_green_polygon` |
| 16 | -36.185778, 174.663149 | `osm_auto_green_polygon` |
| 17 | -36.186581, 174.664205 | `osm_auto_green_polygon` |

Every one marked `confirmed: true`. Note what this set is: **not contiguous, doesn't start at
1, gaps at 11/14/15, max hole number 17.** It is not the North Course, not the South Course,
and not a nine. It is a fragment stitched from both.

Job result: `greensFound: 32`, `guidesFound: 16`, `holesResolved: 6`, `polygons: 6`,
`saved: 20`, `fit: { trusted: true, spanM: 982 }`, `expectedHoles: null`,
`queryStages: ["around:1400", "tightened-to-nearest-loop"]`.

OSM had 32 greens in range — roughly the full 36. The data was there. The resolver threw it away.

---

## Failure 1 — the course ID is `te-rai`

The client called `/api/course-package?courseId=te-rai&courseName=Te%20Ārai%20Links`.

`scripts/inline/gd-course-picker-search-v2.js:44`

```js
function slug(s){return String(s||"course").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-")...}
```

`ā` is not in `a-z`, so it is eaten together with the space beside it: `te ārai links` →
`te-rai-links`, then `cleanName` strips `links` → **`te-rai`**. The macron didn't become `a`,
it vanished.

This isn't one function. There are ~18 independent copies of the same slug across
`functions/`, `scripts/` and `functions/lib/` — none of them normalize diacritics. Any course
with a macron, accent or umlaut gets a mangled ID: Ōtaki, Whangārei, Château, Müller.

**Fix:** one shared helper, NFD-normalize and strip combining marks before the character
filter:

```js
String(s||"course").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase()...
```

That yields `te-arai`. Delete the other 17 copies rather than patching them — they will drift
again otherwise. This needs a data migration: `course_maps`, `course_visuals`,
`course_visual_jobs`, `course_mapper_jobs` and the visual storage paths all key on `te-rai`
today.

---

## Failure 2 — `selectNearestLoop` picks per hole number, not per loop

This is the real bug.

`functions/lib/gd-automapper-core.mjs:425`

Overpass returned both Te Ārai courses. `detectHoleNumberCollision` correctly flagged
`multiLoop` — hole numbers appearing twice, >250m apart. Correct so far.

Then `selectNearestLoop` runs. Read what it does:

```js
byNumber.forEach(entries => {
  // cluster THIS hole number's features
  // keep the cluster nearest `centre`, drop the rest
});
```

It clusters **each hole number independently** and keeps whichever cluster is closest to the
course centre — *for that number alone*. Nothing constrains all the kept numbers to come from
the **same** loop.

At St Andrews, which this was written for, the six courses are far enough apart that
"nearest per number" happens to land on the same course every time. It looks like loop
selection. It isn't — it's a per-number nearest-neighbour that coincidentally agrees.

At Te Ārai, North and South run alongside each other through the same dunes. "Nearest to the
pin" flips between courses hole by hole. The kept set is a mix, so it isn't spatially
coherent, so downstream green-pairing drops most of it: 16 guides in, 6 holes out.

**Fix:** choose the loop first, then keep it. Cluster all hole features globally (single-link
at `LOOP_SEPARATION_M`), score each *cluster* on distance-to-centre and hole-count, keep one
cluster wholesale. A loop that yields 6 of 18 numbers is evidence the clustering failed, not
a result to publish.

---

## Failure 3 — all three guards were blind, for three different reasons

Once tightening adopted the fragment, three things should have stopped it:

**a) The adoption rule.** `course-mapper-worker-background.mjs:349`

```js
if (tightGeometry && tightGeometry.holesResolved > 0) { geometry = tightGeometry; ... }
```

Deliberately `> 0`, not "beats the untightened count" — and the comment explains why, sound
reasoning for the St Andrews case. But `6 > 0`, so a 6-hole fragment replaced a 16-guide
answer with no floor at all.

**b) `expectedHoles` was `null`.** No shared scorecard for Te Ārai
(`course_scorecards` is empty — 0 rows), and no `holes=N` tag on the OSM polygon. So the
wider-frame retry, the geometry-resolver handoff, and the "published incomplete" warning are
all gated behind a number that didn't exist. All three silently skipped.

**c) `courseFitVerdict` passed.** `functions/lib/gd-course-fit-core.mjs:54`

- `multiple-courses` — false, tightening just cleared it
- `scorecard-mismatch` — needs `expectedHoles`, which is null
- `holes-scattered` — span 982m vs a 6000m ceiling

`trusted: true`. No pin prompt. Note that the span test **structurally cannot** catch this:
a fragment is *small*. A max-span test only catches over-collection, never under-collection.

### The check that costs nothing

Holes `9, 10, 12, 13, 16, 17`: six holes, highest number 17, no hole 1, gaps at 11/14/15.

**A resolved hole set that isn't contiguous from 1 is incomplete on its face.** No scorecard
needed, no OSM tag needed, no second Overpass call. Just the numbers already in hand. This one
rule catches Te Ārai, and catches it *before* tightening too.

Second free check: `courseFootprintFrame` already parses the `leisure=golf_course` polygon
from the same payload. Resolved bounds 982m against a course footprint several times that
size is the under-collection signal the span test can't provide.

---

## Failure 4 — the diagnostics were discarded exactly when needed

`diagnostics` accumulates `collision.loops`, `widestSeparationM`, `tightened.keptHoleFeatures`,
`tightened.droppedHoleFeatures`, `osmFeatures` — everything needed to explain this run.

It is attached to errors only, via `fail()`. On `status: done` the returned result object
omits it entirely.

So the `te-rai` row records `queryStages: [..., "tightened-to-nearest-loop"]` and not one
number about what tightening dropped. The job that most needed explaining recorded the least.
A successful-but-wrong job is precisely the case the evidence exists for.

**Fix:** return `diagnostics` on success too.

---

## Failure 5 — everything downstream agreed

Nothing questioned the 6 holes:

- `course_maps` → `published: true`, `hole_count: 6`, `geometry_version: v2`
- snapshot job queued automatically, done 20:39:45
- export chained, done 20:41:16
- `course_visuals` → `status: published`, version 57, clean `last_error`

Also: `region` and `country` are **null** for `te-rai` but populated for `tara-iti`
(Auckland / New Zealand). The geocode enrichment missed too — likely the same name/slug path.

Useful control: **`tara-iti`, mapped 11 minutes earlier from the same session, resolved 18/18
cleanly** — no collision, no tightening, `saved: 64`, region and country populated. Same
worker, same code, adjacent site. The difference is entirely that Tara Iti is one 18 and Te
Ārai is two.

---

## Failure 6 — the player-facing symptom, and Null Island

From the console: the player opened the course and landed in `beginInteractiveGreenFallback`
— "Tap the green" — despite the course being published.

That follows directly. Hole 1 isn't in `{9,10,12,13,16,17}`. **30 of 36 holes at Te Ārai drop
to manual green-tapping.** A published course is worse than an unmapped one here, because the
picker reports a database map is available.

Then the map jumped to Null Island. The tile 404 storm is `World_Imagery/MapServer/tile/18/
131070-131073/131070-131073` — at z18 the centre tile is 131072, so those coordinates are
lat 0, lng 0. One `/api/course-package` call went out with `courseLat=0&courseLng=0` too.

Source: `scripts/gd-course-location.js:46`

```js
function finitePoint(point){
  if(!point)return null;
  const lat=Number(point.lat??point.latitude);
  const lng=Number(point.lng??point.lon??point.longitude);
  return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng}:null;
}
```

`Number(null)` is `0`. `Number.isFinite(0)` is `true`. A record with null coordinates resolves
to `{lat:0, lng:0}` and every downstream guard accepts it, because 0 is a perfectly finite
number.

This is the **same bug the server already fixed and documented** — `selectNearestLoop`'s own
comment:

> *"Number(null) is 0 and Number.isFinite(0) is true, so a centre-less course would have
> clustered against Null Island"*

The client copy was never hardened. Worse: `gd-course-library-pin-lock.js:408`
(`finiteCoordinatePair`) **is** hardened and does reject `null`/`""` — but `guideCoursePoint`
consults `GDCourseLocation.resolve()` first (line 1798), so the safe one never gets a turn.

**Fix:** reject `null`/`undefined`/`""` before `Number()` in `finitePoint`, same as
`finiteCoordinatePair` does. Consider making 0,0 an explicit sentinel rejection everywhere —
no golf course is in the Gulf of Guinea.

---

## Failure 7 — redundant network work

One course selection fired:

- `/api/course-package` × **8** (7 with real coords, 1 with 0,0)
- `/api/course-library` × **4**
- `/api/course-maps` × 1
- `/api/shot-library-sync` × 2

`selectCourseForPlay` reaches `invokeMappingOnce` from two entry points in the same
interaction (`prompt.onclick` and `selectFromElement`), and each pass re-runs
`runCourseMappingAttempt → tryHydrateCourseMapFromCloud → syncPublishedCourseMaps →
fetchCourseLibraryManifest`. `startFallbackPackageWatch` then adds its own polling fetch on
top. No request coalescing anywhere in the chain.

Not the cause of anything here, but it's 8× the load on a course-open and it makes the console
unreadable when something does go wrong.

---

## Fix order

**1. Hole-number continuity check.** Cheapest, catches this class outright, no new data
needed. Refuse to publish (or publish with a loud warning + pin prompt) when resolved numbers
aren't contiguous from 1.

**2. `selectNearestLoop` — cluster globally, pick one loop, keep it wholesale.** The actual
root cause. Per-number nearest-neighbour is not loop selection.

**3. `finitePoint` null guard** in `gd-course-location.js`. One-line fix, kills the Null Island
map jump and the 0,0 API call.

**4. Return `diagnostics` on successful jobs.** Can't diagnose the next one otherwise.

**5. Diacritic-safe slug, single shared helper**, plus `te-rai` → `te-arai` migration. Delete
the duplicate implementations.

**6. Footprint-vs-resolved-bounds check** using the `leisure=golf_course` polygon already in
the payload. Covers under-collection where the span test can't.

**7. Coalesce the course-open request storm.**

Separately: Te Ārai needs **two** course records — `te-arai-north` and `te-arai-south` — not
one. Worth checking how `MULTI_COURSE_FACILITIES_PLAN_2026-08-19.md` expects multi-course
facilities to be keyed before re-running the scan, otherwise a corrected mapper will just
produce a correct 18 and silently drop the other one.
