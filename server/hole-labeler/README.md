# Hole Labeler Service

Backs `dist/scripts/gd-claude-hole-labels.js`. For courses whose OSM data has
`golf=hole` geometry but no `ref` (hole number) tags, this service numbers the
holes by matching them against the course's official layout map found online,
using the Claude API.

## How it fits the app

`gd-course-library-pin-lock.js` fetches hole guides from Overpass and drops any
`golf=hole` element without a usable `ref`. The client script intercepts that
Overpass response; when refs are missing it asks this service for them, stores
the result, and injects the numbers as `tags.ref` on subsequent fetches. The
existing mapper (`parseOsmHoleGuides`, `autoMapOsmCourse`, green matching,
drawing) runs completely unchanged.

## Pipeline

1. Query Overpass for `golf=hole` ways/relations around the course center
   (same query shape the app uses).
2. Render a georeferenced schematic: each unlabeled hole polyline drawn over
   satellite tiles, tagged with a letter (A, B, C, ...).
3. Claude + web search finds the official course layout map online and screens
   candidates (`golf_hole_mapper.py`).
4. Matching call: schematic + official map -> `{"A": 5, "B": 12, ...}`.
5. Binary validation (every letter assigned, numbers unique, full 1-18 when
   OSM has all eighteen ways). First clean assignment wins; no ranking.

Returns `{"labels": {"way-123456": 4, ...}}` keyed the same way the app keys
guide ids (`${element.type}-${element.id}`).

## Deploy (Render)

The repo root has a `render.yaml` blueprint. In the Render dashboard:
New -> Blueprint -> connect this GitHub repo -> set the two secrets when
prompted (`ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` from Supabase
dashboard -> Settings -> API). The service deploys to
`https://clarity-hole-labeler.onrender.com`, which `index.html` already sets
as `window.gdClaudeHoleLabels.backend`.

Env vars:

- `ANTHROPIC_API_KEY` (required) — Claude API key
- `ALLOWED_ORIGINS` — comma-separated CORS origins
  (default `https://clarity-caddie.netlify.app`)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (optional) — persistent label
  cache in `public.hole_label_cache` (migration:
  `supabase/migrations/20260713_create_hole_label_cache.sql`, already applied
  to the clarity-caddie project). Without them the cache is in-memory only.

## Run locally

```bash
pip install -r requirements.txt
ANTHROPIC_API_KEY=sk-... ALLOWED_ORIGINS=http://localhost:8888 \
  uvicorn caddy_osm_hole_labeler:app --host 0.0.0.0 --port 8000
```

Then point the client at it (browser console or index.html):

```html
<script>window.gdClaudeHoleLabels.backend = 'http://localhost:8000';</script>
```

## Endpoints

- `POST /v1/osm-hole-labels` body `{lat, lng, course_name?, elements?}` ->
  `202 {job_id, status: "pending"}` or `{status: "done", result, cached: true}`.
  `elements` is the client's own Overpass payload (preferred — server-side
  Overpass access from cloud IPs is unreliable).
- `POST /v1/osm-hole-generate` body `{lat, lng, course_name?}` -> same job
  shape. For courses with NO `golf=hole` geometry in OSM at all: traces hole
  centerlines from Esri satellite imagery, validated against the course's
  scorecard (lengths), hole-by-hole guide (dogleg directions), and hole-
  sequence adjacency. Result is `{elements: [...]}` in Overpass shape —
  `golf=hole` ways + `golf=green` octagons — which the client injects so the
  app's mapper works unchanged. Requires a findable scorecard; refuses to
  emit unvalidated geometry.
- `GET /v1/osm-hole-labels/jobs/{job_id}` ->
  `{status: "pending"|"done"|"failed", result, error, diagnostics}` (both job types)

## Labeling methods (in order)

1. **Scorecard distances** — one text call: per-hole distances (+ dogleg
   shapes from "hole by hole"/"course tour" pages) matched against measured
   OSM way lengths; ambiguities resolved by hole-sequence adjacency.
2. **Vision match** — lettered schematic vs an online layout map (searched
   across the whole web incl. scorecard backs and signboard photos), with
   measured lengths + scorecard distances provided for scale.

`result` includes `labels`, `course_name`, `source_map_url`, and
`schematic_png_b64` (the lettered snapshot Claude saw — useful for a
verification UI and for debugging bad matches).

The client sends `course_name` automatically from `window.gdAssumedCourseName`;
without it the service falls back to reverse-geocoding via Nominatim, which is
less reliable for club names.

## Production notes

- Labels persist in Supabase (`hole_label_cache`); a course's labels never
  change, so the Claude pipeline runs roughly once per course, ever. `JOBS`
  remain in-memory — jobs are transient (the client polls for ~3 min), fine
  for a single instance. Don't scale to multiple instances without moving
  jobs to shared storage.
- CORS is locked to the app origin via `ALLOWED_ORIGINS`.
- Render's free tier spins down when idle: the first request for a new course
  may take ~50s to wake the instance; polling keeps it alive during a job.
- Some courses (flat, parallel, similar-length holes) will genuinely fail to
  match and return `failed` — the client treats that as "no labels" and the
  app behaves as it does today.
