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

1. **Shared plan module + snapshot worker**: extract plan/projection code, job table, enqueue
   endpoint, worker that produces owned captures in Storage. Client downloads captures instead
   of flattening locally when present.
2. **Export worker + recipe port + golden test**: server produces finished frames; client
   prefers them; publish flow = recipe lock + enqueue.
3. **Cleanup**: remove browser fleet-bake, keep single-hole sandbox; auto-enqueue snapshot on
   course publish / geometry change.

## Interim stopgap (already shipped in-browser)

Serial flatten queue (one canvas at a time), canvas released after encode, stitch waits scale
with capture count and degrade to tiles on timeout. This keeps fresh-browser Scan alive until
Phase 1 lands.
