# Course Play Persistence Flow Report

## Purpose

This branch makes the Course Play Pipeline the owned local course-play file and prepares it for a later database sync pass. GPS Play must keep working from local data when database sync is unavailable.

## Storage Buckets

### AutoMapper / Course Library Geometry

Storage key: `gd_user_course_library_v1`

Owner: Course Library / AutoMapper.

Contains raw mapped course objects such as tee, green, fairway, and confirmed object records. This remains the source for mapping creation and repair, but it is not the GPS Play contract.

### Course Play Pipeline

Storage key: `gd_course_play_pipeline_v1`

Owner: `window.GDCoursePlayPipeline`.

Contains the playable course file used by GPS Play. Per-hole records should carry stable geometry, frame anchors, status, confidence, schema version, timestamps, sync status, and database-ready identity fields.

### Captured / V19 Frame Manifests

Storage key pattern: `gd_captured_hole_frame_v19_<course>:h<hole>`

Owner: V19 captured presentation / captured surface registry.

Contains local render cache details, including tile URLs, origin pixels, anchor pins, and presentation metadata. These are cache-first and should not be treated as the durable database object unless a future sync pass explicitly decides to store them.

## Intended Ownership

Course Play Pipeline owns the database-ready course/hole play object.

V19 owns the local render frame cache and presentation adapter.

AutoMapper owns creating or repairing source geometry.

Future database sync should attach to Course Play Pipeline payload builders first, with frame cache sync remaining optional and clearly marked as cache data.

## Implemented Save Contract

Course Play Pipeline records now use schema version 2 while preserving the same local storage key. Course records and hole records include record IDs, data versions, schema versions, source/confidence, sync status, remote IDs, invalidation fields, and timestamps.

Per-hole database-ready payloads include durable geometry:

- tee point
- green centre
- green shape and bounds
- fairway points
- route points
- frame anchors
- presentation owner and frame index reference

The exported DB payload avoids treating tile URLs as durable course data.

## Frame Index

Storage key: `gd_course_play_frame_index_v1`

The frame index records local captured/V19 render cache ownership by course and hole. It maps a pipeline record/version to the captured manifest key, generated timestamp, frame status, anchor pins, origin pixels, and tile metadata.

The frame index is cache-first. Its tile URL metadata is marked as not database-shareable by default.

## Sync Queue Stub

Storage key: `gd_course_play_sync_queue_v1`

The sync queue is local-only. It stores course-play upsert envelopes and marks local work as pending, but it makes no network calls and does not require auth, Supabase, or any database client.

Future database sync should consume `buildCoursePlaySyncEnvelope(courseId)` or `__gdExportCoursePlayPayload(courseId)` and then mark queue items synced only after a successful remote write.

## Debug Helpers

- `window.__gdDumpCoursePlayPersistence(courseId)`
- `window.__gdExportCoursePlayPayload(courseId)`
- `window.__gdDumpCoursePlayFrameIndex(courseId, holeNumber)`

These helpers are read-only unless the app explicitly calls the queue/save APIs.

## Not Yet Synced

This branch does not add remote database writes. It does not change payment, auth, Course Data shot logging, Practice systems, Bubble maths, Box maths, Green Wand, Shot End, or live fallback mode.

The future database branch should attach at the sync envelope layer, not the V19 tile-cache layer.
