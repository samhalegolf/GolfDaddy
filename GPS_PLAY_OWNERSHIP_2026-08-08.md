# GPS Play — ownership and continuity

Written 2026-08-08 after the on-course test that produced random bubble renders
and green focus that never opened.

**Status: the four continuity fixes in §7 are done and verified.** The play-owner
refactor in §4 is proposed, not built.

Everything below is about `app/js/` — Clarity Caddy's play surface. Clarity
Booking is untouched by any of it.

---

## 1. The short answer

Yes, you need a stronger play owner.

Not because the code is badly written — `play.js` is careful, and most of the
comments describe real bugs that were really fixed. The problem is that there
is no single thing that knows what state the app is in. There are **15
module-level variables in `play.js`, 10 body CSS classes that are read back as
state, and 14 sibling modules** that each hold a piece of the round. The render
pass reads all of them and works out the answer fresh every time.

That is why the failures look random: they aren't random, they're combinations
nobody enumerated.

---

## 2. The players

These are the things that together decide what is on screen at any moment.

### Inside `play.js` (module-level `var`s)

| Variable | What it means | Who writes it |
|---|---|---|
| `current` | course, package, hole number, hole record, centre, nines | `start`, `goHole`, `updatePackage` |
| `transitionToken` | async guard for hole transitions | `start`, `goHole`, `stop` |
| `map` / `objectLayer` / `baseLayer` / `baseKind` | Leaflet | `ensureMap`, `frameHole`, `setBaseFor` |
| `liveFrame` / `mapSide` | the live map camera | `applyLiveFrame`, `clearLiveFrame`, `goHole`, resize |
| `activeFrame` | the published surface camera | `applySurfaceFrame`, `clearSurface`, `goHole`, resize, settings |
| `frameStage` | `hole` \| `lock` \| `zoom` | `setStage` |
| `cameraParked` | camera has settled on a locked shot | `parkCamera`, `goHole`, `stop` |
| `viewLocked` | **was dead — now deleted** (§7) | — |
| `bubbleDragPoint` | finger position during a bubble drag | pointer handlers |
| `placement` | `null` \| `"tee"` \| `"standing"` | pill buttons, `unlock`, `goHole`, GPS release |
| `startPillDismissed` | pill hidden | Standing Here, `unlock`, `goHole` |
| `standingTapArmed` | one tap allowed to place the player | Standing Here, tap handlers, `unlock`, `goHole` |
| `shotLocked` | a shot has been locked in | position listener, `unlock`, `goHole` |
| `greenFocus` | `null` \| `{ball, placed}` | `updateGreenFocus`, ball drag, `exitGreenFocus`, `goHole` |
| `greenFocusDismissed` | Back closed it, don't reopen yet | `exitGreenFocus`, `updateGreenFocus`, `goHole` |
| `liveAtCourse` | GPS fixes are trusted this round | `maybeAdoptGpsFix`, `start`, `stop` |
| `teePinAwayFixes` | consecutive fixes clear of the pinned tee | `teePinReleasedBy` (new, §7) |
| `provenance` | what surface is showing and where from | `presentSurface`, `clearSurface` |

### Body classes read back as state (not just styling)

`surface-published`, `map-framed`, `tilt-lock`, `green-focus`, `shot-active`,
`bubble-dragging`, `ball-dragging`, `pin-dragging`, `data-frame-stage`.

Three of these are genuinely load-bearing logic:

- `projector()` branches on `surface-published` — the whole projection seam
  depends on a CSS class.
- `cameraHolds()` branches on `bubble-dragging` and `ball-dragging`.
- `applyGestureState()` branches on `map-framed`.

**The DOM is currently a state store.** That is the single biggest structural
problem, because any code anywhere can toggle a class and change behaviour.

### Sibling modules holding round state

`position` (value + source), `shot` (start/target/completed, per hole), `pin`
(per hole + armed flag), `GDBubbleEngine` (start, target, wind, bag, hole
context — a *second* copy of the shot), `gps` (lastFix, status), `gpsSettings`,
`scorecard`, `nines`, `resume`, `courseData`, `undo`, `wakeLock`,
`courseStore`, `playsLike`.

Note the duplication: **the active shot exists twice** — in `app.shot` and
inside `GDBubbleEngine`. They are kept in sync by hand in two places
(`app.shot.onChange`, and the position listener, which calls `setShot` twice
with different arguments in the same tick). Any divergence renders a bubble for
a shot that isn't the shot.

---

## 3. What actually went wrong on the course

### 3a. The silent one underneath both symptoms

```js
courseLat: Number(params.get("courseLat")),   // boot.js, courseFromUrl
```

`Number(null)` is **0**, and so is `Number("")`. The picker only appends
`courseLat`/`courseLng` when its own row carried them
(`gd-course-picker-search-v2.js:535`). So a course handed off without them
started the round with a course centre at **(0, 0)** — a real point in the Gulf
of Guinea, ~15,000km away.

`maybeAdoptGpsFix` measures "is this person actually at the golf course"
against that centre with an 800m radius. Every fix failed it. **GPS was
rejected for the entire round**, silently, and a rejected fix looks exactly
like a phone that never got one.

This is the same null-is-zero trap `shot.js`'s `pt()` already guards against.
Reproduced in the browser and fixed (§7).

### 3b. Random bubble renders

**The bubble drew whenever `pos && app.shot.active()`** (`aimingShot`).
`app.shot.active()` is not cleared by anything except a new hole or a hole-out.

The concrete failure: press **Unlock Shot**. The shot is deliberately left in
flight (Course Data needs the last lock-in joined to the next one). So the
moment the next GPS fix landed, `aimingShot` returned the **old** shot and the
engine drew a cluster sized for the old start point against the old target —
while the aim line ran from where you're standing *now* to a target from two
shots ago. Measured in the regression test: **6,216 characters of ring paths**
redrawn after an Unlock.

Two more contributors, not yet fixed:

- **Every position change renders twice.** `wirePosition` registers two
  `onChange` listeners. The first calls `app.shot.place()`, which notifies
  `shot.onChange`, which calls `renderPosition` (pass 1). Then the second
  listener calls `renderPosition` again (pass 2). Pass 1 mutates
  `cameraParked` / `mapSide` / `activeFrame`, so pass 2 runs against different
  camera state than pass 1 did.
- **The ring visibility rule flickers.** `renderShotOverlays` drops a ring if
  fewer than 60% of its points project, and only draws the cluster if all
  three rings survive. On a published surface, points outside the image
  project to `null`, so walking toward the edge makes the whole bubble pop out
  and back in.

### 3c. Green focus didn't work

Green focus can only open from inside `renderPosition`, which only runs when
the position changes. Three ways the position stopped changing:

1. **(0, 0) course centre** — §3a. No fix ever reached `app.position`.
2. **"Head To the Tee" pinned you for the whole hole.**
   `maybeAdoptGpsFix` returned immediately when `placement === "tee"`, and
   `placement` was only cleared by `goHole` or Unlock. Pressing Lock in that
   state did `placement === "tee" ? app.position.current() : ...` — it
   re-locked the *same tee coordinate*. You could walk the whole hole and the
   dot never moved, so you never came within 40m of the green.
3. GPS denied — already handled with a notice.

And when it *does* open it can still look thin: `body.green-focus` hides the
green outline, the route and the tee marker (styles.css:53-55), and
`renderDistances` hides the whole distance bar. On a hole with no published
surface, outside NZ (OSM rather than LINZ aerial), zoomed to a green — the
screen is an empty grey tile, a ball, and nothing else.

---

## 4. The proposal: one play owner

A single state object, one mutation path, and rendering that is a pure function
of state.

### 4.1 The state

```js
const state = {
  round:  { courseKey, pkg, centre, nines, gpsTrusted },
  hole:   { number, rec, presentation, provenance },   // 'loading'|'live'|'published'
  player: { point, source, pinnedTo },                 // pinnedTo: null|'tee'
  shot:   { phase, start, target },                    // see below
  camera: { stage, frame, parked, gesture },
};
```

`shot.phase` is the piece that fixes the bubble class of bug structurally:

| phase | meaning | bubble | dock button | pill |
|---|---|---|---|---|
| `preframe` | no position placed yet | no | Lock (hidden until a position exists) | yes |
| `aiming` | locked in, shot in flight | **yes** | Unlock Shot | no |
| `finishing` | green focus, ball being placed | no | Shot End | no |

The bubble draws **if and only if `shot.phase === 'aiming'`**. §7's fix is the
same idea expressed as a guard; the phase machine is the version that can't be
forgotten at the next call site.

### 4.2 The rules

1. **One entry point for mutation.** `play.dispatch(event)` where events are
   the things that actually happen: `HOLE_ENTERED`, `POSITION_FIXED`,
   `POSITION_TAPPED`, `LOCK_PRESSED`, `UNLOCK_PRESSED`, `SHOT_END_PRESSED`,
   `AIM_DRAGGED`, `BACK_PRESSED`, `SURFACE_READY`, `SURFACE_FAILED`,
   `VIEWPORT_CHANGED`. Nothing else writes state.

2. **The transition table is explicit.** Each `(phase, event)` pair either has
   a defined result or is ignored. Today nobody can tell you what
   `placement==='tee' && greenFocus && !shotLocked` should do — because it's
   reachable and undefined.

3. **Render is derived, never authoritative.** `render(state)` *writes* body
   classes; nothing reads them back.

4. **One render per event.** Coalesce through a single
   `requestAnimationFrame`. Kills the double pass.

5. **One copy of the shot.** `GDBubbleEngine` is fed from `state.shot` in the
   render pass and nowhere else.

6. **Listener exceptions must not be swallowed.** `position.set` wraps every
   listener in a bare `try {} catch (e) {}`, so a crash inside `renderPosition`
   is completely invisible — the screen just stops updating. Report it to the
   error reporter that's already loaded.

### 4.3 Suggested shape

Keep `play.js` as the Leaflet/DOM owner. Add `js/play-state.js`: pure, no DOM,
node-requirable (the same pattern `distance.js` and `play-surface.js` already
follow), so the transition table is unit-testable without a browser. That fits
the existing rules in `app/README.md`.

---

## 5. Still worth deleting

- **`placement` + `startPillDismissed` + `standingTapArmed`** — three flags
  encoding one concept ("how is this player being positioned"). One enum.
- The `GDBubbleEngine.setShot` call inside the position listener — redundant
  with the one in `shot.onChange`.

---

## 6. Remaining order of work

1. **Extract `play-state.js`** with the phase machine; wire `play.js` to read
   from it and stop reading body classes.
2. **Single rAF render.**
3. Stabilise the ring visibility rule (clip rather than drop).
4. Surface listener exceptions instead of swallowing them.
5. Give green focus a visible marker of its own.

---

## 7. What was changed on 2026-08-08

Four fixes, all in `app/js/`. Verified in a real headless browser — see
`dev/gps-play-continuity.test.js`, 15 checks, all passing. Three of them fail
on the previous code.

**`boot.js` — absent coordinates read as absent.**
`courseFromUrl` now parses `courseLat`/`courseLng` through `coordParam`, which
answers `NaN` for a missing or blank parameter instead of `0`.

**`play.js` — the course centre is derived when the URL doesn't carry one.**
New `packageCentre(pkg)`: the mean of every hole's tee and green. Used by
`start()` when the hand-off has no usable coordinates, and by `updatePackage()`
when a package arrives mid-round for a course that started with none. Only the
800m trust radius is measured from it, so a centroid is as good an answer as
the library row's own.

**`play.js` — "Head To the Tee" releases itself.**
`maybeAdoptGpsFix` now runs the trust gate *first*, so an unverified fix can't
release the pin either (off-course testing must not walk you off the tee). Once
trusted, `teePinReleasedBy` releases the pin after **two consecutive fixes more
than 25m from the tee** — a tee box is about 20m deep, and two fixes stops one
wild reading doing it. Unlock still releases immediately; a hole change still
clears it.

**`play.js` — no aiming instruments without a lock-in.**
`aimingShot` now also requires `shotLocked`. Unlock still leaves the shot in
flight for Course Data, but the cluster, aim line, wind drift line, layup
guides, drag hit and shot row all go away — which is what `desiredStage`
already believed, since it reads an unlocked shot as pre-frame.

**Deleted as dead:** `viewLocked`, `setViewLocked`, the `#lockToggleBtn`
wiring, the `view-locked` class and the `viewLocked` branches in
`applyGestureState` and `cameraHolds`. The button was removed from
`index.html` in an earlier pass (styles.css:176 notes it), so the flag could
never become true. Also removed: a redundant `shotLocked = true` in the lock
handler (the position listener sets it from the same event), and a duplicated
`var rec` in `renderShotOverlays` — hoisted to one declaration at the top,
because the second one was quietly load-bearing when the layup block didn't run.
