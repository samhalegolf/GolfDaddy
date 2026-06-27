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

