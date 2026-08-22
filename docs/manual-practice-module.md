# Manual Practice Module

Manual Practice is an **input route into the canonical Practice Data system**, not a
second analysis pipeline. A player plots roughly where shots finished; those
observations become ordinary Practice evidence in the Clarity Shot Library, and
everything after that - gating, clustering, the recommendation, the Practice
Bubble, My Bubble adoption, Bag/GPS - is the existing Practice pipeline doing
exactly what it does for a CSV, a photo or an emailed file.

```
Manual observation                 (plotted x/y, club, representative/disrupted)
      ↓
Manual Practice adapter            scripts/gd-manual-practice-core.js
      ↓
Canonical Practice evidence        clubGroups: carry + offline + provenance
      ↓
Practice Library / Gate            gd-launch-monitor-data.js importCapture + gates
      ↓
Cluster analysis                   analyzeDisplay() - result-scaled clusters
      ↓
Practice Bubble                    the shared Practice renderer
      ↓
Adopt as My Bubble
      ↓
Bag / GPS
```

## Where it lives

| File | Role |
| --- | --- |
| `scripts/gd-manual-practice-core.js` | **The seam.** Plot calibration, observation → canonical evidence, the trusted-override stamp. Pure, dependency-injected, no DOM. |
| `scripts/gd-manual-practice-data.js` | Draft store, session lifecycle, player ownership, admin gate, the lane UI. |
| `styles/gd-manual-practice.css` | Lane styling. |
| `index.html` | Stylesheet, the two scripts, and the `#gdManualPracticeLane` mount inside `#gdPracticeImportBody`. |
| `dev/manual-practice-core.test.js` | The seam: conversion, calibration, provenance, nothing invented. |
| `dev/manual-practice-integration.test.js` | The whole path against the real library: observations → evidence → analysis → bubble-shaped result. |

## Observation ownership

Manual Practice owns an observation only while it is being plotted.

- **In progress** - the draft session lives in `localStorage` under
  `gd_manual_practice_v1`. It is a work-in-progress cache: it survives a reload
  and nothing else depends on it.
- **Finished** - `finishSession()` converts the observations and hands them to
  `GolfDaddyLaunchMonitorData.importCapture()`. From that moment the evidence is
  in `gd_launch_monitor_data_v1`, which `scripts/gd-shot-library-sync.js` pushes
  to Supabase per import batch. The draft session keeps only a receipt
  (`importBatchId`, `captureId`, `shotCount`, the calibration used).

Completed Manual Practice evidence is therefore **not** dependent on
localStorage, is not a second Practice store, and is deleted, selected and
listed by the existing Practice import UI like any other batch.

## Session lifecycle

```
startNewSession()  →  draft  →  plot / undo / remove / reclassify  →  finishSession()  →  completed
                                                                            ↓
                                                        next plotted shot starts a NEW draft
```

- The store holds one `activeSessionId` pointer. `activeSession()` resolves it
  only if that session is still a draft **and** belongs to the current player.
- `finishSession()` clears the pointer. That is what stops every future shot
  from landing in a session that has already been generated.
- `startNewSession()` reuses an untouched draft rather than piling up empties.
- A completed session is evidence in the Practice Library and is no longer
  editable from this side. `listSessions()` / `getSessionById()` read previous
  sessions; they never mutate them.

## Player ownership

Strict, and **fails closed**. `hasPlayerScope()` is false when no player id can
be resolved, and every public entry point returns null/`[]`/`{ok:false}` and
writes nothing. There is deliberately no "no player id = everyone" fallback:
that is how a coach viewing Player A appends observations to Player B.

The lane renders an explicit "needs a player selected" message rather than a
plotting surface when unscoped.

## Plot calibration

`resolveManualPracticePlotCalibration(club, deps)` is the single, named
conversion from a normalised plot to metres:

```
expectedCarryM     the bag baseline  (gdClarityClubBaselineM - the same function
                                      every other importer uses for expectedDistanceM)
lateralHalfSpanM   half the club's generated bubble width  (gdGeneratedShotBubbleForClub)
depthHalfSpanM     half its generated bubble depth
calibrationSource  e.g. "club_baseline+generated_bubble", "fallback_carry+carry_ratio"
calibrationVersion "manual-plot-v1"
```

```
offline = x * lateralHalfSpanM
carry   = expectedCarryM + (y * depthHalfSpanM)
```

One calibration is resolved per club per session, so every observation of a club
is converted on the same scale. The calibration is stamped onto each shot's
provenance, and the stored evidence is already in metres, so changing how
bubbles are generated later cannot silently reinterpret historical manual
sessions. Bump `CALIBRATION_VERSION` when the rule changes.

## The canonical evidence contract

Each observation becomes one Shot Library `clubGroup`:

```
shotId              manual-<observationId>
originClubLabel / candidateClub
expectedDistanceM   the BAG BASELINE (never the shot's own carry)
timestamp, playerId, playerName, accountId
source              manual_practice
analysisLane        cluster_hunt | manual_disrupted
excludeFromPrimaryPattern
provenance          { manualPractice, classification, observationId, sessionId,
                      plot:{x,y}, calibration:{...}, geometryPresetId }
metrics             carry, offline        <- and nothing else
```

**Nothing is invented.** A plotted dot knows where it finished, so it claims a
carry and an offline. No ball speed, club speed, spin, spin axis, face angle,
club path, face-to-path or launch direction is fabricated. The delivery method
therefore stays silent on a manual session instead of guessing, and no quality
gate is ever fed a number nobody observed.

## Representative vs Disrupted

Both classifications cross the boundary. A disrupted shot is real evidence: it
is converted, stored, synced and plotted like any other. What it must not do is
move the primary pattern.

That is expressed once, generally, in the library:

```js
// gd-launch-monitor-data.js
function excludedFromPrimaryPattern(shot) { ... }
```

honoured by `analyzeResultScaledClusters` (both the per-club and the oval path)
and `analyzeDeliveryClusters`. Any source can set the flag; no
Manual-Practice-specific conditional exists downstream.

Representative evidence takes the `cluster_hunt` analysis lane - the same
per-club lane the generated-demo rows use. Without it the library pools every
club into one oval and the cross-club replication Manual Practice is built
around could never be shown.

## Clustering thresholds

The canonical pipeline owns them. That means a manual session now needs the same
evidence an imported one does (`minClusterShots`, currently 5 shots per club,
plus the spread and range limits) rather than the module's old three-shot rule.
A hand-plotted dot is not more authoritative than a measured shot.

## Trusted override

Coach/admin only, and deliberately narrow: a club and an offset in degrees
(plus the nullable `geometryPresetId` hook).

`applyTrustedOverrideToAnalysis()` takes the canonical analysis and replaces the
anchor and the recommendation, stamped `coach_manual_override`. It does not
re-cluster, re-gate or re-score anything - cluster membership, shot counts,
spreads and the resulting bubble's shape all still come from the evidence the
pipeline gated. It reaches My Bubble down the same path a measured result does.

It is not shot evidence, so it is not written to the Practice Library. It is
stored per player in the manual store with `createdAt`, `createdBy` and the
setter's role, and it is cleared from the same panel.

There is no arbitrary rotation, no width/depth editing, no freeform shaping and
no direct GPS bubble mutation.

## Admin rollout gate

One choke point: `isAdminUser()` in `gd-manual-practice-data.js`. Every public
entry point runs through `gated()`, which checks the rollout gate **and** the
player scope. Promoting the feature (admin → coach → player) is a change to that
one function; no other file needs to move, and the data model does not change.

Coaches and players see nothing in the lane today. `isStaff()` still governs the
trusted override sub-panel within an admin session.

## Future preset hook

`geometryPresetId` stays nullable and is carried through to each observation's
provenance. It is the reserved hook for predefined micro-geometry presets; this
pass implements no freeform geometry controls.

## Notes for future changes

- `renderPracticeData` is exposed on `window` by `gd-route-audit.js`. The lane
  (and Projected Clubs, and the shot-library sync) repaint through it; before it
  was exposed all three silently did nothing.
- Adding a new inputType means adding it to `captureDisplayLane()` in
  `gd-launch-monitor-data.js`, or the import lands and then never appears on the
  Practice Data screen. `dev/manual-practice-core.test.js` holds the two files
  to the same value.
- The manual lane bumps its own `?v=` in `index.html`; so must any Practice file
  it depends on, or the browser keeps serving the old script.
