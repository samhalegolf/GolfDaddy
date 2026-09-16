# Fancourt Golf Estate scan — what actually happened

**Course:** Fancourt Golf Estate, George, South Africa. Three 18s on the ground (Montagu, Outeniqua, The Links).
**Job:** `6f7272aa-46e4-496f-b6c3-3c080b6e160e`, 2026-09-16 06:22:30 UTC, mapper v2, requested by a guest device. Ran 19s, `status: done`.
**Result:** two courses published with provisional names, both incomplete, no visuals, no watch map.

| Row | Name | Holes | Missing | Visual chain |
|---|---|---|---|---|
| `fancourt-golf-estate` (pinned) | Fancourt Golf Estate - Course 1 - 6500m West | 17 | 3 | skipped: holes-not-contiguous |
| `course-2-5444m-east` | Fancourt Golf Estate - Course 2 - 5444m East | 15 | 6, 13, 14 | skipped: holes-not-contiguous |

Every green is `osm_auto_green_estimate` (OSM has one green polygon on the whole estate). The job
row carries both warnings it should: "separation is not trustworthy here" and "published with
provisional names". Nothing crashed. The wrong answer was reached in an interesting way.

Replayed end to end against live OSM with the real `gd-automapper-core.mjs` functions
(`scratchpad/replay.mjs`, `scratchpad/widen.mjs`). Every number below is from that replay and
matches the job diagnostics exactly.

---

## What OSM has at Fancourt

Three 18-hole sets of `golf=hole` ways in the area, three `leisure=golf_course` polygons:

| Set | Way ids | Refs | Where |
|---|---|---|---|
| West | `1169553468–485` | 1,2,4–18 + one **unnumbered** way (`1169553479`) | 22.405–22.428 E |
| East | `1352628584–601` | 1–18, with `par` tags | 22.429–22.439 E |
| George Golf Club | `52721563–583` | 1–18 | 22.437–22.446 E, the neighbouring club |

| Polygon | Name | Bbox |
|---|---|---|
| `way/47154776` | Fancourt Golf Estate | 22.395–22.430 E, -33.974 to -33.948 |
| `way/47154775` | The Links at Fancourt | 22.412–22.430 E, -33.970 to -33.962 — **nested inside the estate polygon** |
| `way/47154781` | George Golf Club | 22.437–22.446 E |

Two things to notice. The east course sits entirely **outside both Fancourt polygons**. And the
Links polygon is nested inside the estate polygon, so the estate polygon is a facility outline,
not a course.

The unnumbered west way runs from the west hole 2 green (22.4118) to the west hole 4 tee
(22.4154). It is hole 3 with no `ref`. That hole is genuinely unrecoverable from OSM numbering.

---

## The three query stages, replayed

**1. `around:1400`** from the pin (-33.9610, 22.4085 — the hotel, on the west edge of the site).
Returns 12 west holes and both Fancourt polygons. No east holes.

**2. `footprint-bbox`** — estate polygon bbox + 160m pad, east edge **22.4317**. Returns all 17
numbered west holes plus 7 east holes that happen to have a node west of 22.4317
(E1, E5, E7, E8, E9, E17, E18). 24 hole features, 7 collided numbers, widest separation 2326m.

**3. `gap-requery`** (see Failure 2 for why this frame exists at all): adds E2, E3, E4, E10, E11,
E12, E15, E16. Now 32 features. E6, E13, E14 are outside every frame that ran. Hence 15.

---

## Failure 1 — the multi-course widen is gated on a field that bbox mode never sets

`functions/course-mapper-worker-background.mjs:1705`

```js
if (collision.multiLoop && collision.widestSeparationM > scope.radiusM) {
```

After a `footprint-bbox` requery, `scope` is `{ mode: "bbox", selector, frame }` — no `radiusM`
(`osmQueryScope`, `gd-automapper-core.mjs:262`). So the test is `2326 > undefined`, which is
`false`. The widen never runs, `diagnostics.widened` is absent from the row, and the job looks
like a site that never needed widening.

Te Arai never hit this because Te Arai has no course polygon, so its scope stayed in `around`
mode. Fancourt is the first multi-course site *with* a polygon to go through, and the polygon
disabled the widen. That is backwards: the sites most likely to outgrow their first frame are
exactly the ones that reach this line in bbox mode.

**Fix:** compare against the scope's actual reach — `osmScopeFrame(scope, centre)` already
exists and answers "how wide was the last query" for either mode. Something like
`spanOf(osmScopeFrame(scope)) < widestSeparationM` instead of `scope.radiusM`. Record
`diagnostics.widened = { attempted: false, reason }` on the skip path too, so a row can never
again be silent about whether widening was considered.

---

## Failure 2 — `assignByContainment` treats a facility outline as a course and drops holes outside all polygons

`functions/lib/gd-automapper-core.mjs:743`

After stage 2 the separation ran by **containment**, not routing, and produced:

| Loop | Polygon | Holes |
|---|---|---|
| 0 | Fancourt Golf Estate | W1, W2, W18 |
| 1 | The Links at Fancourt | W4–W17 |
| — | (none) | E1, E5, E7, E8, E9, E17, E18 — **dropped** |

Smallest-containing-polygon wins, so the Links polygon takes the 14 west holes inside it and the
*estate* polygon is left holding the three west holes that spill past the Links boundary. That
is one course split into a 3 and a 14 by a nested outline. The seven east holes are inside no
polygon at all; `placed` was 17 of 24 = 71%, over the 60% floor, so containment returned a
"success" with a third of the fetched holes silently missing from every loop.

The dropped holes then leak back in through `partitionSupportingElements` (`:816`): anything
that is not in a loop's `features` is treated as a *supporting* element and bucketed to the
nearest loop. So loop 1's payload ended up carrying **east** hole 1 as if it were a green or a
bunker. `holeGapFrames(loop.payload)` (`:866`) then saw hole numbers 1 (east), 4–17 (west) and
reported a gap `[2, 3]` anchored on **east hole 1's green** and **west hole 4's tee** — two holes
1.6km apart on different courses. That is the recorded `gapFill.gaps[0]`.

That accidental 1.1km × 2.8km box is what fetched the other eight east holes. With 15 east holes
outside every polygon, containment now failed the 60% floor, `separateLoops` fell through to
routing, and routing chained 17 + 15. `after.holes 32 > before.holes 17`, adopted. The published
result is a recovery from a bug by way of another bug.

**Fixes, in order of value:**

1. A polygon that contains another course polygon is a facility, not a course. Exclude it from
   the containment buckets (or use it only for holes no inner polygon claims, and then only if
   that residue is itself a plausible loop — 3 holes is not).
2. Unplaced hole features must never be dropped. Either containment returns null when any hole
   feature is outside every polygon, or the unplaced features form their own routing group.
3. `partitionSupportingElements` must skip `golf=hole` ways. A hole is never a supporting element.
4. A 60% floor is not a floor for hole features — every numbered hole must land somewhere.

## Why fixing Failure 1 alone makes Fancourt worse

Replayed with the widen the worker would have built (frame 22.389–22.448 E, -33.993 to -33.944):
it fetches all 53 numbered holes — all 18 east including 6, 13, 14 — **and all 18 of George Golf
Club**. Containment then returns three loops: estate polygon (W1, W2, W18), Links polygon
(W4–W17), George Golf Club polygon (1–18, contiguous), and drops the entire east course because
it is inside no polygon (35 of 53 placed = 66%, passes the floor).

So with the widen gate fixed and containment untouched, Fancourt publishes George Golf Club as a
Fancourt sibling and loses the east course completely. Failure 2 has to be fixed first or
alongside.

---

## Failure 3 — the west course's hole 3 has no number, and the separated path has no answer for that

Way `1169553479` is hole 3 by geometry (starts at hole 2's green, ends at hole 4's tee) but has
no `ref`. `fillMissingHoleByElimination` exists in the core for the single-course path; the
separated-loop publish (`publishSeparatedLoops`) never calls it. A loop that is 1..n with exactly
one number missing, one unnumbered hole way in its payload, and that way sitting between the
two anchors is the textbook case for it.

---

## Failure 4 — sibling ids are not scoped to the facility

`course-mapper-worker-background.mjs:509`, `loopCourseId`:

```js
if (loop.name) { const fromName = slug(loop.name); if (fromName && ...) return fromName; }
return slug(course.courseId + "-course-" + (index + 1));   // never reached for provisional names
```

`nameLoopsFromCards` assigns the provisional name ("Course 2 - 5444m East") *before* ids are
derived, so `loop.name` is always set and the id becomes `course-2-5444m-east`. The scoped
fallback the comment describes never fires. Existing rows show the pattern: Te Arai `course-2`,
TPC Sawgrass `course-2-6074m-north-west` … `course-5-3314m-south-east`, Millbrook
`course-3-6724m-east`. Two facilities whose second loop measures the same length and compass
would collide on `course_id`. Only a `nameSource !== "provisional"` name should mint an id from
itself.

---

## Smaller things seen on the way

- The pinned row's `published_at` is `null`. The pinned course is written with PATCH
  (`:712`) and only the sibling insert stamps `published_at`. Harmless today, misleading in
  Studio.
- `facilityStructure.expectedLoops: 4` is `ceil(32 / 9)`, nines of ground, not a course count.
  Reads like "four courses" on the row.
- Scorecard resolve found only Montagu on GolfPass (`course_scorecards` row keyed
  `fancourt hotel and country club estate - the montagu course`, facility_key
  `fancourt-golf-estate`). Two cards short of naming anything; both rows wait on
  Update Scorecards.
- OSM's "The Links at Fancourt" polygon contains 14 of the 17 west holes, so the west set is
  most likely The Links. Not asserted anywhere in the data, and the polygon name was thrown away
  when containment lost to routing.

## What a correct run needs

1. Widen gate that works in bbox mode (Failure 1).
2. Containment that ignores facility outlines and never drops a hole (Failure 2). With both,
   the replay gives: West 17 + unnumbered, East 18 contiguous, George 18 contiguous. George then
   has to be recognised as a different facility (its polygon has its own name and sits outside
   the Fancourt outline) rather than published as Course 3.
3. Elimination fill on the separated path for the unnumbered hole 3 (Failure 3).
4. Facility-scoped sibling ids (Failure 4) — needs a data migration for the existing bare ids.

---

## Fixed 2026-09-16 (same day)

Failures 1 and 2 are fixed in code; 3 and 4 are not.

**Containment** (`gd-automapper-core.mjs`, `assignByContainment` and around it):
- An outline that contains another outline is the facility, never a course. A *lone* outline
  holding the same hole number twice on different ground is also the facility (the Millbrook /
  "whole property" shape). Two overlapping course outlines are left alone — on an interleaved
  site each catches a few of the other's holes and that is not evidence of a site.
- A hole inside no course outline is never dropped. It joins the outline whose routing it
  continues (tee within `HOLE_CONTINUITY_M` = 250m of the previous green, or green within that of
  the next tee, 18 wrapping to 1), attaching one hole at a time so a three-hole spill chains in.
  Whatever is still unclaimed routes among itself as its own loop(s).
- When a facility outline exists, a course outline wholly outside it is another club. Its loop
  is separated (so its greens cannot pair with ours) and then set aside on `loops.excluded`,
  which the worker writes to `diagnostics.neighbouringClubs`. Never published, never silent.
- `partitionSupportingElements` skips numbered hole ways. Unnumbered ones still travel with the
  nearest loop, which is what an elimination fill needs.

**Widen gate** (`course-mapper-worker-background.mjs`): compares against `osmScopeReachM(scope)`
— the radius in around mode, half the shorter side of the frame in bbox mode (1603m for
Fancourt's footprint frame). The skip path now writes `diagnostics.widened = { attempted: false,
reason: "site-within-sweep", ... }` so a row can never again be silent about it.

**Replayed against live OSM with the fixed code:** footprint stage separates as Links 17
(1, 2, 4–18, unnumbered 3 riding along) + east 7 by routing; the gate fires (2326 > 1603); the
widened payload separates as Links 17 + east 18 contiguous, George Golf Club excluded with
18 contiguous. Tests: `dev/multi-course-separation.test.js` gained a Fancourt-shaped fixture.

**Still open:** Failure 3 (elimination fill for the unnumbered hole 3 on the separated path),
Failure 4 (unscoped sibling ids). `package.json`'s `test:nearest-loop` points at a file that
no longer exists — pre-existing, not touched. The Fancourt rows in `course_maps` are still the
17/15 publish; a rescan is needed to replace them.
