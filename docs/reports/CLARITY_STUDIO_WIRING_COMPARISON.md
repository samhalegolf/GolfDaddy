# Clarity Studio — Wiring Comparison (Old vs. New)

Function-by-function diff for the `codex/clarity-studio-ownership-shell` branch. See `CLARITY_STUDIO_PRE_MOVE_WIRING.md` for the baseline and `CLARITY_STUDIO_POST_MOVE_WIRING.md` for the new architecture.

**Headline finding**: nothing physically moved. `gd-admin-course-db.js`, `gd-course-play-debug.js`, and `gd-course-mapping-debug.js` are unchanged (`git diff main -- scripts/studio/gd-admin-course-db.js scripts/studio/gd-course-play-debug.js scripts/gd-course-mapping-debug.js` is empty). The new Studio shell reaches their functionality by **reparenting** the one real DOM subtree they render into, not by duplicating or relocating code. Every row below is therefore "Preserved exactly" for the function itself, with a "Wrapped by new owner" note where the new shell changes *how* that function's output becomes reachable.

## Every moved `window.*` export

None were moved. All 13 (`gd-admin-course-db.js`: 8, `gd-course-play-debug.js`: 5) are confirmed present, unchanged, by `dev/studio-wiring.test.js`.

| Function | Old file | New file | Old callers | New callers | Runtime before | Runtime after | DOM owner before | DOM owner after | Status |
|---|---|---|---|---|---|---|---|---|---|
| `gdRenderAdminCourseDatabase` | gd-admin-course-db.js | *(unchanged)* | `#developerPanel` inline `oninput`; `gd-app-core.js:422,453` (DOM-guarded) | Same, **plus** `GDStudioCourseDbHost.mount()`'s initial call and 3s poll | studio | studio | `#gdAdminCourseDbSummary/List/Detail` (always, singular) | Same ids, now movable — physically inside `#developerPanel` OR inside whichever Studio Courses page last mounted them | Wrapped by new owner |
| `gdAdminCourseDbOpen` | gd-admin-course-db.js | *(unchanged)* | Inline `onclick` in its own generated table rows | Same (unchanged markup) | studio | studio | n/a | n/a | Preserved exactly |
| `gdAdminCourseDbShowGeometry` | gd-admin-course-db.js | *(unchanged)* | Inline `onclick` in its own action rail | Same | studio | studio | n/a | n/a | Preserved exactly |
| `gdAdminCourseDbShowDebug` | gd-admin-course-db.js | *(unchanged)* | Inline `onclick` in its own action rail; now also `mapping-diagnostics-page.js`'s jump button calls the internal `gdAdminCourseDbSetTab("debug")` (same effect, different entry point) | Same, plus the jump button | studio | studio | n/a | n/a | Preserved exactly |
| `gdAdminCourseLocationEdit` | gd-admin-course-db.js | *(unchanged)* | Inline `onclick`; pinned by `dev/course-location-behavior.test.js` | Same | studio | studio | n/a | n/a | Preserved exactly |
| `gdAdminCourseLocationRemove` | gd-admin-course-db.js | *(unchanged)* | Inline `onclick`; pinned by `dev/course-location-behavior.test.js` | Same | studio | studio | n/a | n/a | Preserved exactly |
| `gdAdminCourseDebugRefresh` | gd-admin-course-db.js | *(unchanged)* | Inline `onclick` in `gdAdminCourseDebugMarkup` | Same | studio | studio | n/a | n/a | Preserved exactly |
| `gdToggleAdminCourseDbPayload` | gd-admin-course-db.js | *(unchanged)* | None found (pre-existing dead code, not introduced or removed by this branch) | None found | studio | studio | `#gdAdminCourseDbPayload` (not emitted by any current markup) | Same | Needs follow-up (pre-existing, unrelated to this branch — confirm dead and remove in a future branch, or find the missing caller) |
| `gdRenderCoursePlayPipelineDebug` | gd-course-play-debug.js | *(unchanged)* | `gd-app-core.js:423` (DOM-guarded); inline `onclick` in `gd-admin-course-db.js`'s debug markup | Same | studio | studio | `#gdCoursePlayDebugSummary/Table/Timeline` (emitted inside the reparented `detail` container) | Same ids, travel with the reparented container | Wrapped by new owner |
| `gdSetCoursePlayDebug` | gd-course-play-debug.js | *(unchanged)* | None found | None found | studio | studio | n/a | n/a | Preserved exactly |
| `gdClearCoursePlayPipelineDebug` | gd-course-play-debug.js | *(unchanged)* | Inline `onclick` in `gd-admin-course-db.js`'s debug markup | Same | studio | studio | n/a | n/a | Preserved exactly |
| `gdRenderCoursePlayMonitor` | gd-course-play-debug.js | *(unchanged)* | Self-referenced only | Same | studio | studio | `#gdCoursePlayMonitor` (created on demand on `document.body`) | Same — not inside the reparented subtree, unaffected by any Courses page | Preserved exactly |
| `gdToggleCoursePlayMonitorCollapsed` | gd-course-play-debug.js | *(unchanged)* | Inline `onclick` in its own monitor header markup | Same | studio | studio | n/a | n/a | Preserved exactly |
| `GDCourseMappingDebug.renderAdminPanel` | gd-course-mapping-debug.js | *(unchanged)* | `gd-app-core.js:453` (DOM-guarded); `gd-course-play-debug.js`'s listeners/interval; its own DOMContentLoaded/setTimeout self-render | Same | studio | studio | `#gdCourseMappingDebugPanel` (emitted inside the reparented `detail` container) | Same id, travels with the reparented container | Wrapped by new owner |

## Course database actions (delete / update / scorecard / geometry rendering)

All of `gdAdminCourseDbDelete`, `gdAdminCourseDbUpdate`, `gdAdminCourseScorecardRows/Markup`, and the inline geometry-tab rendering inside `gdRenderAdminCourseDatabase` are unchanged, unmoved, and now reachable both from `#developerPanel` (if opened) and from the Course Database Studio page (via reparenting). Status: **Preserved exactly**, reachable through an additional entry point.

## Course location controls

`gdAdminCourseLocationMarkup/Edit/Remove/Payload/Summary` remain physically inside `gd-admin-course-db.js`, pinned there by `dev/course-location-behavior.test.js`. The Course Mapping Studio page surfaces them by reparenting the same panel to the Overview tab (where this markup renders) rather than relocating the functions. Status: **Wrapped by new owner** (Course Mapping page), not moved.

## Visual preview / recipe / tuning controls

`gdAdminCourseVisualControls` and everything it depends on (recipe library, control-change/commit handlers, the three document-level capture-phase listeners guarded by `window.__gdAdminCourseVisualControlsBound`) are unchanged. New finding: this tab (`gdAdminCourseDatabaseTab==="visuals"`) was already fully wired in `gdRenderAdminCourseDatabase`'s dispatch but had **no reachable button** in the legacy action rail — only `gdAdminCourseDbShowPreview` ("Visual Engine," the lighter phone-sandbox tab) was clickable. The Course Visuals Studio page's "Open Visual Engine tuning" button is the first working entry point to it. Status: **Preserved exactly** (zero code changes) + **newly reachable** (a real functional improvement, not a replacement).

## Cloud visual lookup / publish / build / reset / revert actions

`gdAdminCourseBuildState/Watch/Progress`, `gdAdminCourseCloudLatestJob`, `gdAdminCourseVisualBuildBasic/BuildPreview/Recapture/Publish/ResetPublished/Revert` are unchanged. The Publishing Studio page does not reparent any DOM (see `CLARITY_STUDIO_POST_MOVE_WIRING.md` §3) — it documents these six functions by name and links to Course Visuals, where the same buttons the legacy code already emits are reachable via reparenting. Status: **Preserved exactly**, documented rather than duplicated.

## Mapping diagnostics

`GDCourseMappingDebug`'s public API (`getRecentRuns`, `getRun`, `renderAdminPanel`, etc.) and `gd-course-play-debug.js`'s pipeline-debug renderers are unchanged. The Mapping Diagnostics Studio page reparents the panel and jumps to the Debug tab via a persistent button (not a one-shot call — see `CLARITY_STUDIO_POST_MOVE_WIRING.md` §5 for why a one-shot version was wrong and was caught before commit). Status: **Wrapped by new owner**.

## Timers and event listeners

| Listener/timer | Old file | Change |
|---|---|---|
| 3× `document.addEventListener` (capture-phase, visual controls) | gd-admin-course-db.js | Unchanged — `window.__gdAdminCourseVisualControlsBound` guard still installs them exactly once |
| `gd-course-play-debug-event` / `gd-course-mapping-debug-updated` window listeners | gd-course-play-debug.js, gd-course-mapping-debug.js | Unchanged — still gated on `#developerPanel.open`, so they do not fire while a Studio page (not `#developerPanel`) is open. See known limitation in the post-move report. |
| 2200ms uncleared `setInterval` | gd-course-play-debug.js | Unchanged, same gate |
| New: 3000ms `setInterval` per mounted Courses page | course-database-page.js (`GDStudioCourseDbHost.mount`) | New — cleared on page/section switch via the shell's cleanup hook (`studio-shell.js`'s `activeCleanup`) |

## Studio panel opening and routing

| Item | Old | New | Status |
|---|---|---|---|
| Home "Admin" button, Settings "Admin Settings" button | Open `#developerPanel` via `openDeveloperPanel()` | Unchanged — still open `#developerPanel` | Preserved exactly (task explicitly allows this to be temporary) |
| `/studio/` root | No dedicated shell; inherited whatever the app's default route was | Boots directly into the new Studio shell (`studio-shell.js` mounts on `dataset.gdTarget==="studio"`) | Intentionally replaced (this is the branch's purpose) |
| Browser Back/Forward inside Studio | N/A (no Studio-specific routing existed) | In-memory route stack only, no `history.pushState` — see post-move report §4 | Needs follow-up (deliberately deferred, not silently dropped) |

## Calls from non-Studio (app-surface) scripts

Unchanged: only `gdRenderAdminCourseDatabase()` and `gdRenderCoursePlayPipelineDebug()` are called from `gd-app-core.js`, both behind `#developerPanel`/`#devTuningControls` existence guards, both no-ops on the app build. No new app-surface call sites were added or removed by this branch (`dev/studio-wiring.test.js` confirms none of the new Studio files are referenced from the app build).

## Build tooling

| Item | Old | New | Status |
|---|---|---|---|
| `scripts/clarity-deploy-build.js` `--app-only` empty-directory prune | Removed a directory if it became empty, checked one level deep | Walks each pruned file's directory upward, removing empty directories until a non-empty one or `dist/` | Intentionally replaced (bug fix required by this branch's nested `scripts/studio/courses/.../` tree — see post-move report §6) |
