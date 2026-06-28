# Practice Data Import Native Workflow Report

## Audit

- Existing Practice Data UI lives in `#practiceDataPanel` with an Import expander for text/photo intake, OCR review, stored evidence, projection controls, recommendation output, and an admin toggle.
- Existing launch monitor intake and hidden Practice Bubble analysis live in `scripts/gd-launch-monitor-data.js`, backed by `gd_launch_monitor_data_v1`.
- Existing Course Shot Data cluster analysis lives in `scripts/gd-shot-cluster-analysis.js`, backed by ShotEvents stores, and is separate from Practice Data.
- Existing Practice Data import paths include file upload, photo upload/camera scan, OCR review, extracted scan checkpoint import, and the Admin Settings Launch Monitor Intake Test.
- Existing Practice Data records in `gd_launch_monitor_data_v1` are capture/session/shot/reject records shaped for launch-monitor analysis and Cluster Finder/Bubble recommendations.
- Existing Cluster Finder input for Practice Data is the accepted shot shape produced by `GolfDaddyLaunchMonitorData.analyze()`, including club, carry/expected distance, lateral/offline metres, normalized degrees, delivery metrics, confidence, and source metadata.
- Existing storage keys found for Practice Data include `gd_launch_monitor_data_v1`, `gd_practice_tolerance_master_pct`, and `gd_practice_evidence_active_club`.
- Direct coupling risk exists because the current upload/photo import path can flow directly into `GolfDaddyLaunchMonitorData.importCapture()` and then into hidden cluster/recommendation rendering.

## New Native Data Shape

The new native store uses `gd_native_practice_shot_data_v1` and keeps imported rows separate from cluster logic. Native shot rows include:

- `shotId`, `sessionId`, `playerId`, `playerName`, `accountId`
- `club`, `shotNumber`
- `ballSpeed`, `clubSpeed`, `launchAngle`, `spin`, `carryDistance`, `totalDistance`, `offlineDistance`
- `side`, `faceAngle`, `pathAngle`, `faceToPath`, `startDirection`, `curve`, `targetLine`
- `rawSource`, `sourceType`, `importBatchId`
- `status`, `schemaVersion`, `createdAt`, `updatedAt`
- `errors`, `warnings`, `unknownFields`

Metric distances are stored in metres where applicable.

## Storage

The native local store is:

- `gd_native_practice_shot_data_v1`

It stores import batches, sessions, native shot rows, validation status, and source metadata. It does not overwrite `gd_launch_monitor_data_v1`.

## Parser Limits

Initial parsing supports pasted CSV or simple delimited text with headers. It recognizes common fields such as club, carry, total, offline, face, path, face-to-path, start direction, launch, spin, ball speed, and club speed. Unknown fields are preserved on each row and surfaced as warnings.

## Practice Shot Data Gate

The gate adapter is `GDPracticeDataImport.buildPracticeGateInput(sessionId, opts)`. It reads native rows and returns a gate-ready summary without running Cluster Finder. It filters valid native rows, reports rejects, and maps the exact fields Cluster Finder can use later:

- `carryM`, `totalM`, `expectedM`, `lateralM`, `normalizedDeg`
- `delivery.faceAngleDeg`, `delivery.pathAngleDeg`, `delivery.faceToPathDeg`, `delivery.startDirectionDeg`
- player/session/import identity and raw source metadata

The adapter does not call `GolfDaddyLaunchMonitorData.analyze()` and does not write to `gd_launch_monitor_data_v1`.

## UI Location

The review lane is inside Practice Data as `Native Practice Data Import`. It supports paste -> parse -> preview -> save valid rows -> reload saved native rows.

## Intentional Non-Changes

- No Practice Bubble is generated automatically.
- No My Bubble adoption/update path is added.
- No Cluster Finder maths are changed.
- No GPS Play, Course Play Pipeline, AutoMapper, Course Data, Green Wand, Shot End, Live Bubble, payment, or auth code is touched.
