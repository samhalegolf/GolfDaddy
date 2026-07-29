# CLARITY CADDY SYSTEM MAP

Version: 1.0  
Purpose: Ownership map for Clarity Caddy systems. Use this with `CLARITY_CADDY_TRUTH_FILE.md` before editing code.

---

## Product Skeleton

Clarity Caddy is a coaching platform and GPS caddy app.

Core lifecycle:

```text
Image Scan
→ Practice Data Photo Scan
→ Practice Shot Data Gate
→ Native Club Data
→ Cluster Finder / Practice Bubble Generator
→ Practice Bubble
→ Adopt Practice Bubble as My Bubble
→ GPS Play
→ Course Data Collection
→ Course Bubble
→ Compare Practice Bubble / My Bubble / Course Bubble
→ Update My Bubble from Practice Bubble when intentionally chosen
```

The shared system language is the stable degree offset.

---

## Practice Data Photo Scan

Owns:
- Photo processing

Must NOT own:
- Cluster logic
- Bubble generation
- My Bubble adoption

Inputs:
- Photo

Outputs:
- Raw Club/Ball Data

---

## Practice Shot Data Gate

Owns:
- Translates scanned data into native formatting
- Stores native data into the library

Must NOT own:
- Cluster logic
- Bubble generation
- My Bubble adoption
- Course data
- GPS Play

Inputs:
- Raw photo process data

Outputs:
- Native Club Data

---

## Cluster Finder / Practice Bubble Generator

Owns:
- Cluster logic
- Practice pattern detection
- Filtering what matters vs what should be disregarded
- Finding the stable offset degree
- Generating Practice Bubble

Must NOT own:
- Photo processing
- Native data storage
- My Bubble adoption
- Course data
- GPS Play

Inputs:
- Native Club Data

Outputs:
- Practice Bubble
- Stable Offset Candidate
- Practice bubble shape/scale values

---

## Practice Bubble

Owns:
- Exists in the practice data graph
- Can be projected on the comparison graph
- Represents practice evidence

Must NOT own:
- Course Bubble
- My Bubble

Inputs:
- Cluster Finder / Practice Bubble Generator

Outputs:
- Practice Bubble

---

## My Bubble

Owns:
- GPS screen bubble projection
- Active playing model

Must NOT own:
- Practice Bubble
- Course Bubble
- Raw shot data
- Automatic learning
- Course statistics

Inputs:
- Manual adjustment
- Coach adjustment
- Intentional Practice Bubble offset adoption

Outputs:
- Projection combined with Bag and normal club scaling logic

Notes:
- My Bubble is not fluid.
- My Bubble is not a moving average.
- Course Bubble must never update My Bubble.
- Normal users should not need to see the degree value.

---

## Bag

Owns:
- Club distances

Must NOT own:
- Anything else
- Offset generation
- Bubble truth
- Course analysis
- My Bubble updates

Inputs:
- Club generator
- Manual input

Outputs:
- Carry and total numbers per club

Notes:
- Bag scales truth. It does not create truth.
- Ghost Bag must always exist when no real Bag exists.

---

## Course Picker

Owner:
- `scripts/inline/gd-course-picker-search-v2.js`
- Public API: `window.GDCoursePicker`

Owns:
- Picker initialization
- Picker open/close lifecycle
- Search input and result rendering
- Nearby and assumed-course presentation
- Resume-round picker presentation and selection entry
- Picker-scoped one-shot GPS request
- Selected-course identity
- Saved playable-course lookup
- One mapping-controller invocation
- Mapping result handling
- One GPS Play handoff after a playable course result

Must NOT own:
- AutoMapper internals
- Native Course Geometry Resolver or hole labelling internals
- Green Shape Engine detection
- Live GPS watches
- One-tap fallback internals
- GPS Play runtime
- Shell ownership
- Course-location pin persistence beyond delegating the existing prompt in this transitional carve

Inputs:
- User course search/nearby/resume selection
- Picker one-shot GPS observation
- Published course-map availability
- Saved playable-course readiness

Outputs:
- One selected-course identity
- One mapping-controller request when mapping is required
- One GPS Play handoff when mapping/readiness returns playable

Notes:
- The picker calls only `runCourseMappingAttempt` / `gdRunCourseMappingAttempt` for mapping.
- The mapping order remains saved playable course -> server course package (AutoMapper, falling back to the Native Course Geometry Resolver / hole labeller server-side if OSM has shapes but no hole numbers - both run entirely on the server now) -> one-tap live-map fallback.
- Legacy globals remain compatibility aliases into `window.GDCoursePicker`.

---

## GPS Play

Owns:
- Round flow
- Next hole
- Behaviour relative to GPS pin
- Pretend GPS tap flow
- Bubble projection scaled to real size
- Wind/slope/environment adaptations
- Carry marker line from Bag/distance output
- Wind simulator + live feed interaction
- Scorecard generation
- Hole picker
- Slope display

Must NOT own:
- Course mapping
- Core My Bubble
- Practice processing
- Course library truth
- Course Data save/no-save authority

Inputs:
- Course Map
- Wind data call
- Slope data call
- GPS location
- Pretend GPS tap flow
- Shot end vs origin capture

Outputs:
- Course Shot Data events for Course Data Collection

Notes:
- GPS Play is core, brittle, and still under active development.
- GPS Play must obey the framed-box camera model.
- GPS Play must not revive legacy systems through hidden fallbacks.

---

## Course Data Collection

Owns:
- Itself
- Deciding what to send to Course Data and what not to send

Must NOT own:
- GPS playing states or flow
- My Bubble updates
- Golf statistics dashboard logic

Inputs:
- Green focus/result marker
- Shot End button hit or haptic feedback method
- Valid previous held Bubble/shot transaction

Outputs:
- Shot data

Rules:
- Missing Course Data is acceptable.
- Corrupt Course Data is not acceptable.
- No valid held Bubble pairing means no save.

---

## Course Bubble

Owns:
- Its own projection and scaling inside the Course Data workspace
- Course comparison view

Must NOT own:
- Anything else
- My Bubble updates
- GPS playing state

Inputs:
- Shot data from course

Outputs:
- Projection of course data on its own screen and comparison

---

## Green Wand

Owns:
- Itself
- Green shape improvement when called by Auto Course Mapper

Must NOT own:
- Anything else
- GPS Play
- My Bubble
- Course Data
- Auto Course Mapper flow beyond its specific output

Inputs:
- Call from Auto Course Mapper

Outputs:
- More accurate green shape than might be initially available to Auto Course Mapper

---

## Auto Course Mapper

Owns:
- Generating a course map by session/opening
- Saving/generated course maps to database when appropriate
- Initial hole frame snapshot
- Geomarked objects

Must NOT own:
- Every refresh
- Continuous remapping
- GPS Play behaviour
- My Bubble
- Course Data interpretation

Inputs:
- Scanning a new course
- One-time scan/update of library course per user/session/open

Outputs:
- Course map for GPS round flow
- Initial hole frame snapshot
- Geomarked objects

Rules:
- Do not remap cached mapped courses on every open.
- Green truth is primary.
- Fairway line supports orientation and unreachable-green anchoring.
- Tee location is useful but not sacred.

Server split (course-package migration, 2026-07-29): the OSM query/parse/hole-resolution
algorithm above is now ported server-side, verbatim-equivalent, in
`functions/lib/gd-automapper-core.mjs`, run by `functions/course-mapper-worker-background.mjs`
against jobs queued through `functions/course-mapper-jobs.mjs` (table `course_mapper_jobs`).
The Native Geometry Resolver fallback (numbers holes via scorecard-distance matching when OSM
exposes shapes but no hole numbers) made the same move the same day, to
`functions/lib/gd-geometry-resolver-core.mjs`, invoked from the same worker immediately after
the AutoMapper pass, before the job is marked done. **Both systems are now 100% server-side.**

The client-side top-level AutoMapper orchestrator (`autoMapOsmCourse`) and its scheduler
(the direct-call branch of `scheduleOsmAutoMapForPlay`), and separately the entire client-side
Native Geometry Resolver integration (its own OSM source-acquisition step, scorecard-evidence
gathering, guide/frame math, and the `resolveCourseGeometryGuideBundle` orchestration that used
to run it inline from `loadOsmGuideBundle`) have all been REMOVED from
`scripts/gd-course-library-pin-lock.js` - per the architecture doc's acceptance criterion "No
AutoMapper logic runs on the user's phone", now extended to cover the Native Geometry Resolver
too. `runCourseMappingAttempt` now calls `resolveGeometryFromServerPackage()`, which checks
`GET /api/course-package` and, as a side effect of that request, triggers a server mapping run
if none exists yet (the server worker tries AutoMapper geometry AND the Native Geometry
Resolver fallback before giving up). A miss there is not an error - it falls straight through
to the manual/interactive green fallback (reason `server-map-not-ready`); there is no second
client-side geometry source left to try. The manual "Auto" tool in the full-mapping flyout
calls `runServerAutoMapTool()` (trigger + short poll + toast), not a local OSM scan.

The client has zero geometry-resolution logic left. The only client-side consumer of OSM data
remaining is `loadOsmGuideBundle` (plus its shared fetch/parse/cache helpers and
`automapperDebugDetails`), which is unrelated to `runCourseMappingAttempt` entirely - it now
exists solely for the live, unrelated manual "Full Mapping Mode" guide-line overlay feature
(an operator-facing visual aid, not an automatic mapping path). `runCourseMappingAttempt` makes
no Overpass calls at all any more, whether AutoMapper or Native Geometry Resolver flavored.

---

## Course Package Boundary Gate

Owns:
- The single decision of whether it is safe, right now, to swap a mid-round-arriving Full Map
  Package into what GPS Play is rendering, versus holding it until the active hole changes.

Must NOT own:
- GPS Play rendering
- Frame downloading, caching, or hydration
- Hole tracking (it takes hole numbers as plain input; see
  `scripts/inline/gd-course-package-boundary-gate-v1.js`)

Inputs:
- `armedAtHole` (the hole in play when a course-frames watch started) and `currentHole`
  (read via `window.gdActivePlayingHole`), supplied by `gd-app-core.js`'s
  `gdEnsureCourseFramesForPlay`/`gdActivateCourseVisualAtSafeBoundary`.

Outputs:
- `true`/`false` - safe to activate now, or hold and re-check later.

---

## Coach / Client Boundary

Coach Dashboard:
- Player list
- Client portal access
- View/adjust linked player setup
- Preload Bag/data/practice setup before player activates

MyGolf:
- Coach’s own personal player account
- Normal player/client experience
- Must remain separate from client portal context

Rules:
- Coach views clients through a portal.
- Coach does not play as client.
- Coach/client state must not bleed into MyGolf.
