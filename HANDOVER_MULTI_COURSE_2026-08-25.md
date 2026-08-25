# Handover — multi-course mapping / scorecard engine
**2026-08-25.** Written to close out a long session. Read this first in a fresh chat.

Started as "why did Te Ārai Links (36 holes) publish 6?" and turned into the multi-course
route plus a scorecard engine.

---

## Where it stands

Te Ārai now scans as **two rows** instead of one 6-hole row. Latest scan (job 01:06:54):

```
stages       ["around:1400", "widened-to-site-extent"]
widened      adopted, 27 -> 35 hole features
naming       resolved, score 0.858, margin 0.410   (both courses named from cards)
separated    [18 holes contiguous, 17 holes not contiguous]
published    North 16 holes, South 14 holes
visualChain  both refused: coverage-incomplete
```

So: detection, widening, card matching and naming all work. **Hole counts are still short**
and the visual chain is correctly refusing to render an incomplete course.

---

## Uncommitted right now

```
M functions/course-mapper-worker-background.mjs
M dev/multi-loop-detection.test.js
```

That is the **sibling re-partition fix** and its regression test. Not yet deployed, not yet
verified by a scan.

The bug: `separateLoops` allocates holes correctly (containment, then routing continuity),
then `resolveCourseGeometry` was handed the *other* course's centroid as a sibling point.
`guideBelongsToCourse` is per-hole nearest-centre assignment — the exact rule that caused the
original 6-hole publish — so it re-partitioned holes that had already been allocated properly.
North came out of separation contiguous 1–18 and published 16.

Fix is one line:

```js
const geometry = resolveCourseGeometry(loop.payload, courseId, loop.centre || course.center, [], []);
```

`[]` for siblings. Separation has already done the allocation; nothing downstream should
second-guess it. All 11 test files pass.

**Next step: deploy, re-scan Te Ārai, expect North -> 18.**

---

## Still open after that

1. **Second widen pass.** Post-widen hole spread came back 3361 m against a 2198 m frame —
   the single widen may still be cutting holes off. Check `diagnostics.widened` before/after
   counts on the next run.
2. **South's own shortfall.** South was 17 holes and non-contiguous *out of separation*,
   before the sibling filter touched it. That is a separate problem from #1 and #2 above.
3. **Course picker chooser.** `facility_key` column and sibling tagging are in the DB.
   The picker UI is untouched — per your constraint. The change is
   `Search result -> Play/Scan` becoming `Search result -> Choose Course 1 or 2 -> Play`.
4. **Terminology rename** — started, then stopped. See below.
5. **Labelling pass.** "Course 1/2" -> real names via characteristics, where cards do not
   already resolve it. `gd-course-rename-core.mjs` has the safe-rename rules ready.
6. **489 orphaned files / 239 MB** still in the bucket. The Studio panel exists
   (System -> Storage) but needs a deploy before you can clear them.
7. **Strike the North Shore line** from `MULTI_COURSE_FACILITIES_PLAN_2026-08-19.md`.
   It records a previous session's misreading as if it were a finding about club websites.
   It was never a real error — waiting on your correct reading of that sentence.

---

## The terminology rename (agreed, not done)

"Loop" is not a domain word — your own plan doc rules it out:

> Terminology, if a name is ever needed: "facility", "course", "nine", "combination".
> No app or rulebook uses "loop"

It is also not just cosmetic. Having two words for one thing is part of how the
double-partition survived: `separateLoops` produced "loops", then `resolveCourseGeometry`
partitioned by "course" centre, and because they read as different concepts nothing flagged
that the same allocation was happening twice under two rules. `separateCourses()` feeding a
course-partitioner would have looked obviously wrong.

The rename:

```
separateLoops        -> separateCourses
loopIsContiguous     -> courseIsContiguous
loopLengthsFromOsm   -> courseLengthsFromOsm
matchLoopsToCards    -> matchCoursesToCards
nameLoopsFromCards   -> nameCoursesFromCards
LOOP_SEPARATION_M    -> COURSE_SEPARATION_M
diagnostics.separated[].* / loopNaming / loopId
dev/multi-loop-detection.test.js -> dev/multi-course-detection.test.js
```

`detectHoleNumberCollision` returns `loops` — that one should become `courseCount`, since it
is counting how many courses a hole number appears on.

Files in scope (non-build, non-recovered):

```
functions/lib/gd-automapper-core.mjs
functions/lib/gd-course-fit-core.mjs
functions/lib/gd-course-rename-core.mjs        (doc comment only)
functions/lib/gd-scorecard-match-core.mjs
functions/lib/gd-scorecard-resolve.mjs
functions/course-mapper-worker-background.mjs
dev/multi-loop-detection.test.js
dev/multi-course-separation.test.js
dev/course-rename-core.test.js                 (doc comment only)
dev/scorecard-resolve.test.js
MULTI_COURSE_MAPPING_SPEC_2026-08-25.md
SCORECARD_ENGINE_SPEC_2026-08-25.md
TE_ARAI_SCAN_INVESTIGATION_2026-08-25.md
```

Only cost: diagnostics keys already written into `course_mapper_jobs` rows keep the old
names, so old job rows read with the old vocabulary. Small, and worth it.

Do this as its own pass, not mixed into the geometry work.

---

## What changed this session

**`functions/lib/gd-automapper-core.mjs`**
- Diacritic-safe `slug()` — `Te Ārai` was becoming `te-rai`.
- `selectNearestLoop` **deleted**, replaced by `separateLoops`. The old one kept one loop and
  assigned per hole number by nearest centre; that is what published 6 holes. The new one
  returns every loop, and partitions *all* hole-scoped features — the old passthrough left
  32 greens from both courses competing against 16 mixed guides.
- `expandOsmFrame` — **pad first, normalise second**. It normalised first, and
  `normalizedOsmFrame` rejects zero-area boxes while `osmScopeFrame` deliberately builds a
  point frame, so it returned `null` for every around-scope. That silently broke the new
  widen *and* the months-old `wider-retry`. After the fix, features went 27 -> 35.

**`functions/lib/gd-scorecard-match-core.mjs`**
- Three relative signals scored jointly: `parClassOverlap` 0.45, `rankCorrelation` 0.4,
  `lengthShare` 0.15. Relativity, per your framing — immune to tee set, units, dogleg error.
- `permutations` -> `injections`. Permuting 4 cards across 2 loops gave 24 permutations
  collapsing to 12 mappings, so the runner-up was the *same* mapping reshuffled and the
  margin was exactly 0. Every multi-card site was being refused as "cards-too-alike".

**`functions/lib/gd-scorecard-parse-core.mjs`** — row-labelled table parser (holes as
columns, the transpose of what the old parser assumed). Regex grid extraction, no DOM.

**`functions/lib/gd-scorecard-resolve.mjs`** — `resolveScorecard(course, deps, {want})`.
Distinctness is **layout-based**, not title-based: par sequence then distance rank order. Two
cards under one generic heading count as 2; one course published under two titles counts as 1.
`cardNameMatchesCourse` caught a bluegolf.com card for the wrong club.

**`functions/lib/gd-course-fit-core.mjs`** — `courseCoverageComplete`. Card is the authority;
standard 9/18/27/36 is the fallback shape. Te Ārai's `[9,10,12,13,16,17]` fails as
`holes-not-contiguous`. The visual chain is gated on this.

**`functions/lib/gd-course-cleanup.mjs` + `functions/course-orphans.mjs` + Studio panel** —
cascade delete on course removal, plus a panel to see and clear leftovers. `findOrphans`
starts from **bucket folders**, not table rows: my own SQL cleanup of 4 orphaned
`course_visuals` rows removed the only pointer to 233 MB of files and made them *less*
discoverable. Starting from the bucket also surfaced `cromwell`, which had never been visible.

**`functions/lib/gd-course-rename-core.mjs`** — names are labels, not identity. Rename never
touches `course_id` / `osm_course_ref`, always appends the old name to `course_aliases`,
only ever moves to a *more specific* name, caps aliases at 12.

**Migrations applied:** `add_course_osm_ref`, `add_course_aliases`, `add_course_facility_key`.

**Recovered:** `_recovered/scorecard-2026-08-02/` — a 612-line parser deleted on 2026-08-02
in "Cut over Play to the /app/ rebuild". Collateral damage, not a deliberate retirement.

---

## Things I got wrong, so you do not have to re-find them

- **Cited a fabrication twice.** I quoted a previous session's misreading of a sentence as
  evidence that club websites cannot be trusted about course counts. It was never a real
  finding. Still sitting in `MULTI_COURSE_FACILITIES_PLAN_2026-08-19.md`.
- **Said "green pairing."** Not a thing we use. `holesResolved` is `guides.length` from
  `chooseAutoMapGuides`, counted *before* greens are matched. Greens were irrelevant.
- **Said "cache hit"** for scorecards. It is a `SELECT ... LIMIT 1` on `course_scorecards`.
  Server-side, nothing client-side about it.
- **Guessed Studio's auth token.** `window.GDSupabaseAuth` / `gd_supabase_session` do not
  exist. The real one is `window.ClaritySupabaseAuth.freshAccessToken()`, already wrapped by
  the global `gdAdminCourseDbAccessToken()`.
- **`diagnostics.widened` only recorded on success**, so "ran and found nothing" was
  indistinguishable from "never ran" — which sent me to the wrong conclusion for a while.
  It now always records `attempted` / `adopted` / before / after.
- **502 from `listCourseFiles`** — depth-first serial walking blew Netlify's 10 s limit.
  Now breadth-first, parallel, shared 7 s deadline, reports `filesPartial`.

---

## Principles this settled on

- **Names are not truth.** Identity is `course_id` / `osm_course_ref` / `facility_key`.
  `course_name` + `course_aliases` are display attributes.
- **Relativity, not absolutes.** Which tee set the card uses does not matter. The relationship
  between holes does, and that survives every unit and measurement difference.
- **Cards discriminate, geometry does not.** Both of the worst bugs today
  (`selectNearestLoop`, `guideBelongsToCourse`) were spatial heuristics doing a job the card
  comparison does more reliably.
- **Never delete storage objects via SQL.** Supabase orphans them in the bucket — still
  stored, still billed, no longer listed. Storage API only.
