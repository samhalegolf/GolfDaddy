# Visual Engine Server Worker — Plan

Goal: the capture → flatten → compose → export pipeline runs automatically in server code.
Browsers only do two things: tune the recipe on one hole (sandbox) and download finished
frames. No client ever stitches a course again.

## Model (settled 2026-07-21/22)

- **Snapshot** happens once per hole at scan: a kit of owned rasters at role-specific zooms —
  play corridor (~z19, segmented on long holes), green surround (tightest), a slice of course
  backdrop (low zoom), and a terrain/relief reference (modest zoom, compresses tiny).
- **Recipe** is JSON (preset + overrides). Terrain is a work light: hillshade is laid OVER the
  snapshot (multiply blend) to derive shading — never shipped as tiles.
- **Export** = snapshot + recipe composited flat into one owned JPEG per hole (+ overview).
  Recipe change → re-export from stored ingredients. Never re-snapshot unless imagery should
  refresh.

## Architecture

1. **Enqueue**: Scan button / course publish / recipe publish → `POST /api/course-visual-jobs`
   (new Netlify function) → row in new `course_visual_jobs` table
   (`id, course_id, kind: snapshot|export, recipe jsonb, status queued|running|done|failed,
   error, created_at, updated_at`).
2. **Worker**: Netlify **background** function (`functions/course-visual-worker-background.mjs`,
   15-min budget) with `sharp`. Claims a queued job, processes, marks done/failed.
3. **Snapshot job** (per course):
   - Read geometry from `course_maps` (`objects_json`/`holes_json`) — same play-ready rule as
     the admin panel (green + one more point).
   - Compute the capture plan. Port `planCourseVisualCaptures` into a shared module usable by
     both browser and Node (it is pure geometry — no DOM).
   - Replace Leaflet with standard slippy-map math (lat/lng ↔ tile x/y/z, ~20 lines).
   - Fetch tiles per capture (imagery source + hillshade source), composite with sharp →
     one owned JPEG per capture + one relief PNG. Tile budget and zoom-step-down rules carry
     over from the plan.
   - Upload to Supabase Storage `course-visuals/{courseId}/captures/...`.
4. **Export job** (per course, given a recipe):
   - Download the course's captures from Storage.
   - Per hole: compose in the play-axis lens (corridor sharpest on top, surround, backdrop
     under), apply recipe as sharp ops (tone/saturation/tint ≈ today's SVG filters), multiply
     the relief layer for terrain shading, flatten → one JPEG per hole + course overview.
   - Upload `course-visuals/{courseId}/frames/v{N}/h{1..18}.jpg`, write a `course_visuals`
     row: `course_id, version, recipe jsonb + hash, assets jsonb (paths, bounds, lens,
     dimensions)`.
5. **Client changes**:
   - `resolveCourseVisual` / GPS play prefer published cloud frames (download, cache in the
     asset store). "Frame" in the admin panel = a `course_visuals` version exists — the DB
     finally owns the frames concept.
   - Scan button = enqueue snapshot job, poll status chip. Publish = lock recipe → enqueue
     export job. Sandbox single-hole bake stays local and browser-side (cheap, instant).
   - Retire the browser fleet-bake paths (auto-build 18-frame passes) once cloud frames serve.

## Recipe parity

Today's recipe applies as SVG filters (feColorMatrix / feComponentTransfer + multiply blend).
Port each control to an equivalent sharp op and add a golden test: same hole, same recipe,
browser sandbox export vs server export — assert per-channel mean delta under a tolerance.
The sandbox stays the source of truth for how a recipe *looks*; the worker must match it.

## Checks before building

- **Imagery licensing**: storing flattened Esri World Imagery (and hillshade) derivatives in
  Supabase Storage — confirm terms / attribution requirements, or pick a licensed/open source
  (tile source is already configurable via `mapSources`).
- **Budget**: 18 holes × ~4 captures × ≤320 tiles ≈ worst case ~20k tile fetches per course
  snapshot. Throttle, honor HTTP caching, and consider caching fetched tiles in Storage keyed
  z/x/y for re-snapshots.
- **Netlify 15-min cap**: full course fits estimates; if not, split jobs per hole (the queue
  table already supports it via `kind` + a `hole_number` column).

## Phases

1. **Shared plan module + snapshot worker** — DONE 2026-07-22.
   `functions/lib/gd-visual-plan-core.mjs` (plan/policies/lens/tile math, verified against the
   real Pupuke package: 44 captures / ~6.6k tiles), `course_visual_jobs` table + private
   `course-visuals` bucket, `/api/course-visual-jobs` (admin-verified, deduped),
   `course-visual-worker-background` snapshot job (tile fetch, coverage-enforced sharp
   composite, uploads captures + index.json). Scan enqueues the cloud snapshot.
2. **Export worker** — DONE 2026-07-22 (better than planned: instead of porting the recipe,
   the worker STATICALLY IMPORTS the real gd-course-visual-engine.js behind a localStorage
   stub — the engine test suite proved it runs in Node — so stitch/recipe/terrain markup are
   IDENTICAL to the browser, and librsvg rasterizes it (filter primitives verified). Export
   job: downloads captures, engine master+preview bake with the job's recipe, sharp-rasterizes
   frames to JPEG (max 2048w), uploads frames/v{N}/ + frames/index.json. Verified locally
   end-to-end: real tiles -> captures -> engine bake -> H1 frame JPEG. A separate golden test
   is unnecessary under this architecture; visual spot-check remains a manual step.
   Client: `/api/course-visual-assets` read proxy; preview prefers local styled bake >
   cloud frame > base capture; captured reel is the union of local + cloud (fresh browser can
   browse a course it never scanned); Publish enqueues an export job with the locked recipe.
3. **Cleanup / automation** — PARTIAL 2026-07-22: course-maps publish auto-enqueues a
   snapshot when geometry is accepted (server-side, warn-only). Publish still runs the local
   fleet bake alongside the cloud export; retire it once cloud frames prove out in production.
   Remaining: GPS play consuming cloud frames (currently only the admin preview does), and
   tile caching/throttling in the worker if snapshot volume grows.

   2026-07-28: snapshot -> natural export already auto-chains (`enqueueFollowUpExport`), so a
   course only ever needs a snapshot enqueued. `/api/course-visual-jobs` gained `kind:"auto"`
   (any signed-in player, snapshot only, never a recipe, rate limited) and its GET now derives
   a build state - `none | queued | running | captures-ready | frames-ready | failed` - that
   the app can poll while it plays over live tiles. Export output raised 2048 -> 3072
   (`EXPORT_RENDITION_PX`), re-renditioned from the kept masters rather than re-shooting tiles;
   an already-shot course whose `planKey` still matches backfills straight from storage.
   NOT yet verified on a phone, and per the imagery-source registry work the sharpness gate
   should be judged on licensed (LINZ/NAIP) masters, not the Esri-era ones.

   2026-07-28, imagery sources: `functions/lib/gd-imagery-sources.mjs` is the licensing gate -
   a source is returned only if its licence grants storage AND derivatives AND redistribution,
   its region CONTAINS the course bounds, and its key is configured; otherwise null and the
   course runs live-only. LINZ (NZ, `xyz`) and NAIP (US CONUS, new `arcgis-export` adapter).
   Capture policies no longer name a tile source. Entries carry `imagery` + `dem` and no
   hillshade raster - relief is a computation over elevation, so the terrain-reference capture
   is dormant until that lands (the natural recipe never composites it anyway). The source key
   is folded into `planKey` so Esri-era masters cannot be re-renditioned under a new credit.
   Anonymous Esri is out of `mapSources` too; live falls back to OSM without a LINZ key.

   2026-07-28, GPS play consumes frames: engine gained a consumer-only API
   (`courseBuildState`, `requestCourseBuild`, `cachedCourseFrames`, `downloadCourseFrames`,
   `ensureCourseFrames`, `courseAssetUrl`) generated into the client. Cached frames are served
   before any network - the offline round - with a quiet revalidation behind them; an unbuilt
   course enqueues `kind:"auto"` and polls while play runs over live tiles. `index.json` is
   written LAST so a partial download reads back as not cached. `FRAMES_WAIT_MODE` in the
   engine is the single flag for the interim state.
   The load-bearing fix: cloud frames used to reach play via a direct Supabase Storage public
   URL on a PRIVATE bucket, so they never loaded and could not work offline. Play now reads the
   cached data URL, falling back to same-origin `/api/course-visual-assets`. The local styled
   bake is out of play's preference order; the studio preview keeps its own.

## Export engine note (2026-07-22, later)

The engine-in-Node export (nested base64 SVGs) proved parity but was structurally heavy: it
OOM-killed workers and tripped librsvg's 10MB XML limit. Replaced by
`functions/lib/gd-visual-export-core.mjs` - a sharp compositor that ports the engine's
play-axis layout math exactly and applies the recipe as libvips primitives (~2s/hole, ~50MB).
First real publish (cv-pupuke, frames/r3vfiah) was produced by the engine path and visually
matches the compositor output. v1 approximations vs the engine: green-hue tint layers and
fairway airbrush are simplified; sat/brightness/contrast/terrain/floodlight/mow are exact.

## Recipe model (Sam, 2026-07-22)

Effects are LAYERS over the raw capture, all OFF by default. Reset = raw capture. The admin
builds a filter stack, saves it as a NAMED RECIPE (local library `gd_course_visual_recipes_v1`
for now). Next stage: recipes move to the cloud and the export worker takes one by name, so
automation can bake "from natural" (off baseline) or from any saved recipe - create recipe /
apply recipe / automate with recipe.

## Parked idea (Sam, 2026-07-22)

The first floodlight implementation was a directional tee->green beam (a player-held torch
following the target line). Wrong look for course floodlights, but worth resurrecting for
**GPS play lock-in framing**: light the locked target line as part of the lock-in view.
The cone code lives in git history (gd-course-visual-engine.js, floodlightMarkup before the
overhead-pools rework).

## Interim stopgap (already shipped in-browser)

Serial flatten queue (one canvas at a time), canvas released after encode, stitch waits scale
with capture count and degrade to tiles on timeout. This keeps fresh-browser Scan alive until
Phase 1 lands.
