# Course Data Landing Handover

Updated: 2026-06-06 NZST

## Goal

Connect the Course Data collection flow to the Course Data landing surface so an on-course shot event can be followed from capture, to pairing, to chart/library visibility.

Do not treat this as GPS remapping work. The live deploy is the better GPS baseline; this handover is about the data pipe and landing UI after a shot/event has been collected.

## Current Shape

Course data is stored in `gd_shot_events_v1`.

Primary source module:

- `scripts/gd-shot-events.js`

Main arrays:

- `ballEvents`: raw/merged position events.
- `plannedShots`: shot intentions generated from current context.
- `outcomes`: paired results used by cluster/landing analysis.

Important exported API:

- `GolfDaddyShotEvents.recordBallPosition`
- `GolfDaddyShotEvents.recordPlannedShot`
- `GolfDaddyShotEvents.recordShot`
- `GolfDaddyShotEvents.pairPendingShots`
- `GolfDaddyShotEvents.listBallEvents`
- `GolfDaddyShotEvents.listPlannedShots`
- `GolfDaddyShotEvents.listOutcomes`
- `GolfDaddyShotEvents.getScopedStore`

## UI Anchors

The Course Data landing lives in `index.html` and is currently rendered through:

- `gdCourseDataLandingCounts`
- `gdRenderCourseDataLanding`
- `gdCourseLibraryClubTabsHTML`
- `gdCourseLibraryShellHTML`
- `gdRenderCourseDataSurfaceFallback`
- `gdCourseDataSurfaceCounts`
- `gdCourseDataSurfaceSvg`
- `openCourseData`
- `renderStats`

The comparison surface also depends on the Course Data library shape:

- `gdCompareCourseCompact`
- `gdCompareSourceTab`
- `gdRenderDataHubCards`
- `gdCompareSvg`
- `gdPaintCompareVisual`

Keep the shared dropdown/library UI because Practice Data now uses the same interaction pattern.

## Known Gap

The Course Data landing can show counts from `plannedShots`, `outcomes`, and `ballEvents`, but the collection flow needs a clearer guarantee that a newly captured course shot triggers each downstream refresh:

- store write to `gd_shot_events_v1`
- `pairPendingShots`
- cluster analysis refresh
- `gdRenderCourseDataLanding`
- `gdCourseDataSurfaceSvg`
- comparison repaint, if Comparison is open

The risk is not storage itself; it is that collection can succeed while the landing surface still reads like "No data yet" or fails to show the newly paired row until another route/render happens.

## Suggested Next Pass

1. Trace every collection entrypoint that can create a course event or shot.
   Start with `gdRecordShotEvent`, `gdRecordShotEventPoint`, and the `GolfDaddyShotEvents` calls from GPS/manual play.

2. Add one shared "course data changed" refresh path.
   It should call `pairPendingShots`, then refresh `renderStats`, `gdRenderCourseDataSurfaceFallback`, `renderDataHubStatus`, and `renderCompareData` when those surfaces exist.

3. Make the landing show collection stage, not just final paired rows.
   Suggested states:
   - raw ball event collected
   - planned shot waiting for result
   - paired course shot ready
   - filtered out by cluster settings

4. Verify the admin/raw upload path uses the same refresh path.
   The upload controls are under `gdRenderCourseDataUploadHTML` and `gdRenderCourseDataAdminPanel`.

5. Keep comparison visual behaviour aligned with Practice Data.
   Course points stay blue, Practice points stay green, and the source cards/dropdowns remain the shared shell.

## Local Checks

After changes, run:

```bash
node -e 'const fs=require("fs"); const html=fs.readFileSync("index.html","utf8"); const scripts=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]); for (let i=0;i<scripts.length;i++){ new Function(scripts[i]); } console.log(`parsed ${scripts.length} inline scripts`);'
```

```bash
git diff --check -- index.html scripts/gd-shot-events.js scripts/gd-shot-outcomes.js
```

Visual routes to check:

- `http://localhost:5173/?codex_bust=course-data-landing`
- Course Data page after recording one event.
- Course Data page after pairing a shot.
- Comparison page with Course Library open.
- Practice Data and Comparison, to ensure shared library UI did not regress.
