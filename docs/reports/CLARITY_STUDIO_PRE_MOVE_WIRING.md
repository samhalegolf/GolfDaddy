# Clarity Studio — Pre-Move Wiring Report

Baseline snapshot taken before the `codex/clarity-studio-ownership-shell` branch touches anything. Captures the current Studio-only surface, its entry points, its exported globals, and every place the app-facing (non-Studio) build could be affected by a mistake. All line numbers are against `main` at commit `b0a3660`.

## 1. Studio-only files and DOM roots

Only two files live under `scripts/studio/` today:

| File | Lines | Purpose |
|---|---|---|
| `scripts/studio/gd-admin-course-db.js` | 2270 | Course Database admin panel + visual-engine tuning dock. Not IIFE-wrapped (deliberately — its own generated markup uses inline `onclick`/`oninput`/`onchange` handlers that must resolve as plain globals). |
| `scripts/studio/gd-course-play-debug.js` | 207 | Course-play pipeline debug renderers + floating "Course Play Monitor" HUD. Also not IIFE-wrapped. |

One more file is Studio-only but lives outside `scripts/studio/`:

| File | Purpose |
|---|---|
| `scripts/gd-course-mapping-debug.js` | Observational mapping-attempt diagnostics (`window.GDCourseMappingDebug`). Explicitly "never chooses the next mapping tool" per its own header. |
| `scripts/gd-course-visual-engine.js` (~3786 lines) | Full visual-authoring engine (masters, previews, presets, stitching, terrain/floodlight rendering, publishing, cloud sync). |
| `scripts/course-data/gd-conditions-debug.js` | Studio-only but currently dead code — defines `ClarityCaddieConditionsDebug`/`GolfDaddyConditionsDebug`, nothing calls either. |

DOM roots, all inside `index.html` and marked `data-gd-surface="studio"`:
- `#developerPanel` (`index.html:245`) — the whole Admin Settings sheet, including `#gdAdminCourseDbSummary` / `#gdAdminCourseDbList` / `#gdAdminCourseDbDetail` / `#gdAdminCourseDbSearch` (rendered into by `gdRenderAdminCourseDatabase`), `#gdCoursePlayDebugSummary` / `#gdCoursePlayDebugTable` / `#gdCoursePlayDebugTimeline` (rendered into by `gdRenderCoursePlayPipelineDebug`), and `#gdCourseMappingDebugPanel` (rendered into by `GDCourseMappingDebug.renderAdminPanel`).
- Home screen "Admin" button (`index.html:40`) and Settings → "Admin Settings" button (`index.html:236`).

There is **no separate `studio/index.html` source file** — `dist/studio/index.html` is generated purely by `scripts/clarity-deploy-build.js` stripping `data-gd-surface="app"` nodes from the single root `index.html`. No existing router or left-nav shell is specific to Studio; it inherits whatever shell/router the app uses.

## 2. Entry points into the old developer/admin panel

```
Home "Admin" button (index.html:40)
  onclick → gdOpenAdminSettings({fromHome:true}) → openDeveloperPanel({fromHome:true})
Settings → "Admin Settings" button (index.html:236)
  onclick → openDeveloperPanel()

gdOpenAdminSettings / "openDeveloper" alias
  scripts/gd-route-audit.js:8014 (alias), :8025 (exported to window)
  → wraps openDeveloperPanel

openDeveloperPanel (wrapped)
  scripts/gd-app-core.js:23122-23126
  → window.GDShell?.openModule?.('admin', …), pushes 'admin' shell route,
    then calls the original base openDeveloperPanel (captured as __gdOpenDeveloper)

openDeveloperPanel (base)
  scripts/gd-app-core.js:453
  function openDeveloperPanel(){
    if(!document.getElementById("developerPanel")) return false;   // <-- app-build no-op guard
    gdRenderPermissionsAdmin();
    renderDevPanel();
    gdRenderAdminCourseDatabase();
    gdRenderCoursePlayPipelineDebug();
    try{ window.GDCourseMappingDebug?.renderAdminPanel?.(); }catch(e){}
    openPanel("developerPanel");
  }
```

The early `return false` when `#developerPanel` is missing is what makes a stray `route="admin"` a safe no-op on the app build — this exact contract must not change.

## 3. Major functions owned by each Studio-only file

### `scripts/studio/gd-admin-course-db.js` (143 top-level functions)

| Bucket | Line range | Representative functions |
|---|---|---|
| Cloud DB loading / source status | 55-132 | `gdLoadAdminCourseDbCloud`, `gdMapCloudMapsToAdminStore`, `gdAdminCourseDbStore` |
| Course list / hole-row / summaries | 133-239 | `gdAdminCourseDbHoleRows`, `gdAdminCourseDbObjectTotals`, `gdAdminCourseDbSummaries` |
| Selected-course state, tabs, location, permissions | 240-398 | `gdAdminCourseDbOpen`, `gdAdminCourseLocationEdit/Remove`, `gdAdminCourseDbIsAdmin` |
| Delete / update actions | 402-487 | `gdAdminCourseDbDelete`, `gdAdminCourseDbUpdate` |
| Scorecard tab | 488-524 | `gdAdminCourseScorecardRows/Markup` |
| Visual preview ("phone" sandbox) | 525-882 | `gdAdminCoursePreviewSetHole`, `gdAdminCoursePreviewFrameFromObjects`, `gdAdminCoursePreviewMarkup` |
| Debug-tab markup / hydration / auto-build scheduling | 883-1074 | `gdAdminCourseDebugMarkup`, `gdAdminCourseVisualScheduleHydration/AutoBuild/Pipeline` |
| SVG utilities | 1075-1250 | `gdAdminCourseVisualInlineSvg`, `gdAdminCourseVisualParseTransform` |
| Stitch table + visual products | 1250-1385 | `gdAdminCourseVisualStitchView`, `gdAdminCourseVisualProducts` |
| Recipe library, control panel, tuning UI | 1387-1930 | `gdVisualRecipesSave/Load`, `gdAdminCourseVisualControls`, `gdAdminCourseVisualControlChanged/Committed` |
| Cloud job lookups + build/publish/reset/revert actions | 1487-1613, 1966-2121 | `gdAdminCourseBuildState`, `gdAdminCourseVisualPublish`, `gdAdminCourseVisualRecapture` |
| Visuals-tab diagnostics | 2123-2181 | lifecycle stage line, product cards, JSON dump |
| Top-level orchestrator | 2186-2261 | `gdRenderAdminCourseDatabase()` — summary banner, course table, per-tab detail dispatch |

Mapping diagnostics/attempts are **not** owned by this file — it only embeds `#gdCourseMappingDebugPanel` and forwards to `window.GDCourseMappingDebug?.renderAdminPanel?.()`.

### `scripts/studio/gd-course-play-debug.js` (15 top-level functions)

All 15 are renderers only — the underlying debug events are recorded by the app-side play pipeline (`scripts/gd-course-play-pipeline.js`) regardless of whether this file is loaded.

| Bucket | Functions |
|---|---|
| Gating/enablement | `gdCoursePlayMonitorAdminAllowed`, `gdCoursePlayDebugEnabled`, `gdSetCoursePlayDebug` |
| Markup/format helpers | `gdCoursePlayDebugFlag/Time/Metric`, `gdCoursePlayMonitorMetric/EventText` |
| Monitor HUD | `gdCoursePlayMonitorCollapsed`, `gdToggleCoursePlayMonitorCollapsed`, `gdEnsureCoursePlayMonitor`, `gdRenderCoursePlayMonitor` |
| Debug tab (table + timeline) | `gdRenderCoursePlayPipelineDebug`, `gdClearCoursePlayPipelineDebug` |

## 4. `window.*` exports used by inline handlers or other files

**`gd-admin-course-db.js`** (8, all at lines 2263-2270):

| Export | Callers |
|---|---|
| `gdRenderAdminCourseDatabase` | `index.html:247` inline `oninput`; `gd-app-core.js:422,453` (both DOM-guarded, no-op on app); `dev/boot-smoke.test.js:98,116,119` asserts presence matches studio target |
| `gdAdminCourseDbOpen` | Inline `onclick` in this file's own generated course-table rows (line 2218) |
| `gdAdminCourseDbShowGeometry` | Inline `onclick` in this file's own generated action rail (line 329) |
| `gdAdminCourseDbShowDebug` | Inline `onclick` in the action rail (line 332) |
| `gdAdminCourseLocationEdit` | Inline `onclick` in `gdAdminCourseLocationMarkup` (line 47); asserted by `dev/course-location-behavior.test.js:65` |
| `gdAdminCourseLocationRemove` | Same markup (line 47); asserted by `dev/course-location-behavior.test.js:66` |
| `gdAdminCourseDebugRefresh` | Inline `onclick` in `gdAdminCourseDebugMarkup` (line 884) |
| `gdToggleAdminCourseDbPayload` | No current caller found — the `#gdAdminCourseDbPayload` element it targets isn't emitted by any current markup; likely stale from an earlier UI iteration |

**`gd-course-play-debug.js`** (5, lines 198-202):

| Export | Callers |
|---|---|
| `gdRenderCoursePlayPipelineDebug` | `gd-app-core.js:423` (DOM-guarded); inline `onclick` at `gd-admin-course-db.js:884` |
| `gdSetCoursePlayDebug` | No callers found anywhere in the codebase — likely a dev-console-only toggle |
| `gdClearCoursePlayPipelineDebug` | Inline `onclick` at `gd-admin-course-db.js:884` |
| `gdRenderCoursePlayMonitor` | Self-referenced only, no external callers |
| `gdToggleCoursePlayMonitorCollapsed` | Inline `onclick` in its own `gdCoursePlayMonitorHeader` markup (line 88) |

`document.documentElement.dataset.gdTarget` is stamped at build time (`scripts/clarity-deploy-build.js:188`, asserted by `dev/surface-split.test.js:67-68`) but has **zero runtime readers** anywhere in the current source tree — this branch is the first thing to read it.

## 5. API endpoints used by current Studio controls

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/course-maps` | GET | Load live Supabase course-map database |
| `/api/course-maps` | POST `{action:"delete",...}` (Bearer) | Admin delete of a published course |
| `/api/course-visual-assets?path=...` | GET | Cloud frame index for preview; also used directly as `<img src>` |
| `/api/course-visual-jobs?courseId=...` | GET | Latest cloud visual job status (throttled) and live build-state poll |
| `/api/course-visual-jobs` | POST `{courseId,kind:"nudge"}` (Bearer) | Requeue a stalled build job |
| `/api/course-visual-jobs` | POST `{courseId,kind,recipe}` (Bearer) | Enqueue snapshot/export cloud job |

## 6. Storage keys and database sources

| Key | Use |
|---|---|
| `gd_course_play_pipeline_v1` | Local-cache fallback course-play pipeline store (read-only fallback) |
| `gd_course_play_frame_index_v1` | Local-cache fallback frame index |
| `gd_course_visual_recipes_v1` | Named local visual-recipe library |
| `gd_course_play_debug_enabled` | Course-play debug mode on/off |
| `gd_course_play_monitor_collapsed` | Floating monitor collapsed state |

No direct IndexedDB or Supabase client calls in either Studio file — all Supabase access is proxied through the HTTP endpoints above.

## 7. Functions called by app-surface code

Only two names cross the boundary, and both are behind DOM-existence guards that no-op on the app build:
- `gdRenderAdminCourseDatabase()` — called from `gd-app-core.js:422` (`renderDevPanel`, guarded by `#devTuningControls`) and `:453` (`openDeveloperPanel`, guarded by `#developerPanel`).
- `gdRenderCoursePlayPipelineDebug()` — called from `gd-app-core.js:423`, same guard as above.

Per `docs/APP_STUDIO_SPLIT.md` Phase 4, no app-surface file references any of the other 143+15 top-level functions directly by name.

## 8. Functions called only by Studio

Everything else — the remaining ~150 top-level functions across both files are reachable only from: (a) each other, (b) inline `onclick`/`oninput`/`onchange` handlers emitted by their own generated markup, or (c) the two window-level CustomEvent listeners and the 2200ms interval described in §10.

## 9. Load order assumptions

`index.html` loads scripts in this order (studio-marked ones only present in the studio build):
1. `scripts/gd-app-core.js` (shared, both surfaces) — defines `gdEscapeHTML`, `toast`, `gdSafeLocalSet`, `activePlayerProfile`, `gdGetAccountPermission`, and the base `openDeveloperPanel`
2. `scripts/studio/gd-admin-course-db.js` (`index.html:274`, studio-only)
3. `scripts/studio/gd-course-play-debug.js` (`index.html:275`, studio-only)
4. `scripts/gd-course-mapping-debug.js` (`index.html:306`, studio-only)
5. `scripts/gd-course-visual-engine.js` (studio-only) / `scripts/gd-course-visual-client.js` (app-only) — exactly one loads per surface
6. `scripts/gd-route-audit.js` (`index.html:351`, shared) — installs the global `pushState`/`popstate` bridge (`gdInstallBrowserRouteBridge`)

Neither Studio file is IIFE-wrapped, so all top-level `function` declarations are plain globals — order between (2) and (3) doesn't matter for correctness since cross-file calls only happen inside event handlers/renders, never at parse time. The two top-level `let` bindings (`gdAdminCourseDatabaseSelected`, `gdAdminCourseDatabaseTab`, lines 14-15 of `gd-admin-course-db.js`) must each be declared exactly once — redeclaring a `let` in a second `<script>` tag on the same page is a parse-time `SyntaxError`, not a silent overwrite.

## 10. Event listeners, timers, and delegated handlers

| Location | Type | Detail |
|---|---|---|
| `gd-admin-course-db.js:1750-1752` | 3× `document.addEventListener(..., true)` | Capture-phase delegated listeners for preset-rail clicks, slider input, and control commit (change). Guarded by `window.__gdAdminCourseVisualControlsBound` so they install exactly once. |
| `gd-admin-course-db.js:1551` | `setTimeout(...,5000)` in `gdAdminCourseBuildTimer` | Ticks the build progress bar while a cloud job is live |
| `gd-course-play-debug.js:205` | `window.addEventListener("gd-course-play-debug-event", ...)` | Fired by `gd-course-play-pipeline.js:108`. Re-renders admin DB + pipeline debug + mapping debug **only if `#developerPanel.open`**; always re-renders the floating monitor. |
| `gd-course-play-debug.js:206` | `window.addEventListener("gd-course-mapping-debug-updated", ...)` | Fired by `gd-course-mapping-debug.js:471`. Re-renders mapping-debug panel only if `#developerPanel.open`. |
| `gd-course-play-debug.js:207` | `setInterval(...,2200)`, never cleared | Re-renders admin DB + pipeline debug + mapping debug only if `#developerPanel.open`; always re-renders the floating monitor. |
| `gd-course-mapping-debug.js:1038-1039` | `window.addEventListener("gd-course-mapping-debug-updated", ...)` | Independent duplicate of the same `#developerPanel.open` gate, re-renders its own admin panel. |

All five of these listeners/timers gate live-refresh on `#developerPanel.open` — a Studio surface that shows Course Database or Mapping Diagnostics data anywhere other than inside `#developerPanel` will **not** get live pushed updates from these five sources. This is a known limitation carried forward, called out again in the comparison report.

## 11. What must not be touched (do-not-touch boundary, confirmed by file inspection, not by name pattern)

| System | File(s) |
|---|---|
| Course Picker | `scripts/inline/gd-course-picker-search-v2.js` |
| AutoMapper (on-device) | `scripts/gd-course-library-pin-lock.js` |
| Hole label resolution (in-round) | `scripts/gd-course-play-pipeline.js` (`HOLE_STATES`) |
| Manual green fallback (in-round) | `scripts/gd-app-core.js:16986-17099`, `scripts/gd-course-play-pipeline.js:869-953` |
| Active round state | `scripts/gd-shot-events.js` (`ROUND_KEY`) |
| GPS framed camera model | `scripts/gd-app-core.js:14601+` |
| On-course capture | `scripts/gd-course-play-pipeline.js` (`FRAME_INDEX_KEY`) |
| Practice Photo Scan | `scripts/gd-app-core.js:13733,13907`; `scripts/inline/gd-practice-import-action-bridge.js` |
| Practice Data Gate | `scripts/gd-native-practice-data.js`; parser core shared with server via `scripts/gd-practice-parser-core.js` |
| Pattern Finder | Lives inside `scripts/gd-app-core.js` / `scripts/gd-route-audit.js`, no standalone file |
| My Bubble | `scripts/gd-app-core.js:22199`; `scripts/gd-shot-snapshot.js`; `scripts/course-data/gd-course-data-comparison.js` |
| Course Data (admin/coach) | `scripts/course-data/gd-course-data-intake.js`, `gd-course-data-comparison.js`, `conditions-engine/*` — gated by `gdCourseDataCanManage()` (admin **or** coach), so it stays on the phone |

**Naming trap confirmed real**: `scripts/gd-app-core.js` carries no surface marker (loads on both builds) yet defines many `*Admin*`-named functions the app build still parses: `gdRenderAdminVisualSettings`, `openDeveloperPanel` (no-ops without `#developerPanel`), `gdRenderLaunchMonitorAdmin`, `gdRenderCourseDataAdminPanel`, `gdAdminCanManageAllUsers`. The gate (DOM existence / permission check) is the source of truth, not the identifier name.

## 12. Existing test contracts this branch must not break

- `dev/surface-split.test.js` — build-output contract (studio markers stripped correctly, `data-gd-target` stamped, exactly one visual engine per surface, `--app-only` prunes `scripts/studio/`).
- `dev/boot-smoke.test.js` — boots 3 surfaces headless, asserts `#developerPanel` presence, `window.gdRenderAdminCourseDatabase` presence, `window.GDCourseMappingDebug` absence on app, `window.openDeveloperPanel()` never throws.
- `dev/course-location-behavior.test.js` — pins the literal path `scripts/studio/gd-admin-course-db.js` and asserts exact substrings inside it (`gdAdminCourseLocationMarkup(selected,payload)`, `window.gdAdminCourseLocationEdit=...`, `window.gdAdminCourseLocationRemove=...`) plus a literal `index.html` script-tag string. This is the reason this branch does not physically relocate code out of that file (see the branch's scope-decision notes in the comparison report).
