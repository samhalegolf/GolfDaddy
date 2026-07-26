# Bubble Bible

The single source of truth for what each bubble is, where its numbers come from,
and what it is allowed to change. Written from the code, corrected by Sam.

Status key: **LAW** = settled, code must match. **OPEN** = design not finished.

---

## 1. The one rule that governs everything

**Only Practice Bubble adoption can change My Bubble.** — LAW

Course Data is comparison only. There is no path, by design, from course shots to
the playing bubble. Anything in the UI that implies otherwise is wrong copy, not a
missing feature.

```
Practice shots ──► Practice Bubble ──adopt──► pending ──save──► My Bubble ──► GPS play
Course shots   ──► Course Bubble  ──────────► (comparison only, never writes)
```

Code note: `gdCourseOffsetSuggestion` reads `p.pendingStatsOffsetSuggestion`, a key
nothing in the repo ever writes. It is dead and should stay dead — or be deleted so
it can't be mistaken for an intended path.

---

## 2. The bubbles

### My Bubble — the playing bubble
- **Is:** your saved aim + saved shape. The only persisted, player-owned bubble.
- **Lives in:** `p.faceOffsetDeg`, `p.centralFaceOffsetDeg`, `p.bubbleProfiles[club]`,
  `p.previewBubbleSet`, `p.practiceBubbleSource` / `practiceBubblePendingSource`.
- **Numbers from:** a real adoption or a real save. Nothing else.
- **Never invented.** If there's no real saved bubble the code returns `null` rather
  than a stand-in (`gdMyBubbleHubSource`, gd-route-audit.js:4312). Sources whose
  `shapeSource` matches `placeholder|default|stand-in|fallback|ghost|manual-profile`
  are rejected for GPS rendering by `gdMyBubbleGpsSourceLooksRenderable`.
- **Affects play:** yes — supplies the sideways aim (`aimOffsetM = tan(offset) x carry`),
  and the saved shape when the bag is real.
- **States:** `default` -> `pending` (adopted, unsaved) -> `saved` -> `adopted-current`.

### Practice Bubble — the only proposal
- **Is:** a live reading of launch-monitor shots. Not persisted.
- **Numbers from:** cluster anchor angle (`resultScaledCluster.anchorDeg`), median
  *measured* carry, `radiusDeg`/`stdDeg` for width, median depth x2.
- **Affects play:** nothing until adopted, then saved.
- **Adoption:** `gdPracticeAdoptBubbleAsPlayingBubble` stages a pending source only;
  `gdBubbleOffsetSave` is what actually writes My Bubble and re-renders the GPS screen.

### Course Bubble — the grade, not the input
- **Is:** what your paired on-course GPS shots actually did, versus the bubble you had
  set at the time (`plannedBubble` snapshot -> `analyzeBubbleFit` -> `resultBubble`).
- **Numbers from:** median centre, percentile spread at the consistency setting,
  `normalizedDeg = atan2(medianLateral, meanExpected)`.
- **Affects play:** nothing. Ever. See rule 1.

### GPS play bubble — what you actually aim with
- **Size from the BAG**, not from My Bubble: club ratios x carry.
- **Aim from My Bubble**: the offset.
- Every rendered one is snapshotted as `plannedBubble`, which is what Course Data
  later grades. This is the loop that closes: bag sizes it, practice proposes,
  course reports.

### Offset Hub bubble — display blend
Sizes = median of Course + Practice; aim = your current My Bubble offset. Underlay
only, never saved.

### Fit ovals
Analysis artifact: how tightly shots landed vs the bubble that was set.
`fitRatio > 1.12` expand, `< 0.78` tighten, else close match.

---

## 3. Chart orientation — LAW

**Down the line is the only orientation.** The shot origin sits at the bottom centre
and the ball travels UP the page:

- x = aim: **right miss = right** (`xForAngle`)
- y = distance: **long = up** (`yForDepth`, minus)

This is why the chart needs no axis labels: the origin marker states the orientation
and the axes obey it. Flip either sign and labels become mandatory, because the origin
would then point at the wrong reading.

It is built NATIVELY in `gdPracticeGraphInternalGeometry`, not by rotating a landscape
drawing. The old `originBottomTransform` approach pushed long shots clean off the top,
because rotating a 420x142 plot needs a 142-wide, 420-tall one. The chart is now
portrait (`GD_NORMALISED_CHART`, 480x460, plot 34-446 x 92-436) and the plot fills it -
only the title block and an 8px surround sit outside.

Consequences that must be kept in step: bubble `rx` comes from the ANGLE and `ry` from
the DEPTH (they swap with the axes), and the target line is the vertical one while
zero-distance is the horizontal.

The origin-bottom toggle, its stored preference and the rotate button are gone - all
dead code with no call sites, and keeping the transform would double-rotate the new
geometry.

---

## 4. Chart scale — LAW

Course / Practice / Comparison share one fixed normalised domain so identical bubble
data renders at an identical shape everywhere: `GD_NORMALISED_DEPTH_MAX = 25` (% of
anchor carry), `GD_NORMALISED_ANGLE_MAX = 8` (degrees), in
`gdPracticeNormalisedPlotLayout`. **These two numbers ARE the zoom** - the view
window. Axes must never be fitted to the plotted rows; that is what made the same
bubble look stretched on one screen and squat on another. Shots outside the window
clip at the edge on purpose - the view never stretches to swallow an outlier.

### The anchor must not move — LAW

Everything is plotted as a percentage of the anchor, so **changing the anchor moves
every dot and every bubble on the chart**. The anchor therefore has to be something
that does not change while the player is looking at it.

| screen | anchor |
|---|---|
| Practice | the **saved bag** carry for the club; practice measurement only when no real bag is set |
| Comparison | My Bubble, else Practice, else Course - whichever real bubble exists |
| Course | zero is the bubble that was played; no per-club anchoring at all (see 5) |

Comparison must NOT be gated on adoption. It shows whatever the home screens are
already showing, so a Practice and a Course bubble with no My Bubble yet both belong
there. It used to take the anchor from My Bubble alone, so a missing My Bubble left the
anchor null and `gdCompareBubbleParts` dropped EVERY bubble - the screen sat empty
waiting for an adoption that has nothing to do with it. The subtitle names whichever
bubble the anchor came from, so the axis never claims a reference it isn't using.

Practice used to anchor to My Bubble's distance and fall back to the practice bubble
only when no My Bubble existed. That meant the anchor CHANGED the instant a bubble was
adopted (measured 142m -> My Bubble's 155m) and the whole cluster jumped ~57px down on
adopt and back on undo. Nothing about the shots had changed; only the denominator.

**The bag is the reference.** Bag-anchoring is deliberate: the bag is the fixed thing
everything else is measured against, and it does not move when a bubble is adopted.
The jump was never caused by bag-anchoring - it was caused by the anchor SWITCHING
SOURCE (bag via `hubRows` when a My Bubble existed, practice distance when it did not),
so adopting flipped it and every dot moved.

Four traps, each of which produced the jump again on the way to getting this right:

1. **Never source the anchor from `hubRows`.** They only exist once a bubble is
   adopted, so anything reading them switches on adopt by definition.
2. **Saved bag, not the bag draft.** Adoption writes the learned distance into the
   draft, so anchoring to the draft moves the frame on adopt all over again.
3. **Only a REAL bag counts.** `gdPracticeSavedBagRows` happily returns the seeded
   ghost bag; anchoring the chart to stand-in numbers is the same sin as drawing a
   stand-in bubble. `gdPracticeHasUserBag()` is the test - false when the bag is a
   seeded default the player has never touched. Only then does the practice
   measurement take over.
4. **Resolve the club against the bag, not the bubble's label.** The practice bubble's
   `club` can be a display label ("Practice oval"), which keys to `"practice oval"`
   and matches no bag row - looking that up first silently missed the bag every time.

Verified: real bag 7i=150m -> anchor 150 through adopt AND save, 0px dot movement;
ghost bag only -> anchor falls back to the measured 142m, also 0px.

---

## 5. Course deviation — LAW, and the frame bug it exposes

**Every course shot is already measured from the bubble that was on screen at the
time.** `computeShotOutcome` (gd-shot-outcomes.js:105) takes the planned bubble's
centre and the ball's resting point, converts both into the bubble's own rotated
frame, and stores the difference:

```js
delta.lateral = resultLocal.lateral - centerLocal.lateral   // -> lateralErrorYards
delta.forward = resultLocal.forward - centerLocal.forward   // -> distanceErrorYards
```

So `record.normalizedDeg` does NOT mean "aim relative to the target line". It means
**"how far off MY BUBBLE that shot finished"**, against whatever bubble was genuinely
in play at that moment (which correctly handles the bubble changing over time).

That makes the whole course story simple, and no gates or sweeps are needed to tell it:

- **median of the deviations -> the shift.** e.g. `0.3L`.
- **spread of the deviations -> the size.**
- Draw it: Course Bubble sits slightly left of the GPS bubble, and a bit bigger.

### The centre line is the bubble — LAW

Course is the one screen whose zero is **the playing bubble**, not the target line.
Everything plotted there is only ever relative to whatever bubble was live when the
shot was hit.

The stored frame is self-contained and geographic:

```js
plannedBubble: { centerLat, centerLng, orientationDeg, lengthYards, widthYards, shape }
```

Origin, centre and orientation are saved per shot, so the deviation is resolved inside
that shot's own frame at that moment. **Therefore settings changing over time does not
matter.** Different offsets, different bag carries, a new adopted bubble, mid-round
club changes - every shot ever recorded still answers the same question, and the
aggregate always means the same thing. No re-basing, no migration, history never goes
stale.

Practice reaches the same stability by a different route: it anchors to the practice
bubble's own drawn distance, which does not move when a bubble is adopted (see 4).
Course does not need an anchor at all - the reference is stored on every shot.

Consequence: the per-club anchoring inside `gdCourseDataSurfaceSvg` (bag carry, else
median of that club's own shots) is unnecessary. Depth is already bubble-relative;
the anchor machinery is redundant and is where the frame mix below creeps in.

### On screen means it counts — LAW

If the bubble was on the screen, the shot counts. It does not matter whether that
bubble was adopted, saved, or a `gps-default` fallback - the player aimed with what
they were shown, so the deviation from it is real feedback.

Do NOT filter fallback-bubble shots out. Two reasons:

1. A default bubble that consistently misses is the most valuable signal in the whole
   dataset - it is the app being wrong, and this is the only place that surfaces.
2. Filtering them would bias the data toward periods when the player already had a
   good bubble. You would only ever grade yourself during the times things were
   already working, and the fallback's errors would be invisible by construction.

Worst case is still fine. A shot hit against a default bubble is just a data point
relative to a generic reference - which is what most apps measure against anyway. So
the floor of this design is the industry standard and the ceiling is a personalised
one. There is no case where a recorded shot is worth less than the norm, which is why
there is never a reason to reject one on provenance grounds.

Stronger than the norm, in fact: the reference itself is stored geographically per
shot (`centerLat`/`centerLng`/`orientationDeg`), so the measurement is exact whatever
it was referenced to. Most apps measure against an assumed straight line they never
recorded.

And even a 0.0 deg bubble is not "straight" - the player aimed it. `gdCaptureShotStatsFromGps`
(`gd-app-core.js:20730`) records:

- `if (!start || !target || targetDragging) return` - no capture WHILE aiming, so it
  stores where the player settled, not where they passed through.
- `center = gdBubbleRenderCenter(payload) || target` - the offset applied to the
  player's OWN chosen target, not the pin.
- `orientationDeg = bearing(start, target)` - lateral deviation is measured
  perpendicular to the line the player declared.

So the reference is the player's stated intent. The deviation answers **"did you do
what you intended"**, not "how far from the flag did you finish". A 0.0 deg bubble
aimed 15 yards left of the pin is a completely valid, fully recorded reference.

Optional, non-blocking: storing the bubble's provenance at capture
(`gd-app-core.js:20754`, schema at `gd-shot-events.js:274`) would let a screen
*explain* a step change in the data. It must never become a filter.

### FRAME BUG — FIXED

`gdCourseBubbleSource` used to assign `offsetDeg = fit.resultBubble.normalizedDeg`,
taking a **deviation from My Bubble** and plotting it as an **absolute aim from the
target line**. The Course Bubble rendered near straight-ahead instead of beside My
Bubble: a 0.3L deviation read as "course aims 0.3 deg left of target" when the truth
was "course lands 0.3 deg left of My Bubble, which itself aims 1.4R".

Now re-anchored: `offsetDeg = gdBubbleCentralOffset(p) + deviationDeg`, with
`deviationDeg` and `anchorOffsetDeg` both kept on the source so a screen can show the
raw "0.3L" without re-deriving it.

| My Bubble aim | deviation | Course Bubble drawn at |
|---|---|---|
| 1.4R | 0.3L | 1.1R |
| 0.0  | 0.3L | 0.3L |
| 2.5L | 0.3L | 2.8L |

Anything drawn on a TARGET-LINE chart (Comparison) must use the re-anchored offset.
Anything drawn on the COURSE chart uses the raw deviation, because there zero is
already the bubble.

### Also fixed: the Course Bubble label was permanently dead

`gdCourseBubbleValueLabel` (gd-app-core.js) guards on
`typeof gdCourseBubbleSource === "function"`, but that function lived inside the
route-audit IIFE and was never exposed. The guard was always false, so the Course
Bubble value read **"Bubble not ready" no matter how good the fit was**. Now exposed;
reads "Bubble ready" when a fit exists.

Related, still dead: `gdShotBubbleOverlayRowsForView` guards on
`typeof gdComparisonContext === "function"`, also never exposed. Not yet investigated.

### Secondary frame mix — RESOLVED ON THE COURSE CHART

`normalizeRecord` still computes `actualDistanceM = expectedM + depthM`, adding a
bubble-centre-relative forward delta onto expected distance - two different origins
summed. The course chart no longer touches `actualDistanceM` at all (it plots stored
deviations), so the chart is clean. The record field itself is still mixed and remains
wrong for any other consumer.

---

## 6. Two renderers, one set of numbers — LAW

The graph bubble and the GPS bubble are different RENDERINGS of the same real data.

| | what it is | built by |
|---|---|---|
| GPS bubble | the real thing projected into the world: rollout-inflated depth, physics tilt, visual skew, bag-roof clamping, screen caps | `gdGeneratedShotBubbleForClub` / `getGDBForClub` |
| Graph bubble | the same saved numbers drawn in the charts' language, so bubbles sit beside each other and are comparable | `gdBubbleRelativeParts` / `deviationPart` |

**Charts must never call the projector.** They used to:
`gdShotBubbleOverlayBubbleParts` regenerates every bubble from club + carry and never
reads the row's own saved dimensions, so one saved 20x26m My Bubble rendered at three
different sizes across three screens (Course 97.6x60, Practice 107.5x66, Comparison
124.6x76.7). Now all three are identical for identical data.

Rules that fall out of this, each of which was a bug first:

- **Real saved dimensions win, and there is NO fallback.** A row with no real shape is
  not drawn. Where a row genuinely has no shape of its own (practice projection rows
  are bag/data rows), give it the MEASURED shape - `gdGraphRowWithBubbleShape` scales
  the practice bubble's own cluster radius/depth to that row's carry. Never invent one.
- **The caller's offset wins for the angle.** Rows can carry a stale `offsetDeg`;
  the caller passes the live one for that layer. Preferring the row's drew the bubble
  at the wrong angle, and adopting then staged the real offset, so it visibly jumped.
- **Size comes from the saved bubble, never from a presentation pass.**
  `gdMyBubblePresentationMetrics` already normalises and scales; the graph renderer
  normalises again, so feeding its output in sized Practice's My Bubble ~8% larger
  than the same bubble elsewhere. Take only tilt/skew/handedness from it.
- **Every graph bubble wears the standard shape** (`gdStandardDispersionAxes`):
  area preserved (so size stays data-driven), aspect forced to the club ratio. Raw
  percentile spreads have whatever aspect the sample happened to have - that is what
  rendered the course bubble as a sliver, and a 0.45deg-wide My Bubble at 11:1.
- **Tilt uses `gdStandardDispersionTiltDeg`** (club + handedness), governed by the dev
  board's `tiltScale` / `tiltMaxDeg`. NOT the projector's tilt, which is physics tilt
  (the aim offset) plus visual tilt - on a chart the aim is already the bubble's
  position along the angle axis, so including it would count the same aim twice.
- **A shape drawn around the dots is not a bubble.** The old course fallback fitted an
  ellipse to the min/max of the plotted points with clamped radii and drew it in the
  bubble's colours. Deleted. With no measured fit, the dots speak for themselves.

Colours are shared so a bubble means the same thing on every screen: My Bubble white
`#f4f8f3`, Course green `#37f28d`, Practice blue `#62d2ff`, buffer amber `#ffb347`.

---

## 7. Adopt -> Save — LAW

Two steps, and the difference between them must be obvious on screen:

- **Adopt** stages a pending bubble (`practiceBubblePendingSource`). Undoable. Nothing
  the player plays with has changed yet.
- **Save** commits it to My Bubble (`gdBubbleOffsetSave`). NOT undoable.

The dock therefore reads: Save disabled -> `Adopt` | Save enabled + "Adopted, not
saved" -> `Undo` | after Save, "✓ Saved" and `Adopted` both disabled, with a
persistent line stating that Undo is no longer available. Being locked in is said
outright, not implied by a greyed-out button.

The old "Generate Bubble" button is gone. Its only job was switching the overlay on,
and adopting never needed the overlay visible - so adopt depends on `canProject`
alone. Gating it on `ctx.visible` would leave it permanently disabled without Generate.

The buffer band (My Bubble +`courseBubbleBufferPct`, default 50%) is drawn on Course
AND Comparison as one even-odd path - a genuine filled annulus between My Bubble's
border and the buffer's, with a solid outer line. Two stacked translucent ellipses
would tint My Bubble's interior instead of just the ring. It is built by scaling the
finished part (`gdGraphBufferPart`), which guarantees it stays concentric and shares
the tilt.

---

## 8. Sandbox data generator

Lives in the Course Data admin panel (coach/admin gated). Randomise a batch, edit it
by hand, then submit - the editable step is the point, so a specific case can be
reproduced exactly instead of only sampled.

Neither generator bypasses the real intake:

| | feeds | via |
|---|---|---|
| Course | `plannedShots` + `outcomes` | `replaceScopedStore`, same shapes `computeShotOutcome` produces from real GPS |
| Practice | `sessions` + `captures` + `shots` | `GolfDaddyLaunchMonitorData.importCapture()`, AFTER the gate, with `inputType:"generated-demo"` (an existing practice_evidence lane) |

Course rows are `club,carry_m,aim_deg,depth_pct` - the same deviation values the
course chart plots. Practice rows are `club,carry_m,total_m,offline_m,face,path,start`
in METRES, the launch-monitor store's own unit.

### The native -> practice-engine bridge — FIXED

Two practice stores exist and only one is read by the engine:

| store | key | who reads it |
|---|---|---|
| native | `gd_native_practice_shot_data_v1` | the Shot Library |
| launch monitor | `gd_launch_monitor_data_v1` | **the graph, cluster analysis, Practice Bubble** |

`saveNativePracticeShots` writes to the native store only, and nothing bridged the two.
So every native import - **including the email intake, which is the only live path** -
was stored, listed, reported as saved, and never reached anything the player sees:

- after a successful native save: native store 14 shots, launch-monitor store **0**
- `gdPracticeDisplayAnalysis()` -> `accepted: 0`, `needs_more_data`
- `buildPracticeGateInput` had **no consumer anywhere in the repo**
- `gd-launch-monitor-data.js` had zero references to the native module

Email intake shares this exactly: `gdPracticeLoadEmailBatch` builds the same
`gdNativePracticeImportPreview` object that `gdSaveNativePracticeImport` consumes.

**Now wired.** `gdBridgeNativePracticeToLaunchMonitor` runs after a successful save and
pushes the stored rows through `importCapture()` with `inputType` `email-csv` or
`native-csv` (both added to `captureDisplayLane`'s practice_evidence list). The SAME
`importBatchId`/`sessionId` are reused, so one delete clears both stores.

Verified through the real paste/save path: native +6, launch monitor 0 -> 6, display
0 -> 6, engine `accepted: 0` -> **6, 1 cluster**.

**Values pass through UNCONVERTED.** Neither store does any unit handling, so a
conversion here would be guessing at the source's units.

**A missing metric must never become 0.** `Number(null)` is `0` and `Number.isFinite(0)`
is true, so a bare finite check writes a fabricated zero. That shipped briefly in the
bridge and produced `faceToPathDeg: 0` - a dead-straight strike that passes the delivery
gate and suppresses `normalizeShot`'s designed `faceAngle - clubPath` fallback. Guard
`null`/`undefined`/`""` explicitly before the finite check.

Also note `gdParseNativePracticeImport()` only builds a PREVIEW
(`status:"ready_to_save"`, `dataSaved:false`); `gdSaveNativePracticeImport()` is a
separate call.

**No sandbox flag, by choice.** Injected shots are written into the live store and are
indistinguishable from real ones. Clear (Import panel) is the only way back. If this
ever needs to co-exist with real data, the store is already player-scoped - a
dedicated sandbox player id would partition it with no flag logic.

---

## 9. SUPERSEDED — the "tolerance cost" idea

Kept as a record of a decision, not as a plan.

**Language rule — still LAW.** Wider, not messier. Course spread is not degraded
practice data and must never be worded as if the player performed worse. Different
lies, slopes, wind, and one attempt per club make the window genuinely bigger. It
measures the course, not the golfer. No copy anywhere may imply sloppiness.

**The idea was:** widen the course cluster gates until a degree pattern emerges, then
report how much tolerance that took ("same aim, 2.4 deg wider window") as the
comparison currency between course and practice.

**Why it was dropped.** Two reasons, in order of discovery:

1. There was nothing to sweep. The "tolerance needed" is just the measured standard
   deviation, which `clusterSummary` already computes and then discards behind a
   boolean. The elaborate framing collapsed to "print the number you already have".
2. Then it stopped being needed at all. Once the deviation frame (section 4) is
   drawn, the spread of the deviations **is** the size of the course bubble. You see
   the wider window; a number quantifying it is redundant.

**What was built and then reverted:** `toleranceDeg` / `toleranceDeltaDeg` /
`rangeToleranceDeg` / `rangeToleranceDeltaDeg` / `gateStdDeg` / `gateRangeDeg` /
`widerThanGate` on the cluster summary, a `pattern_at_wider_tolerance` status with the
label "Same aim, wider window", and an `aimMatchMarginDeg` setting. All removed;
`clusterSummary` is back to its original shape.

**Worth keeping in mind if this ever returns:** the gates never filter which shots are
averaged - every shot is already in the average. They only decide whether the result is
trusted. So widening does not average more shots, it accepts a wider result; the aim
value barely moves and only the width around it changes.

**One piece that outlived the idea:** an off-aim cluster must never be presented as
"just a wider window". Any future wide-window wording has to be gated on the aim being
viable first, or it will excuse a genuine alignment problem.
