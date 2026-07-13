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

## Run

```bash
pip install -r requirements.txt
ANTHROPIC_API_KEY=sk-... uvicorn caddy_osm_hole_labeler:app --host 0.0.0.0 --port 8000
```

Point the client at it (e.g. in index.html after the script tag):

```html
<script>window.gdClaudeHoleLabels.backend = 'https://your-host';</script>
```

## Endpoints

- `POST /v1/osm-hole-labels` body `{lat, lng, course_name?}` ->
  `202 {job_id, status: "pending"}` or `{status: "done", result, cached: true}`
- `GET /v1/osm-hole-labels/jobs/{job_id}` ->
  `{status: "pending"|"done"|"failed", result, error}`

`result` includes `labels`, `course_name`, `source_map_url`, and
`schematic_png_b64` (the lettered snapshot Claude saw — useful for a
verification UI and for debugging bad matches).

The client sends `course_name` automatically from `window.gdAssumedCourseName`;
without it the service falls back to reverse-geocoding via Nominatim, which is
less reliable for club names.

## Before production

- Swap the in-memory `JOBS`/`CACHE` dicts for Redis or the app DB (results
  currently vanish on restart and are per-worker).
- Tighten the CORS `allow_origins` to the app origin.
- A course's labels never change: cache aggressively; the pipeline should run
  roughly once per course, ever.
- Some courses (flat, parallel, similar-length holes) will genuinely fail to
  match and return `failed` — the client treats that as "no labels" and the
  app behaves as it does today.
