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

## 3a. Chart orientation — LAW

The chart is a **bird's-eye view**. The origin marker sits on the left with the ball
travelling right, and everything else must agree with that reading:

- x: left = short, right = long
- y: **down = missed RIGHT, up = missed LEFT** (`yForAngle` uses PLUS, not minus)

This is why the chart needs no axis labels: the origin marker states the orientation,
and the axes obey it. If the y sign is ever flipped back, labels become mandatory,
because the origin would then point at the wrong reading.

`originBottomTransform` rotates this so the origin sits at the bottom and the ball
travels up the screen. It must stay a TRUE rotation, `matrix(0 -1 1 0 ...)`,
determinant +1. It was previously `matrix(0 -1 -1 0 ...)`, determinant -1 - a
reflection that only looked correct because it was mirroring an already-mirrored
side-on view. Two wrongs cancelling. Verified after the fix: origin lands exactly at
bottom-centre, a right miss goes right, a long shot goes up.

---

## 3. Chart scale — LAW

Course / Practice / Comparison share one fixed normalised domain so identical bubble
data renders at an identical shape everywhere: `GD_NORMALISED_DEPTH_MAX = 30` (% of
anchor carry), `GD_NORMALISED_ANGLE_MAX = 10` (degrees), in
`gdPracticeNormalisedPlotLayout`. Axes must never be fitted to the plotted rows —
that is what made the same bubble look stretched on one screen and squat on another.

Anchoring differs by screen, deliberately:
- Practice / Comparison: one shared anchor (My Bubble's own distance).
- Course: each club against its own baseline (bag carry, else median of its own shots),
  because Course shows every club at once.

---

## 4. Course deviation — LAW, and the frame bug it exposes

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

Contrast with Practice, which anchors to My Bubble's CURRENT distance and therefore
re-bases whenever My Bubble changes. Correct for a live proposal, but it means the
practice picture shifts under the player. The course picture cannot.

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

## 5. SUPERSEDED — the "tolerance cost" idea

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
