# Structural Rebuild Plan

Branch: `structural-rebuild`. Written 2026-07-19 after the flagTool boot-crash incident.

## Where the codebase is

82 scripts are loaded by `index.html` (~73,000 lines total). `gd-app-core.js` is 27,671 lines — 38% of everything — and runs DOM wiring at its top level, so a single missing element aborts thousands of lines of unrelated initialization. All 82 scripts share one global lexical scope in a required load order; state declared in one file is read by files loaded later (e.g. `wandMode`, `placingPin`). Roughly 30 of the loaded files are patch layers (`-fix-v1`, `-rescue-v1`, `-patch-*`, `-stabilizer-v1`) that wrap or monkey-patch behavior owned elsewhere.

The split into external files worked for the HTML (index.html is 470 lines) but preserved the patch archaeology instead of removing it.

## Rules (apply to every commit on this branch and after merge)

1. `npm run test:boot` must pass before every commit. It boots the real page headless and fails on any uncaught exception plus two end-of-load canaries. This test caught the flagTool crash retroactively with exact stack traces.
2. Deleting something means deleting it completely: the file, its `<script>`/`<link>` tag, its CSS, and every reference — then boot test + grep to prove it. No hiding, no suppressing.
3. One owner per surface. A bug in a feature is fixed inside its owner file, never by adding a new layer on top.
4. Small commits, each independently boot-tested. No mixed feature+cleanup commits.
5. Respect the locked baseline in `package.json` (`codex.doNotModify`): the Green Wand sandbox engine, tile-crop sampling, and probe/ridge/magnetic shell logic move but do not change.

## Target module map (owners)

Already clean, keep as-is:
- Platform: `gd-namespace`, `clarity-store`, `clarity-session`, `clarity-cloud-sync`, `clarity-supabase-auth`, `clarity-router`, `clarity-permissions`, `clarity-email`, `clarity-backup`, `clarity-support`
- Payments: `clarity-payments`
- Rail/branding: `gd-icon-assets`, `gd-brand-icon-render` (rebuilt this weekend; owns rail lifecycle)

Consolidate into single owners:
- **Auth/account shell** ← `gd-auth-account-shell` + `gd-auth-gate-v1` + `gd-auth-reset-route-bootstrap` + `gd-inline-profile-route-hardening-v1`
- **GPS play runtime** ← `gd-gps-play-runtime-owner-v1` + `gd-gps-state-stabilizer-v1` + `gd-gps-auto-session-v1` + `gd-gps-layout-rig-v1` + `gd-gps-play-camera-tilt-v1` + `gd-inline-gps-viewport-lock-v1` + `gd-gps-location-set-lock-v1` + `gd-gps-mapped-camera-and-green-focus-v1` + `gd-gps-scorecard-owner-v1` + `gd-gps-new-shot-final-wire-v1` + `gd-gps-request-button-fix-v1` + `gd-gps-mapped-entry-guard-v1` + the nine `gd-inline-clarity-caddie-*` patches + `gd-final-tool-screen-isolation-v1` + `gd-play-flow-next-hole-v1`
- **Wand** ← `gd-wand-robust-known-good-flow-v1` + `gd-wand-sample-truth-v1` + `gd-wand-diagnostics-v1` + `gd-wand-compact-flow-v1` + `gd-wand-floating-mapper-v1` + `gd-gps-polish-wand-layer-v1` + `gd-inline-clarity-caddie-patch-wand-overlay-clean` + `gd-inline-gps-wand-active-chrome-sync-v1` (+ wand code inside core; locked engine logic moves verbatim)
- **Course picker** ← `gd-course-picker-search-v2` + picker/pin code in core. The course-pin feature gets rebuilt here as one designed flow.
- **Course data/mapping** ← `gd-course-geometry-resolver`, `gd-course-library-pin-lock` (split library vs UI), `gd-course-play-pipeline`, `gd-course-mapping-debug`, `gd-course-visual-engine`, `gd-multi-nine-courses`, `gd-captured-surface-model/sync`, `gd-captured-hole-frame-camera-v19`, `gd-hole-frame-guide-contract-v20`, `gd-auto-map-handoff-quarantine-v1`
- **Practice/shot data** ← `clarity-table-ocr(+pixels)`, `gd-launch-monitor-*`, `gd-shot-*`, `gd-native-practice-data`, `gd-practice-import-action-bridge`
- **Shell/routing** ← reconcile `gd-route-audit` (7,058 lines) with the routing half of core; one shell owner.

Status unknown, confirm with Sam before touching: `gd-arcade-mode` (+ `gd-arcade-course-entry-v1`), `gd-tournament-mode-v1`, `gd-windross-seed`.

## Sequence

- **Phase A — collapse the patch layers.** Fold each patch file into its owner (wand first, then the caddie patches into GPS runtime), deleting the file+tag each time. This shrinks the load order from ~82 to ~35 scripts without touching core.
- **Phase B — carve core by feature.** Extract feature blocks (flag/pin first as the template, then permissions, GPS watch, scorecard) into owner modules loaded immediately after core, with guarded init. Core shrinks; every step boot-tested.
- **Phase C — one shell owner.** Merge the route/shell logic split across core and `gd-route-audit`.

Done so far:
- Boot smoke test added and proven against the broken commit.
- Dead files deleted (`gd-gps-badge.js`, `clarity-landing-build2.js`).
- Legacy features fully deleted per Sam: arcade mode, tournament mode, windross seed.
- Phase A in-place merges (order preserved, sections labelled, boot-tested): 7 GPS play layers → `gd-gps-play-runtime-owner-v1.js`; 6 caddie patches → `gd-caddie-gps-patches-v1.js`; 3 late wand layers → `gd-wand-flow-layers-v1.js`. Load order: 83 → 66 scripts.

- Phase A continued: 5 mid GPS flow layers → `gd-gps-play-flow-layers-v1.js`; wand/caddie belt regrouped (5 wand layers → `gd-wand-belt-layers-v1.js`, 2 caddie strays folded into `gd-caddie-gps-patches-v1.js`, cross-references verified before the move). Load order now 56 scripts.

Phase B started: flag/pin block carved into scripts/gd-flag-pin.js (loads right after core; shared global lexical scope keeps cross-references working). Local app permissions are carved into scripts/gd-app-permissions.js, loaded before core because profile/account boot needs its global bindings; the platform `clarity-permissions.js` resolver remains separate. GPS watch/location lifecycle is now owned by `gd-gps-play-runtime-owner-v1.js`; the old caddie GPS locate and geolocation monkey-patch wrappers were deleted instead of kept as rescue layers. Next: scorecard, wand-in-core, and course picker responsibilities; fold merged-section code into real owners as blocks move, and remove the inert tournament references as their blocks are carved. Remaining small merge candidates if desired: `gd-gps-location-set-lock-v1` + `gd-inline-gps-viewport-lock-v1` (contiguous pair), auth cluster (`gd-auth-gate-v1`, `gd-inline-profile-route-hardening-v1` → auth shell owner, non-contiguous so needs checks), `gd-inline-gps-tool-toggle-polish-v1-samebutton` → GPS owner.
