# Wand Live Dependency And Startup Audit

Date: 2026-07-19
Branch: `structural-rebuild`
Baseline HEAD: `a90ab15e0e99bc6ee88f8a5212370ae0b5c80219`

## Stop-Gate Baseline

- `git status --short`: clean before edits.
- `git branch --show-current`: `structural-rebuild`.
- `git fetch origin`: completed.
- Local HEAD and `origin/structural-rebuild`: both `a90ab15e0e99bc6ee88f8a5212370ae0b5c80219`.
- `npm run test:boot`: passed.
- `node dev/green-shape-engine-owner.test.js`: passed.
- `node dev/green-shape-engine-behavior.test.js`: passed.
- `node dev/automapper-green-refinement-owner.test.js`: passed.
- `node dev/automapper-green-refinement-behavior.test.js`: passed.

## Current Loaded Wand Inventory

Directly loaded Wand/engine JavaScript:

- `scripts/gd-green-shape-engine.js`
- `scripts/inline/gd-wand-belt-layers-v1.js`
- `scripts/inline/gd-wand-flow-layers-v1.js`

Directly loaded retained Wand CSS after this audit:

- `styles/inline/gd-wand-root-cause-clean-css-v1.css`
- `styles/inline/gd-wand-robust-known-good-css-v1.css`
- `styles/inline/gd-wand-compact-flow-css-v1.css`
- `styles/inline/gd-wand-floating-mapper-css-v1.css`

Former individual Wand patch files such as `gd-wand-diagnostics-v1.js`, `gd-wand-compact-flow-v1.js`, `gd-wand-robust-known-good-flow-v1.js`, `gd-wand-floating-mapper-v1.js`, `gd-gps-polish-wand-layer-v1.js`, and `gd-inline-gps-wand-active-chrome-sync-v1.js` no longer exist as separate files. Their surviving sections were previously merged into the belt/flow layers.

## Live Dependency Graph

`scripts/gd-green-shape-engine.js` is live and retained. It exports `window.GolfDaddyGreenWandEngine`, `window.ClarityCaddieGreenWandEngine`, and `window.GDGreenShapeEngine`. The current live readers are standalone `scanGreen()` in `scripts/gd-app-core.js` and AutoMapper's constrained refinement adapter in `scripts/gd-course-library-pin-lock.js`.

`scripts/gd-course-library-pin-lock.js` is live and retained. Its AutoMapper path calls `GDGreenShapeEngine.detect()` through `automapperRunGreenShapeRefinement()`, validates the result, records mapper diagnostics, and delegates accepted refined polygons to the existing save path. It also still contains standalone Wand fallback wrappers around `acceptGreenWand`, `importGreenWandResult`, `rejectGreenWand`, and `closeWandPanel`; those wrappers prove the larger standalone Wand surface is still inbound from mapper fallback.

`scripts/gd-app-core.js` still owns the standalone Wand adapter/shell: `tryBuildMapCanvas`, green-centred tile crop helpers, pixel-to-map conversion, scale lock, `scanGreen`, `runGreenWandScan`, `acceptGreenWand`, `importGreenWandResult`, `rejectGreenWand`, and `openGpsWand` hotfix code. These are not deleted in this commit because the mapper fallback and shell buttons still call them.

`scripts/inline/gd-wand-belt-layers-v1.js` is partly live. The overlay-clean, robust-calibration, reject, and chrome-sync sections wrap current standalone Wand globals and mutate live DOM/body state. The diagnostics and sample-truth sections were provably dead because they removed their own DOM nodes, assigned no-op stubs, and returned before their UI builders.

`scripts/inline/gd-wand-flow-layers-v1.js` is live standalone Wand UI orchestration. It replaces `openGpsWand`, installs compact accept/exit handlers, exposes `window.gdCompactWandOpen`, installs a floating panel observer/drag listeners, and toggles `gdWandLayerActive`.

Other inbound standalone Wand references:

- `scripts/inline/gd-brand-icon-render.js`: rail button handler calls `openGpsWand()`.
- `scripts/inline/gd-auth-gate-v1.js`: auth guard wraps `openGpsWand`.
- `scripts/gd-route-audit.js`: `openWandStable()` and `dockGreen` interception still route to the Wand opener.
- `scripts/inline/gd-gps-play-flow-layers-v1.js` and `scripts/inline/gd-gps-play-runtime-owner-v1.js`: close/clear Wand state during GPS transitions.

## Startup Cost And Side Effects

Static startup profile after this audit:

| File | Lines | Listeners | Timers | MutationObservers | Storage refs | Window assignments |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `scripts/gd-green-shape-engine.js` | 735 | 0 | 0 | 0 | 0 | 3 |
| `scripts/inline/gd-wand-belt-layers-v1.js` | 322 | 6 | 12 | 0 | 2 | 15 |
| `scripts/inline/gd-wand-flow-layers-v1.js` | 228 | 10 | 13 | 2 | 0 | 9 |
| `scripts/gd-app-core.js` | 26,323 | 52 | 47 | 2 | 81 | 274 |
| `scripts/gd-course-library-pin-lock.js` | 6,458 | 42 | 47 | 2 | 16 | 132 |

The engine itself is startup-clean: no DOM listeners, timers, observers, or storage reads at load. Startup cost and side effects are concentrated in the remaining standalone Wand UI layers plus core/pin-lock compatibility wrappers.

## Deletion Made In This Commit

Deleted as proven dead:

- Unreachable diagnostics UI body from `scripts/inline/gd-wand-belt-layers-v1.js`, while preserving `collectWandDiagnostics()` / `showWandDiagnostics()` no-op compatibility stubs.
- Unreachable sample-truth UI body from `scripts/inline/gd-wand-belt-layers-v1.js`, while preserving `gdShowWandSampleTruth()` no-op compatibility stub.
- Dead CSS loads and files for `gd-wand-diag-style.css` and `gd-wand-sample-truth-style-v1.css`.
- Dead `#gdWandDiagPanel` selector in `gd-clean-diag-only-fix-v1.css`.

## Not Deleted

No standalone Wand opener, panel, core scan adapter, mapper fallback wrapper, or AutoMapper/Green Shape Engine code was deleted. Those paths still have inbound references and need a separate retirement commit after the mapper fallback surface is replaced or explicitly removed.
