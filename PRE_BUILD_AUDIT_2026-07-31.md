# Pre-build audit — 2026-07-31

Companion to `MOBILE_APP_ARCHITECTURE_HANDOVER_2026-07-31.md`. That doc says what
the fresh app should be; this one maps what the current tree actually contains, so
a session starting the fresh build knows what to take, what to leave, and what is
already gone. Verified by grep + `npm run test:boot` on this date.

## Already cut (this audit)

Deleted outright — git history keeps them, nothing referenced them:

- `_to_delete/` (stale git locks, an old React landing page)
- `archive/` (patch-history docs)
- Root bug-archaeology docs: `AUDIT-SCOPE.md`, `COLUMN_CORRIDOR_MERGE_BUG.md`,
  `HOLE_FRAME_NAVIGATION_UPDATE_NOTES.md`, `GITHUB_IMPORT_NOTES.md`,
  `SUPABASE_AUDIT_2026-07-12.md`, `PHASE_1_SOFT_LAUNCH_HANDOVER_2026-06-09.md`
- **The captured-surface authoring stack** (unusable — it wrote to the table
  emptied on 2026-07-31):
  - `scripts/gd-captured-surface-sync.js` + its `index.html` tag
  - `scripts/inline/gd-captured-surface-model-v1.js` (defined
    `gdCapturedSurfaceWriteScan`) + its `index.html` tag
  - `functions/captured-surface-sync.js` + the `/api/captured-surface-sync`
    redirect in `netlify.toml`
  - Tests of the deleted modules: `dev/captured-surface-sync.test.js`,
    `dev/captured-scan-hydrate.test.js`, `dev/scan-push-filter.test.js`, and
    their CI lines. `dev/course-key-normalisation.test.js` was rewritten to
    guard the surviving normaliser (the camera's `canonicalCourseKey`).

Every consumer degrades by design: the camera's write-back at line 614 is
`typeof`-guarded (now a no-op), and pin-lock's `cloudCourseMapSyncApi()` returns
null → `{attempted:false}` → normal mapping fallback. Verified after the cut:
boot smoke on all three surfaces, plus course-key-normalisation,
captured-frame-partial-flatten, app-frame-consumption,
course-identity-resolution, gps-play-runtime-owner, visual-engine-client.
`dist/` still contains the old copies until the next `npm run build:app`.

## Legacy still present (left deliberately — dies with the fresh build)

| piece | where | why it stays |
| --- | --- | --- |
| Capture camera | `scripts/inline/gd-captured-hole-frame-camera-v19.js` (2,268 lines) | **Dual-purpose.** It is the current cloud-frame presenter (`?v=…-cloud-first`); `buildCaptureManifest` / `flattenCaptureManifest` / `scheduleCaptureFlatten` remain inside it but can no longer write back anywhere |
| Registry reader | `scripts/gd-course-library-pin-lock.js` | Reads the scan registry keys tolerantly; its line-966 cleanup of `gd_captured_hole_frame_v19_*` keys is the rule-7 storage migration — keep until installed devices are clean |
| Schema | `supabase/APPLY_MISSING_2026-07-12.sql` | Still creates `captured_surfaces`; `functions/account-clear-data.js` / `account-delete.js` still wipe it (harmless — table exists, empty) |

## Why "remove all references" is the fresh build, not a cleanup

`gdCapturedHoleFrameCameraOn` — the legacy camera's body class — **is** the app's
"surface presentation active" state flag. ~40 references across
`gd-app-core.js` (27k lines), `gd-gps-play-runtime-owner-v1.js`, and
`gd-course-library-pin-lock.js` branch on it. State-by-body-class is the exact
pattern handover rules 3–4 forbid. Renaming/removing it in place is a multi-day
refactor of the live play path; in the fresh build it simply doesn't exist.

## Reactive code inventory (do not port any of it)

**15 `setInterval`s in the play path** (handover said ten; it undercounted):

- 90ms `consumeOverlayRequests` (`gd-app-core.js:21708`) — the suspected slowness
- 260ms `homeGuardTick` (`runtime-owner:3935`) — defanged to DOM re-wiring only, still polling
- 350ms tick (`runtime-owner:2483`), 650ms ticks (`runtime-owner:837`, `pin-lock:5680`)
- 700ms `lockMapInteractions`, `renderPreviewButton`, `syncToolScreen`
- 850ms `gdPracticeProcessingRefresh`, 900ms `refresh`, 1200ms `syncRailButton` + `syncHoleStepper`
- 8s debug `snapshot`, plus `gd-shot-library-sync.js:410`, `gd-app-core.js:16443`

**Patch/guard layers still loaded by `index.html`** (defences for bugs the fresh
build won't have): `gd-caddie-gps-patches-v1.js` (746 lines —
`rescueScheduleHoleOne`, `rescueActiveCourse`, `rescueIsManualCourse`),
`gd-auto-map-handoff-quarantine-v1.js`, `gd-inline-profile-route-hardening-v1.js`,
`gd-gps-location-set-lock-v1.js`, `gd-inline-gps-viewport-lock-v1.js`,
`gd-course-package-boundary-gate-v1.js`.

**Structure:** 82 `<script>` tags sharing one global scope, in load order.
`gd-gps-play-runtime-owner-v1.js` is 4,086 lines; `gd-app-core.js` ~27k.

## What the fresh build takes

The consumer path already exists and is the smallest slice of the tree:

- `scripts/gd-course-package-client.js` — course package fetch (server resolves geometry since 2026-07-29)
- `scripts/gd-course-visual-client.js` — published-surface lookup
- `scripts/gd-course-play-pipeline.js` — has the debug timeline; port the idea, not the file
- Platform modules REBUILD-PLAN already marked clean: `gd-namespace`, `clarity-store`,
  `clarity-session`, `clarity-cloud-sync`, `clarity-supabase-auth`, `clarity-router`,
  `clarity-permissions`, `clarity-email`, `clarity-backup`, `clarity-support`,
  `clarity-payments`, `gd-icon-assets`, `gd-brand-icon-render`
- `clarity-error-reporter.js` — with the flush/record trap noted in handover §6

Everything in handover §5 plus this doc's inventory stays behind.

## Docs that remain and why

- `MOBILE_APP_ARCHITECTURE_HANDOVER_2026-07-31.md` — the spec. Authoritative.
- `PRE_BUILD_AUDIT_2026-07-31.md` — this file.
- `REBUILD-PLAN.md` — 2026-07-19, describes an *in-place* rebuild now superseded
  by the fresh-build strategy, but holds the module owner map and the locked
  baseline (`codex.doNotModify` in `package.json`: Green Wand engine, tile-crop
  sampling, probe/ridge/magnetic shell). Read for the map; ignore the strategy.
- `PAYMENT_SETTINGS_HANDOVER.md`, `SUPABASE_AUTH_*`, `SUPABASE_SOURCE_OF_TRUTH_HANDOVER.md`
  — live systems, still current.
