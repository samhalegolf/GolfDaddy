# Multi-course sites: map them all, let the player choose

Spec for the Te Ārai fix. Companion to `TE_ARAI_SCAN_INVESTIGATION_2026-08-25.md`.
Extends `MULTI_COURSE_FACILITIES_PLAN_2026-08-19.md` — does not contradict it.

## The principle

When a scan finds N courses on one site, **publish N courses.** The player picks
which one they're playing from the course list, the same way they'd pick between
two clubs. The pin screen stays reserved for what it's for: the mapped location
being wrong.

Today the mapper does the opposite — it treats a second course as ambiguity,
keeps a guess, and throws the rest away.

## Why this is mostly deletion

`/api/courses-near` already reads `leisure=golf_course` / `golf=course` polygons
within 5.2km, takes their **names and centres**, and merges them with
`course_maps` rows. Two Te Ārai entries would already appear in the picker with
distances — no new selection UI needed.

The picker is already right. The mapper disagrees with it. This makes the mapper
agree.

`loadSiblingCentres()` (worker line 156) already assumes multiple `course_maps`
rows per facility and partitions guides between them. The data model is ready.

---

## Delete

Per rebuild rule 2 — these solve an ambiguity that stops existing:

| What | Where | Lines |
|---|---|---|
| `selectNearestLoop()` | `functions/lib/gd-automapper-core.mjs:425` | ~55 |
| multi-loop refusal `throw` | `course-mapper-worker-background.mjs:~380` | ~30 |
| tightening branch | `course-mapper-worker-background.mjs:339-360` | ~22 |
| `multiple-courses` reason + message | `functions/lib/gd-course-fit-core.mjs:63,100` | ~10 |
| `diagnostics.tightened`, `tightened.siblingCentres` plumbing | worker | ~6 |

`detectHoleNumberCollision()` **stays** — but stops being an error detector and
becomes the router.

---

## The router

`detectHoleNumberCollision()` already returns everything needed:

- **numbers unique across the site** → one course, N holes.
  North Shore: 27 holes numbered 1–27. One row, plus a start hole.
  Already covered by the 2026-08-19 plan.
- **numbers repeat, >250m apart** → N courses.
  Te Ārai: two 18s each numbered 1–18. Two rows.
  Royal Auckland: three loops. Three rows.

Same function, same output, no longer treated as a problem.

---

## Separating the loops

Replace `selectNearestLoop` with `separateLoops(payload, centre)` returning
**every** loop, not one.

### Primary: polygon containment

The payload **already contains** the course polygons with full geometry and tags
— `osmGuideQuery` requests `golf=course` and `leisure=golf_course` with
`out geom tags` (line 306). Today they're reduced to a bounding box
(`courseFootprintFrame`) and a `holes=N` count. The shapes and names are never
read.

Assign each numbered hole to the polygon that contains it. Deterministic, exact,
no heuristics, no extra Overpass call. `pointInPolygon` already exists in
`gd-geometry-resolver-core.mjs:135`.

### Fallback: routing continuity

When the site has one facility polygon covering both courses.

**Do not cluster by proximity.** Single-link clustering chains the two courses
into one blob the moment any North hole sits within 250m of any South hole —
which at an interleaved links site is immediate. That failure mode is what we're
replacing, not a fix for it.

Use the property that makes a loop a loop: **hole N's green is near hole N+1's
tee.** For each hole number there are k candidates. Walk 1→18 building k chains,
at each step taking the candidate nearest the previous hole's green. The resolver
already does beam-search hole assignment (`gd-geometry-resolver-core.mjs` header,
line 11) — same shape, reuse it.

### Partition everything, not just `golf=hole`

**This is the trap that would survive a naive rewrite.**

`selectNearestLoop` filters `golf=hole` features only. Everything else —
greens, tees, fairways, bunkers — falls into `passthrough` and is concatenated
back unfiltered:

```js
if (!number || !point) { passthrough.push(element); return; }
...
payload: { elements: passthrough.concat(kept) }
```

So the "tightened" Te Ārai payload held **16 hole guides from a mix of both
courses, competing against all 32 greens from both courses.** Twice the green
candidates each guide should have seen, half of them on the wrong course. That
is why only 6 of 16 guides paired successfully — not a vague downstream loss, a
specific one.

`separateLoops()` must partition every hole-scoped feature by loop, not just the
numbered hole ways. A loop's payload should contain that loop's greens, tees and
fairways and no others.

### Validate before accepting

Each loop must be **contiguous from 1** with no gaps. A loop yielding 6 of 18
numbers means separation failed — fail the job loudly rather than publishing the
fragment. This is the check that would have caught Te Ārai on its own.

---

## Publishing N courses

**This is the real new capability.** `saveResolvedGeometry` (line 170) PATCHes an
existing row and throws when there isn't one — the mapper has never created a
`course_maps` row, only filled one in. Rows are created by `course-maps.mjs` when
the picker selects a course.

So the worker needs to insert rows for discovered siblings. Per loop:

| Column | Value |
|---|---|
| `course_id` | slug of the polygon `name` — `te-arai-north` |
| `course_name` | polygon `name` — "Te Ārai Links — North Course" |
| `course_lat` / `course_lng` | loop centroid |
| `osm_course_ref` | **new column** — `way/123456`, the stable identity |
| `hole_count` | 18 |
| `region` / `country` | from the parent row |

**Fan out inside the one job, don't enqueue child jobs.** The payload is already
in memory, and Overpass is a shared goodwill-funded API — `selectNearestLoop`'s
own comment makes that point and it still holds. One job writes N rows and
enqueues N visual snapshots.

### `osm_course_ref` is the important bit

Names change; OSM element ids don't. Without a stable anchor, a rescan after a
name edit orphans the course's visuals and shot history behind a new
`course_id`. Match on `osm_course_ref` first, slug second.

New column, nullable, indexed:

```sql
alter table course_maps add column osm_course_ref text;
create index on course_maps (osm_course_ref);
```

---

## Naming

1. **Polygon `name` tag** — free, exact, what `courses-near` already reads.
2. **No name** — publish anyway with a provisional label and a
   `name_confidence: "provisional"` flag. An unplayable course is worse than a
   provisionally-labelled one; the player knows which course they're standing on
   and only needs two distinguishable entries to choose from.
3. **Confident naming from scorecard distance matching** — later, and only once
   scorecards actually exist. See below.

Do **not** derive "North"/"South" from relative position. It reads as fact and is
a coin flip against the club's actual naming.

---

## Ordering

1. `separateLoops()` + contiguity validation, unit-tested on a fixture of two
   interleaved 18s.
2. `osm_course_ref` migration.
3. Worker fan-out: insert sibling rows, save geometry per loop, chain N visual
   snapshots.
4. Delete the five items in the Delete table. Prove with `npm run test:boot` +
   grep.
5. Re-scan Te Ārai. Expect `te-arai-north` and `te-arai-south`, 18 holes each,
   both in the picker with distances.

## Cleanup

- Delete the `te-rai` row, its `course_visuals` row, and its visual assets. Those
  6 holes are neither course — nothing to migrate.
- Diacritic-safe slug (`normalize("NFD")` + strip combining marks) before any new
  IDs are minted, or `te-arai-north` becomes `te-rai-north`. One shared helper;
  delete the ~18 copies.
- Return `diagnostics` on successful jobs, not just failures.

## Not in scope

- Scorecard fetching (separate, and see below).
- The `finitePoint` Null Island guard in `gd-course-location.js:46` — one-line
  fix, unrelated, do it anyway.
- Request coalescing on course-open.
