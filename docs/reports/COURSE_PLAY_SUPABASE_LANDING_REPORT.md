# Course Play Supabase Landing Report

## Scope

Branch: `feature/course-play-supabase-landing`

Base: latest `origin/main` at PR #37 (`3693dceb53e05210b33df7e49de630223065915a`).

This branch creates a manual admin landing point for Course Play Pipeline data in Supabase. It does not make GPS Play read from Supabase, does not change AutoMapper internals, and does not change captured-surface rendering or frame math.

## Product Boundary

Supabase should store durable course geometry and a lightweight frame recipe:

- course identity and normalized course fingerprint
- course status/source/confidence/data version
- hole number/status/source/confidence
- tee point, green centre, green shape, green bounds
- fairway and route points
- frame anchors and presentation state needed to rebuild a frame later
- payload and hole fingerprints for duplicate/update detection

Supabase should not store local captured image/cache data:

- captured tile URLs
- tile manifests
- localStorage manifest keys
- rendered image dimensions and origin pixels
- browser frame-index cache rows
- debug timeline, sync queue, or monitor snapshots

## Existing Source Audit

`scripts/gd-course-play-pipeline.js` currently owns local Course Play Pipeline state in `gd_course_play_pipeline_v1` and the local frame index in `gd_course_play_frame_index_v1`.

The current DB-ready export is available through:

- `GDCoursePlayPipeline.buildCoursePlayDbPayload(courseId)`
- `GDCoursePlayPipeline.exportCoursePlayPayload(courseId)`
- `window.__gdExportCoursePlayPayload(courseId)`

`registerCoursePlayFrame()` explicitly marks frame-index records as local cache with `dbShareable:false` and the note that durable DB sync should prefer course/hole geometry plus frame parameters.

## Endpoint Plan

Add `POST /api/course-play-sync`, backed by `functions/course-play-sync.js`.

The endpoint should accept a sanitized Course Play payload from the admin Course Database UI and respond safely in three modes:

- `dry_run`: validates and reports what would be written without requiring Supabase tables.
- `not_configured`: returns a structured non-crashing response when Supabase env vars are missing.
- `uploaded`: writes/upserts course, holes, and contribution metadata when Supabase is configured and the proposed tables exist.

## Proposed Tables

```sql
create table if not exists course_play_courses (
  course_fingerprint text primary key,
  course_id text,
  course_key text,
  course_name text not null,
  schema_version integer,
  data_version integer,
  status text,
  source text,
  confidence text,
  hole_count integer not null default 0,
  bounds_json jsonb,
  centre_json jsonb,
  payload_hash text,
  payload_json jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists course_play_holes (
  course_fingerprint text not null references course_play_courses(course_fingerprint) on delete cascade,
  hole_number integer not null,
  hole_fingerprint text not null,
  status text,
  source text,
  confidence text,
  tee_point_json jsonb,
  green_centre_json jsonb,
  green_shape_json jsonb,
  green_bounds_json jsonb,
  fairway_points_json jsonb,
  route_points_json jsonb,
  frame_anchors_json jsonb,
  presentation_json jsonb,
  payload_hash text,
  payload_json jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (course_fingerprint, hole_number)
);

create table if not exists course_play_contributions (
  contribution_id text primary key,
  course_fingerprint text not null,
  payload_hash text not null,
  source text,
  dry_run boolean not null default false,
  hole_count integer not null default 0,
  created_at timestamptz not null default now(),
  payload_json jsonb not null
);
```

## Duplicate / Update Strategy

Course upsert key: `course_fingerprint`.

Hole upsert key: `(course_fingerprint, hole_number)`.

The fingerprint should be deterministic from normalized course name and rounded durable geometry. Payload hash should be deterministic from the sanitized payload. Repeated upload of the same geometry should update `last_seen_at`/`updated_at` and avoid creating duplicate course or hole rows.

## Manual Flow

Admin opens Course Database, selects a local course record, dry-runs the sanitized Supabase payload, then explicitly sends it to Supabase. The UI should show fingerprint, hole count, response mode, and any backend warnings.

No automatic read-before-scan is included in this branch.

## Implemented Files

- `scripts/gd-course-play-pipeline.js`: adds `sanitizeCoursePlayPayloadForSupabase()` and `buildCoursePlaySupabasePayload()`.
- `functions/course-play-sync.js`: adds `POST /api/course-play-sync`.
- `netlify.toml`: routes `/api/course-play-sync` to the Netlify function.
- `index.html`: adds manual Course Database dry-run and upload controls.
- `dist/index.html` and `dist/scripts/gd-course-play-pipeline.js`: built Netlify mirrors.

## Payload Sent

The admin upload sends:

- `courseFingerprint`
- `payloadHash`
- `courseId`, `courseKey`, `courseName`
- schema/data/status/source/confidence fields
- `bounds`, `centre`, `holeCount`
- sanitized hole rows with tee, green, green shape, green bounds, fairway, route, frame anchors, and lightweight presentation state

The upload strips local captured/cache fields:

- `capturedManifestKey`
- `frameIndexKey`
- `manifestKey`
- `tileMetadata`
- `tiles`
- `originPx`
- `imageWidth`
- `imageHeight`
- `captureZoom`
- local frame-index storage rows
- debug timeline and sync queue data

## Endpoint Response Modes

- `dry_run`: validates and returns fingerprint/hash/hole count without requiring Supabase.
- `not_configured`: returns HTTP 200 with `ok:false` when Supabase env vars are absent.
- `uploaded`: upserts course and holes, then records contribution metadata.
- `failed`: returns structured backend/Supabase error details without changing client GPS behavior.

## Validation Log

- Confirmed branch was created from latest `origin/main`, and `origin/main` includes PR #37 merge SHA `3693dceb53e05210b33df7e49de630223065915a`.
- Local function dry-run returned HTTP 200 with `configured:false`, `courseFingerprint`, `payloadHash`, `holeCount`, and stripped-field list.
- `npm run build:netlify` completed successfully.
- `node --check functions/course-play-sync.js` passed.
- `node --check scripts/gd-course-play-pipeline.js` passed.
- `node --check dist/scripts/gd-course-play-pipeline.js` passed.
- Inline script extraction/parse check passed for `index.html`.
- Inline script extraction/parse check passed for `dist/index.html`.
