# Manual Practice Module

## Where it lives

- UI host: `index.html` inside `#practiceDataPanel` at `#gdManualPracticeLane`
- Browser store + UI controller: `scripts/gd-manual-practice-data.js`
- Shared analysis core: `scripts/gd-manual-practice-core.js`

## Session shape

Manual Practice stores local per-player sessions in `localStorage` under `gd_manual_practice_v1`.

Each session keeps:

- `sessionId`, player scope, timestamps
- `selectedClubId`
- `nextClassification`
- `observations[]`
- `results[]`
- `geometryPresetId` as a nullable future hook

Each observation keeps:

- `observationId`
- `clubId`
- normalized `x` / `y` coordinates in the plotting surface
- `classification` as `representative` or `disrupted`
- sequence and timestamps

## Normalization

Manual observations are not saved as final Bubble geometry.

The core converts each plotted point into practice-style evidence using the current club model:

- carry distance from the saved bag when available, otherwise existing default club carry
- lateral scale from the club's generated bubble width when available
- depth scale from the club's generated bubble depth when available

That produces practice-style shot rows with:

- `expectedM`
- `actualDistanceM`
- `lateralM`
- `depthM`
- `normalizedDeg`

Representative shots drive the primary cluster result. Disrupted shots stay visible in the session and review list, but they do not drive the first-pass Bubble derivation.

## How it feeds the Bubble system

Generated Manual Practice results are shaped to match the existing Practice analysis contract:

- `acceptedShots`
- `methods.resultScaledCluster`
- `recommendation`

When a manual result is active, the Practice screen uses that analysis object for:

- the existing Practice graph
- projection controls
- Practice Bubble generation
- the existing My Bubble adoption path
- downstream Bag / GPS consumption

This keeps Manual Practice as an input route into the existing Practice-to-Bubble flow rather than introducing a second Bubble system.

## Manual Bubble Override

Coach/admin users get a trusted override inside the Manual Practice lane.

The override only supplies:

- a club context
- an offset in degrees

It still resolves to the same Practice-result boundary as a normal manual session result. It does not expose arbitrary rotation, freeform shaping, or hand-edited Bubble geometry.

## Future preset hook

`geometryPresetId` is intentionally nullable for now.

That is the reserved hook for future predefined micro-geometry presets such as subtle tendency signals. This pass does not implement freeform geometry controls or a full preset library.

## Current assumptions

- Manual Practice persistence is local-only in this first pass.
- Existing carry defaults and generated bubble sizing are the normalization reference when a saved bag is not present.
- The current shared Practice renderer is reused by swapping in a manual-analysis object once a manual result is generated.


## Main app integration (2026-08-21)

Ported into the main app from the `GolfDaddy-manual-practice` worktree.

- `scripts/gd-manual-practice-core.js`, `scripts/gd-manual-practice-data.js`, `styles/gd-manual-practice.css` are new, unmodified drops.
- `scripts/gd-route-audit.js` (`gdPracticeDisplayAnalysis`, `renderPracticeData`) was patched, not replaced - that file had diverged from the worktree in unrelated ways, so only the manual-practice hooks were grafted in.
- `index.html` gained the stylesheet link, the two script tags, and the `#gdManualPracticeLane` mount point in the same place the worktree used it.

### Admin-only for now

The whole lane is gated to `admin` accounts only, at the single choke point `isAdminUser()` in `gd-manual-practice-data.js` (checked by `renderLane`, `renderEvidenceList`, `getDisplayAnalysis`, and the delegated click/pointer handlers). Coaches do **not** get the base lane - only the existing "Trusted override" sub-panel still checks `isStaff()` (admin or coach), unchanged from the original build.

This keeps Manual Practice out of what regular players (and therefore the iOS bundle's general audience) see while the feature is proven out. To promote it - to coaches, then everyone - loosen or remove the `isAdminUser()` check in that one file; no other file needs to change.
