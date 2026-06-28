# Admin Course Database UI Report

## What The Admin UI Shows

Admin Settings now includes a `Database` section with a `Course Database` readout. It is admin-only and read-only.

The course list shows local Course Play Pipeline records with course name, course key, course status, sync status, hole count, holes with tee/green/route geometry, play-data-ready count, frame-index count, manifest count, schema version, data version, updated time, and source.

Selecting a course opens a detail view with per-hole readiness:

- hole number
- state/status
- tee present
- green present
- route present
- frame anchor present
- frame index present
- manifest present
- source/confidence
- sync status
- updated time

The view also includes search by course name/key and filters for sync status and course status.

## Current Data Source

The UI reads local Course Play Pipeline data only:

- `window.GDCoursePlayPipeline.loadCoursePlayPipeline()`
- `window.GDCoursePlayPipeline.getCoursePlayFrameIndex(courseId)`
- `window.__gdExportCoursePlayPayload(courseId)`
- `window.GDCoursePlayPipeline.buildCoursePlayDbPayload(courseId)` as fallback

If the pipeline API is not loaded, the UI falls back to reading the existing local storage buckets directly:

- `gd_course_play_pipeline_v1`
- `gd_course_play_frame_index_v1`

It does not create a new data bucket.

## Payload Preview

The `View DB Payload` control renders a read-only JSON preview for the selected course. The preferred source is `window.__gdExportCoursePlayPayload(courseId)`, falling back to `window.GDCoursePlayPipeline.buildCoursePlayDbPayload(courseId)`.

## Future Supabase Mapping

The UI maps cleanly to the planned database tables:

- `course_play_courses`: course identity, course key, status, source, confidence, schema version, data version, sync status, remote ID, created/updated timestamps.
- `course_play_holes`: hole number, hole state, tee, green, route, fairway, frame anchors, presentation references, confidence, data version, sync status, created/updated timestamps.
- `course_play_contributions`: future contribution/source/audit records for mapped geometry, admin review, imports, and remote sync outcomes.

The current view is intended to make those future rows inspectable before real remote persistence is wired.

## Intentionally Not Included

This patch does not add Supabase writes, delete/overwrite/publish/pull/approve/merge actions, GPS Play links, course launching, remap actions, or user-facing course picker behavior.

It does not change GPS Play interaction, AutoMapper generation internals, Box maths, Bubble maths, Course Data shot logging, Practice systems, Green Wand, Shot End, Live Bubble, auth/payment, or live fallback mode.
