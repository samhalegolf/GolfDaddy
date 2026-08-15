# Phase 0 — where the Bubble intelligence lives

Written 2026-08-15, from the code, as the prerequisite the Micro-Geometry job
asks for: audit the Practice/Bubble stack and separate **authoritative analysis
logic**, **tunable model settings**, and **phone-side rendering/projection**.

The rule this audit is measuring against:

> **Server decides the player model. App applies and renders the model quickly.**

---

## 1. What was found

| File | Holds | Verdict |
|---|---|---|
| `scripts/gd-practice-parser-core.js` | Header aliases, unit resolution, row normalisation, validation | **Already correct.** One file, browser + `functions/practice-data-parser.js`. Left where it is; extended with the Signal variables (see §3). |
| `functions/practice-data-parser.js` | Server binding for the above (crypto ids) | **Already correct.** Untouched. |
| `scripts/gd-native-practice-data.js` | `buildPracticeGateInput()` — the gate's view of a row set | **Phone-side, correctly.** It is a pure projection of rows it is handed. Extended, not moved (§3). |
| `scripts/gd-shot-cluster-analysis.js` | `analyzeBubbleFit`, `analyzeClusterHunter`, consistency percentiles | **Browser-side, and it grades rather than models.** See §2 — deliberately not moved. |
| `scripts/gd-launch-monitor-data.js` | Provider fingerprinting, LM gates, `sourceTrust` don't-trust rules, cluster settings | **Mixed.** The fingerprinting stays (it reads raw import text, which only the client has). The trust *policy* is superseded server-side — see §4. |
| `scripts/gd-app-core.js` bubble block | `gdDeriveBasePatternSize`, `gdDeriveClusterTilt`, `calculateBubbleProfile`, `calculateVisualBubbleRender`, `getActiveBubbleProfile` | **Correctly phone-side: this is the renderer.** Preserved exactly, including `getActiveBubbleProfile()` projecting the saved offset through the Bag rather than loading a per-club saved shape. |
| `app/js/bubble-engine.js` | Generated verbatim mirror | Unchanged policy. Regenerated through `dev/generate-bubble-engine-client.js`; never hand-edited. |
| `app/js/my-bubble.js` | Feeds the saved degree + handedness into the play engine | **Preserved.** Micro-Geometry does not touch the aim. |

---

## 2. What was deliberately NOT moved, and why

Two things could have been dragged server-side and should not have been.

**`gd-shot-cluster-analysis.js` grades; it does not model.** Every function in it
answers *"how did the bubble that was set at the time actually do"* — Course
Bubble territory, which Bubble Bible §1 makes comparison-only. It is display
analysis over data the browser already holds, it writes nothing, and it can
never reach My Bubble. Moving it would have added a network round trip to a
read-only view and moved nothing authoritative. Its settings **are** tunable and
already are, through the dev panel.

**The bubble maths in `gd-app-core.js` is the renderer.** `calculateBubbleProfile`
and friends turn *a club and a carry* into *a shape*, which is exactly the work
that has to happen on the phone, offline, every frame. What was in the wrong
place was never this — it was the *policy* about how a player's evidence should
mould that shape, and that policy did not exist yet.

The honest summary: the phone was not holding a player model it should not have
had. It was holding a renderer, correctly. Phase 0's real job was to make sure
the new modelling layer was **born** server-side rather than added to the phone,
and that is what was done.

---

## 3. Contract expanded, not forked

`scripts/gd-practice-parser-core.js` gained six optional fields the Signal engine
reads — `dynamicLoft`, `dynamicLie`, `attackAngle`, `descentAngle`, `peakHeight`,
`hangTime` — with their header aliases, plus `launchDirection`/`horizontalLaunch`
as start-direction aliases. All optional, all `null` when the monitor did not
report them, never defaulted to `0` (a fabricated `0°` dynamic lie is exactly the
stand-in a progression Signal would read as evidence).

`buildPracticeGateInput()` now surfaces them in `delivery` and a new `flight`
block, plus `providerGuess`.

Both stay single-implementation. `dev/practice-parser-parity.test.js` and
`dev/practice-csv-regression.test.js` pass unchanged.

---

## 4. What actually moved server-side

Everything the new layer decides:

| Concern | Now lives in | Tunable from |
|---|---|---|
| Signal definitions (5, preloaded) | `scripts/gd-bubble-signals-core.js` | Studio → publish |
| Evidence aliases / routes | same | Studio → publish |
| Provider measurement + representation confidence | same | Studio → publish |
| Minimum sample gates, trend thresholds | same | Studio → publish |
| Region deformation amounts | same | Studio → publish |
| Axis caps | same | Studio → publish |
| Projection rules (representative clubs) | same | Studio → publish |
| Geometry model versions | `bubble_geometry_configs` | Studio → publish |
| The resulting player model | `bubble_player_models` | rebuilt on data change |

`sourceTrust` in `gd-launch-monitor-data.js` — the boolean don't-trust preloads —
is **superseded for Signal purposes** by `PROVIDER_CONFIDENCE` +
`ROUTE_PROVIDER_OVERRIDES`, which encode the same knowledge (radar-estimated club
delivery, modelled spin) as weights rather than blacklists. The old rules are
left in place because they still gate the existing LM cluster path; nothing was
ripped out from under a working system.

---

## 5. The payload, and why it is versioned

```
bubbleModelVersion
configVersion
engineEnabled
base:       offsetDeg · handedness · dispersionScale · playerPattern · sampleShots · clubsSeen
geometry:   axisAdjustmentDeg · long · longRight · right · shortRight · short · shortLeft · left · longLeft
signals:    per-Signal fired / evidenceStrength / effectStrength / route / reason
projection: referenceCarryM · minCarryM · maxCarryM · representativeClubs
```

The app does not need to know why `longRight = 1.006`. `compactModel()` strips
the detection reasoning before it travels; `diagnostics_json` keeps it for Studio.

`modelIsUsable()` is the version gate. A cached payload from a build that
understood a different shape is **not partially usable** — it is refused, and the
phone renders the plain bubble. There is no half-applied model.

---

## 6. No loading bars — how the promise is kept

```
new practice data saved
        ↓
POST /api/bubble-model {action:"analyse"}
        ↓
model persisted
        ↓
screen opens → cached model already in the engine → renders immediately
        ↓
background GET refreshes; replaces quietly if newer
```

`scripts/gd-bubble-model-client.js` calls `hydrate()` **synchronously at load**,
from `localStorage`, before any network call exists. GET never analyses — it
reports `stale: true` and still returns the last good model. Offline, signed out,
endpoint not deployed, never analysed: the cached model keeps rendering and the
screen does not change.

Publishing a config marks every stored model stale in one statement rather than
rebuilding thousands inside a request. Each rebuilds on its next analysis; the
phone keeps rendering its cached model until then.

---

## 7. V1 success condition — status

| Condition | Status |
|---|---|
| Authoritative analysis ownership audited | Done — this document |
| Tunable logic that should not live in the phone moved server-side | Done — §4. Nothing pre-existing needed moving; the new layer was born there |
| Stable versioned Bubble-model payload | Done — §5, `MODEL_VERSION = 1` |
| Cached last-good models allow instant navigation | Done — §6 |
| No routine workflow waits on analysis | Done — GET never analyses |
| **With all Signals disabled, nothing changes** | Done — pinned by `dev/bubble-micro-geometry.test.js` against the real generated client |

---

## 8. Known gaps

Stated rather than left to be discovered:

- **The analyse trigger is client-called.** `gd-shot-library-sync.js`'s
  `notifyUpdated()` now calls `onPracticeDataSaved()`, so a rebuild follows a
  successful sync rather than a screen opening — but it is still the *client*
  noticing. A server-side sweeper (the shape `course-mapper-sweeper.mjs`
  already uses) would cover a player whose data arrived by email and who never
  opens the app, and is the tidier long-term answer.
- **`bubble_player_models` is keyed on `player_id` only.** A player with no
  `playerId` (account-scoped only) falls back to reading by `account_id` for
  rows but cannot be written. Same limitation the shot library has.
- ~~The migration is not applied.~~ **Applied 2026-08-15** to the `clarity-caddie`
  project (`zcevluithwoumvafhmct`) as migration `bubble_micro_geometry`. Both
  tables exist with RLS on and their service-role policy; the single-active
  partial unique index was tested by attempting a second active row and being
  rejected. `bubble_geometry_configs` holds exactly one row: version 1,
  `{"enabled": false}` — the config that changes nothing. `bubble_player_models`
  is empty until the first analysis runs.
- **Studio's exaggeration is not wired to the live GPS bubble.** It drives the
  Studio drawing and the `bubbleGeometry.microExaggeration` dev field; it does
  not follow you onto the course, and should not.
