# Course Play Pipeline Implementation Report

## Summary

This branch adds a new Course Play Pipeline owner at `window.GDCoursePlayPipeline`.

The pipeline is intentionally separate from AutoMapper and GPS Play:

- AutoMapper / course library remains the geometry producer.
- Course Play Pipeline owns normalized playable per-hole data and readiness state.
- GPS Play reads Course Play Pipeline state before falling back to older mapped-hole reads.
- Live Leaflet exposure is not introduced as a fallback state.

## Checkpoints

1. `Add Course Play Pipeline store`
   - Added `scripts/gd-course-play-pipeline.js`.
   - Added local storage under `gd_course_play_pipeline_v1`.
   - Added course and hole states, per-hole data shape, and future sync fields.

2. `Connect mapped geometry to Course Play Pipeline`
   - Added course-library adapter functions.
   - Added whole-course ingestion from mapped hole data.
   - Wrapped exported AutoMapper/course-open functions to ingest data without changing mapper internals.

3. `Read Course Play Pipeline from GPS Play`
   - Added active-hole read adapter.
   - V19 captured presentation now reads pipeline hole state/mapped data first.
   - Missing-frame decisions can use pipeline states for loading or unavailable/remap.

4. `Stabilise Course Play Pipeline handoff`
   - Added a visible preparing state for pipeline handoff.
   - Course selection and hole navigation mark pipeline preparation.
   - Existing GPS first-paint suppression is reused while pipeline is preparing.

## Current Behavior

- Course selection prepares a pipeline record and ingests mapped course-library data when available.
- Hole navigation requests active-hole pipeline data before continuing the existing GPS Play flow.
- Preparing and unavailable states remain visible states, not silent live-map fallback.
- Existing captured-frame presentation remains the final presentation owner.

## Known Limitations

- This does not implement database sync yet.
- This does not rewrite AutoMapper or captured-frame generation.
- If captured manifests are absent, the existing captured-frame path may still show loading/unavailable rather than a playable captured frame.
- Manual browser QA is still required on the Netlify deploy preview for Maungakiekie hole-to-hole transitions, Set Start Point, bubble drag/release, and GPS refresh.
