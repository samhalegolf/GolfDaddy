# Clarity Studio — Post-Move Wiring Report

State of the Studio surface after the `codex/clarity-studio-ownership-shell` branch. Companion to `CLARITY_STUDIO_PRE_MOVE_WIRING.md` (baseline) and `CLARITY_STUDIO_WIRING_COMPARISON.md` (function-by-function diff).

## 1. What changed, in one paragraph

Nothing moved out of `scripts/studio/gd-admin-course-db.js`, `scripts/studio/gd-course-play-debug.js`, or `scripts/gd-course-mapping-debug.js` — all three are byte-for-byte unchanged (verified by `dev/studio-wiring.test.js`, which pins their exports and signatures). A new, additive Studio shell was built alongside them: a left-nav/breadcrumb/workspace UI, an ownership registry, an Info-tab wiring-diagram viewer, and five thin Courses page controllers that **reparent** the legacy Course Database DOM subtree into whichever new page is active, then call the same unmodified render functions against it. `/studio/` now boots directly into this shell; `#developerPanel` (the old Admin Settings sheet) is untouched and still works if opened directly.

## 2. New files

| File | Purpose |
|---|---|
| `scripts/studio/studio-registry.js` | Ownership data (id/label/function/owner/runtime/code/inputs/outputs/connections/keyFunctions) for every nav section. `window.GDStudioRegistry`. |
| `scripts/studio/studio-router.js` | In-memory route stack (current section + breadcrumb). No `history.pushState` — see §4. `window.GDStudioRouter`. |
| `scripts/studio/studio-shell.js` | Left nav, header, breadcrumb, tab strip, workspace mount. Activates only when `document.documentElement.dataset.gdTarget==="studio"`. |
| `scripts/studio/studio-shell.css` | Shell layout/theme, scoped under `#gdStudioShellRoot`. |
| `scripts/studio/studio-info-view.js` | Renders each section's Info tab + interactive wiring diagram (click-to-focus, Explore wiring, in-panel Back/Reset/Open-parent). `window.GDStudioInfoView`. |
| `scripts/studio/overview/overview-page.js` | Studio landing page. |
| `scripts/studio/courses/course-database/course-database-page.js` | Course Database page **and** the shared `window.GDStudioCourseDbHost.mount()` helper the other four Courses pages use. |
| `scripts/studio/courses/course-mapping/course-mapping-page.js` | Mapping Workspace (composition-only). |
| `scripts/studio/courses/course-visuals/course-visuals-page.js` | Course Visuals page. |
| `scripts/studio/courses/publishing/course-publishing-page.js` | Publishing page (documentation + redirect, not a live DOM host — see §3). |
| `scripts/studio/courses/mapping-diagnostics/mapping-diagnostics-page.js` | Mapping Diagnostics page. |
| `dev/studio-wiring.test.js` | Regression coverage for all of the above (14 checks). Wired into `.github/workflows/structural-smoke.yml`. |

All twelve are marked `data-gd-surface="studio"` in `index.html` and confirmed absent from the app build (`dev/studio-wiring.test.js`, `dev/surface-split.test.js`, and manual `grep` on `dist/index.html`).

## 3. How the new shell reaches old functionality: reparenting, not duplication

The original plan (see the branch's approved plan file) was to give `gdRenderAdminCourseDatabase()` an optional target-container parameter so a second, new container could reuse it safely. Implementing that surfaced a deeper problem: the function's own generated markup reads many **more** fixed ids via plain `document.getElementById` — the visual-tuning control ids (`#gdCourseVisualHueMin` etc.), the embedded `#gdCourseMappingDebugPanel`, the embedded `#gdCoursePlayDebugSummary/Table/Timeline` — none of which were parameterized. Parameterizing only the outer function would still collide the moment both `#developerPanel` and a Studio page rendered the same tab in the same session (e.g. right after a build/publish action, since ~30 internal call sites inside `gd-admin-course-db.js` call the bare zero-arg `gdRenderAdminCourseDatabase()`, which would silently repopulate whichever container is NOT currently active with the same ids).

The target-param edits were reverted (both files are unmodified — verify with `git diff scripts/studio/gd-admin-course-db.js scripts/gd-course-mapping-debug.js` against `main`, it is empty). Instead, `course-database-page.js` exports `window.GDStudioCourseDbHost.mount(containerEl, {tab})`, which:
1. Finds the single, real `#gdAdminDatabasePanel` DOM node (still physically inside `index.html`, still containing `#gdAdminCourseDbSearch/Summary/List/Detail`).
2. Moves it (not a clone — `appendChild` reparents) into the requesting page's container.
3. Optionally calls the existing global `gdAdminCourseDbSetTab(tab)` to switch tabs.
4. Starts a 3-second poll calling the existing global `gdRenderAdminCourseDatabase()` (no args) to keep it live, since the internal event-driven refresh (§5) doesn't know about the new shell.
5. Returns a cleanup function that clears the poll and moves the node back to its original parent (`#developerPanel`) — called automatically by `studio-shell.js` before switching sections or tabs.

Because there is only ever one instance of each id in the document — just relocated — there is no duplicate-id class of bug, and the legacy `#developerPanel` keeps working exactly as before if it's ever opened directly (nothing currently opens it while a Studio page also holds the node, since only one page can hold it at a time by construction).

Course Mapping, Course Visuals, and Mapping Diagnostics all call the same `GDStudioCourseDbHost.mount()` with different default tabs (`overview`, `overview` + jump buttons, `overview` + a jump button, respectively) — see `docs/reports/CLARITY_STUDIO_WIRING_COMPARISON.md` for why row-selection in the legacy table always resets to the Overview tab, and why jump buttons (not one-shot tab-setting) were required.

Publishing does **not** reparent — publish/build/reset/revert actions are buttons embedded inside the same Visuals tuning tab, not a separate legacy screen. Publishing's page is real but is documentation + a "Open Course Visuals" redirect, naming the six real action functions rather than fabricating an independent panel.

## 4. Router: in-memory only, not real browser history (documented deviation)

`scripts/gd-route-audit.js` already owns global `pushState`/`popstate` (`gdInstallBrowserRouteBridge`) and falls back to "go home" for any history state it doesn't recognize. A second router calling `pushState` without coordinating with that bridge would make the browser Back button inside Studio's nav unpredictably return to the app's Home screen. `studio-router.js` therefore keeps an in-memory route stack only — real deep-linkable `/studio/courses/...` URLs are a follow-up that needs explicit coordination with `gd-route-audit.js`, not something this branch silently dropped.

## 5. Known limitations carried forward (not introduced by this branch)

- Live refresh for the embedded Mapping Diagnostics / course-play debug sub-panels is driven by 2 `window` CustomEvent listeners + an uncleared 2200ms interval in `gd-course-play-debug.js`, and a third listener in `gd-course-mapping-debug.js` — all three gate on `#developerPanel.open`. Since a Studio page is not `#developerPanel`, these do not fire; the new shell's own 3-second poll (§3) covers the outer Course Database render but not these sub-panels' independent event-driven schedule. Documented in each affected page file's header comment and in the registry's `mapping-diagnostics` record `warnings`.
- The full visual-tuning tab (`gdAdminCourseVisualMarkup` — recipe controls + build/publish actions) was already fully implemented and dispatch-ready before this branch, but had **no reachable button** in the legacy action rail (only "Visual Engine," which opens the lighter preview sandbox). This branch is the first place it's reachable by clicking — a real, positive side effect of the reorganization, not a regression.
- Course table row clicks hardcode `onclick="...gdAdminCourseDbOpen(id,'overview')"` in their generated markup, so selecting any course always resets the active tab to Overview. This is why Course Mapping/Visuals/Mapping Diagnostics use persistent jump buttons rather than a one-shot tab-set on page mount (an earlier draft of `mapping-diagnostics-page.js` had exactly this bug — caught and fixed before this branch's first commit).

## 6. A real, unrelated bug found and fixed

`scripts/clarity-deploy-build.js`'s `--app-only` prune (used by `npm run build:app` / `npx cap sync`) only ever checked one directory level for emptiness after removing studio-only files — correct while `scripts/studio/` was flat, but this branch's nested `scripts/studio/courses/<subsystem>/` tree left `scripts/studio/courses/` (and, depending on Set iteration order, `scripts/studio/` itself) behind as empty directories that would still ride into the native app bundle via `cap sync`. Fixed by walking each pruned file's directory upward, removing directories as long as they're empty, until hitting a non-empty one or `dist/`. Caught by `dev/surface-split.test.js`'s existing `--app-only` test, not a new test — that test already covered exactly this contract, it just hadn't needed to exercise nested directories before.
