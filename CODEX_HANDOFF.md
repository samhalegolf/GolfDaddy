# Codex Handoff - Clarity Caddie

Live app folder:

`/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current`

Serve/run:

`npm start`

Current browser target:

`http://localhost:5173/`

Primary file:

`index.html`

Important supporting scripts:

- `scripts/gd-launch-monitor-data.js`
- `scripts/gd-shot-cluster-analysis.js`
- `scripts/gd-shot-events.js`
- `scripts/gd-shot-outcomes.js`

## Current State

Clarity Caddie is a single-file local web app with supporting JS modules. It is not a framework app. Most UI, routing, GPS, Data Hub, Course Data, and Practice Data work lives in `index.html`.

Green Wand is locked. Read `GREEN_WAND_LOCK.md` before touching anything related to Wand sampling, probing, shells, contours, magnetic pull, green-centred tile crop, or Wand calibration. Do not tune Wand logic unless the user explicitly asks for Wand work.

The user wants to start the next chat by adding a feature to GPS.

## GPS Notes

GPS surface starts from:

- `enterGpsModule(opts={})` around `index.html:9400`
- Leaflet map setup around `index.html:3627`
- GPS mode switch HTML around `index.html:2359`
- right rail buttons around `index.html:2367`
- GPS play mode: `gdGpsPlayMode()` around `index.html:9200`
- two-tap/new-shot flow: `gdGpsNewShot()` around `index.html:5663`
- live GPS functions: `initGPS()`, `startWatch()`, `refreshGPS()`, `centerOnPlayer()` around `index.html:5768`
- main shot render: `renderShot()` around `index.html:5713`

Be careful: there are older shell helpers around `index.html:9400`, but the later stable module shell around `index.html:13182` controls much of the visible open/close behavior now:

- `openModulePanel(id,label,dock,opts)`
- `openLegacyPanel(id,label,dock,opts)`
- `cleanForModule()`, `cleanForHome()`, route memory helpers nearby

If a GPS feature affects navigation or visibility, inspect the shell lifecycle before adding new body-class visibility patches.

GPS DOM/chrome that should be preserved unless the feature needs it:

- top shell: Back, Home, GPS route label, Settings
- right rail order: flag, Green Wand, wind, GPS locate, map tools, scorecard, bag
- `#gpsModeSwitch` with `2 Tap` and `Live GPS`
- shot tile and map frame locking behavior

## Recent Completed Work

Course/Practice comparison cards were cleaned:

- Course/Practice source tabs hide offset values but still feed graph data.
- Tab colors match shot oval colors.
- Tolerance/consistency controls live inside the source tab on the right.
- Open buttons jump to the main Course Data or Practice Data page.

Comparison chart wiring was repaired:

- Comparison now uses live fit ovals rather than static raw extents where appropriate.
- Course Data chart and comparison course source use result-bubble fit ovals.
- Practice tolerance changes repaint the comparison/practice visuals.

Course Data admin was made useful for testing:

- Raw course data upload panel added under Course Admin.
- Upload accepts native ShotEvents JSON or CSV/JSON row data.
- Clear button removes course shot data.

Practice Data admin was expanded:

- Cluster hunter/tolerance controls moved under Practice Admin.
- Master cluster tolerance controls the focused practical subset.
- Full detailed launch monitor tuning remains under Admin.
- Added admin-only extraction checkpoint for upload/photo OCR:
  - text upload and reviewed photo OCR pause before import for admins
  - checkpoint lists extracted rows, fields, and missing-field flags
  - admin can Import these rows or Clear
  - checkpoint is hidden when empty

Fake/demo data was cleaned:

- Demo seeding functions are now no-op or return empty data.
- App-load cleanup removes demo-marked Course/Practice stores only.

## Practice Data Intake

Practice upload/photo paths:

- `gdHandleLaunchMonitorUpload(file)` around `index.html:3180`
- `gdHandleLaunchMonitorPhoto(file)` around `index.html:3283`
- `gdScanPracticePhotoCrop()` around `index.html:3297`
- `gdImportReviewedPracticeOcr()` around `index.html:3333`
- extraction checkpoint helpers around `index.html:3044`

The image extractor is OCR-based using Tesseract loaded from CDN. It is useful for clean tabular launch monitor screenshots, but it is not deeply intelligent yet. It relies heavily on readable headers and rows. The checkpoint exists so the user can compare extracted rows to the source image before importing.

## Course Data Intake

Course raw upload helpers are in `index.html` after the practice upload helpers:

- `gdPickRawCourseDataFile()`
- `gdHandleRawCourseDataUpload(file)`
- `gdBuildCourseStoreFromRawRows(rows,label)`
- `gdClearCourseShotData()`

Course data is exposed via `ClarityCaddieShotEvents` and the legacy-compatible `GolfDaddyShotEvents` global. Storage currently remains on `gd_shot_events_v1`.

Practice data is exposed via `ClarityCaddieLaunchMonitorData` and the legacy-compatible `GolfDaddyLaunchMonitorData` global. Storage currently remains on `gd_launch_monitor_data_v1`.

## Verification Already Done

- `node --check` on extracted inline scripts passes.
- Browser verified at `http://localhost:5173/`:
  - app loads
  - Shot Data opens
  - Practice Data opens
  - Practice Admin opens
  - extraction checkpoint is hidden when no pending extraction exists

Useful syntax check:

```bash
python3 - <<'PY'
from pathlib import Path
html=Path('index.html').read_text()
parts=[]
for part in html.split('<script')[1:]:
    if '>' not in part:
        continue
    body=part.split('>',1)[1]
    if '</script>' in body:
        parts.append(body.split('</script>',1)[0])
Path('/tmp/gd-index-scripts.js').write_text('\n'.join(parts))
PY
node --check /tmp/gd-index-scripts.js
```

## Working Rules For Next Chat

- Start by asking what GPS feature the user wants.
- Do not touch Green Wand internals unless specifically requested.
- Prefer changing existing GPS functions and DOM over adding duplicate overlay systems.
- After edits, reload `http://localhost:5173/?v=<cache-bust>` and verify in the in-app browser.
- Keep the local dev server on port `5173` unless the user says otherwise.
