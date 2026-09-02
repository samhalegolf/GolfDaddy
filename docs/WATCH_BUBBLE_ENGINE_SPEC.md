# Watch Bubble Engine

A small, deterministic, local geometry engine on the wrist. It turns

```text
player + target + Bag snapshot + My Bubble profile + hole reference
```

into the Bubble the Watch draws and manipulates, without asking the iPhone.

Same inputs, same Bubble. It is stateless: `result = BubbleEngine.calculate(input)`,
never `engine.moveSomething()`. Mutable state lives in `WatchPlayState`.

It does **not** own practice data, My Bubble adoption, Bag editing, account or
profile state, course mapping, or round persistence. Those stay on the phone,
and Marshal remains the only owner of a round (`docs/WATCH_ARCHITECTURE.md`).

---

## 1. Where the Watch is today

Worth stating plainly, because the gap is larger than it looks from the phone
side. The Watch is a **presentation surface with two exceptions**.

Everything golf arrives pre-computed. `WatchScene.Bubble` is
`{widthM, depthM, tiltDeg, club, carryM, totalM, centre}` — a *result*, not
inputs. There is no bag on the Scene, no dispersion profile, no aim offset. The
comment in `app/js/caddy-watch.js` is explicit that the phone's engine is
authoritative for club and shape, and that `null` is the honest answer when its
model is unavailable.

The two exceptions, both real local computation:

- `WristDistances.compute` in `ShotView.swift` — front/centre/back from the
  wrist's own fix against the Scene's green polygon.
- `WatchMapSpatialReference` in `WatchMap.swift` — the lite-map projection, a
  line-for-line mirror of the generator's `worldPx` / `applyTransform`.

And the thing that blocks the whole design as written:

> **The wrist cannot aim.** `CaddyWatchCommand.Kind`
> ([WatchScene.swift:82](../ios/App/ClarityCaddyWatch/WatchScene.swift:82)) is
> `LOCK, UNLOCK, VIEW_PREVIOUS_HOLE, VIEW_NEXT_HOLE, LOCK_AT, TAKE_OVER,
> HAND_BACK`. `AIM_AT` exists in the JavaScript vocabulary
> ([caddy-watch.js:257](../app/js/caddy-watch.js:257), mapping to Marshal's
> `AIM_DRAGGED`) but was never added to the Swift enum. There is no target
> state on the wrist, no drag handler, no crown handler.

So this is not an extension of something already half-built. It is the first
thing on the Watch that owns a golf calculation.

---

## 2. The hole reference already exists — the bake discards it

The lite-map generator is not short of spatial truth. It has all of it, uses it
to draw, and then emits counts.

`objectsForHole`
([gd-watch-map-core.js:186](../scripts/gd-watch-map-core.js:186)) already
returns:

```text
{ tee, green, greenShape, route, fairways, bunkers, water }
```

`buildWatchHoleFrame`
([gd-watch-map-core.js:416](../scripts/gd-watch-map-core.js:416)) then computes
the ordered fairway line — `orderedRoute(tee, geometry.route, green)` at
[line 433](../scripts/gd-watch-map-core.js:433), tee → bends → green, ordered by
distance *along* the hole rather than by key order, precisely because a corridor
measured along a zig-zagged route is not the hole's corridor. That is the
fairway line the Bubble Engine wants, already correct, already ordered.

It is used to frame the canvas and is then dropped on the floor. What survives
into the return value is `layers`, which records how many polygons were drawn.

One thing does survive, and it is half of what we need:

```js
// gd-watch-map-core.js:479
var checkpoints = { tee: tee, green: green };
if (geometry.greenShape && geometry.greenShape.length) {
  checkpoints.greenFront = nearestShapePoint(geometry.greenShape, tee);
  checkpoints.greenBack  = farthestShapePoint(geometry.greenShape, tee);
}
```

`checkpoints` exists only to validate the spatial reference, but it **is already
persisted** — [course-watch-maps.mjs:210](../functions/course-watch-maps.mjs:210)
writes it into the `holes` jsonb alongside the spatial reference. So every baked
course in the database today already knows, per hole, where the tee is, where
the green centre is, and where its front and back edges are.

Two things are missing from persistence:

| Value | Status |
| --- | --- |
| `tee`, `green`, `greenFront`, `greenBack` | **already stored** in `holes[].checkpoints` |
| `route` (ordered fairway line) | computed at line 433, discarded |
| `greenShape` (full polygon) | read by `objectsForHole`, discarded |
| `par` | not in this pipeline — stays on the Scene |
| hole length | derivable from route length; emit it rather than make the wrist sum |

And one thing is missing from delivery: `manifestHole`
([watch-map-delivery.js:61](../app/js/watch-map-delivery.js:61)) copies the
spatial reference field by field and deliberately drops everything else —
"whatever else the report grows, only the projection basis reaches the wrist."
That comment was right when the wrist only drew a picture. It stops being right
here.

### 2.1 The change

Emit a `reference` block from `buildWatchHoleFrame`, beside `spatialReference`:

```text
reference {
  version      1
  green        { lat, lng }
  greenShape   [{ lat, lng }, …]   // null when the green is mapped as a centre only
  tee          { lat, lng }        // null when the hole has no mapped tee
  route        [{ lat, lng }, …]   // orderedRoute: tee -> bends -> green
  bearingDeg   number              // compass bearing of the hole, tee to green
  lengthM      number              // along the route, not tee-to-green straight
}
```

`tee`, `route`, `bearingDeg` and `lengthM` are one fact — the hole's play line —
and travel together or not at all. A hole with no mapped tee gets all four as
null rather than a route measured from the green standing in for the tee.
`greenShape` is independently optional.

Two decisions made while building it, both departures from the first draft:

- **`greenFront` / `greenBack` do not cross.** They stay in `checkpoints` as
  spatial-reference validation. They are the nearest and farthest green vertex
  *from the tee*, ranked in raw degree space — so they are neither the player's
  front and back once they have left the tee, nor a true metric ranking. The
  wrist already answers that question properly from the polygon against its own
  fix (`WristDistances`). Shipping a fixed pair beside the shape it is derived
  from would only invite something to use the wrong one.
- **`bearingDeg` is not `rotationDegrees`.** `rotationDegrees` is the rotation
  applied to stand the hole up on the canvas, which is the *negation* of the
  bearing it was standing at: `holeBearingRadians` is `atan2(-1,0) - atan2(dy,dx)`
  in world pixels and the compass bearing of the same vector is `atan2(dx,-dy)`,
  which works out to exactly `(360 - rotationDegrees) % 360`. Taking it from the
  transform rather than measuring it again means it cannot drift from the
  picture — any framing change moves both. Pinned by a due-north and a due-east
  hole in `dev/watch-map-core.test.js`.

Then: store it in the existing `holes` jsonb (no migration — the column is free
form, see `supabase/migrations/20260901_create_course_watch_maps.sql`), copy it
field by field in `manifestHole` the same way the spatial reference is copied,
and decode it in `WatchMapManifest.Hole`
([WatchMap.swift:97](../ios/App/ClarityCaddyWatch/WatchMap.swift:97)).

Size: a route is typically 2–5 points and a simplified green shape 8–20. Call it
under 500 bytes a hole, ~9KB for a course, against ~100KB of imagery. It rides
the transport that already exists for the package and changes on the same
cadence — per course, per bake.

### 2.2 It can be backfilled without re-baking

`reference` is derived entirely from `course_maps.objects_json`, not from the
image. So an existing package can be given one **without regenerating imagery
and without bumping `watch_package_version`** — the same metadata-restore
manoeuvre already used on `millbrook-remarkables-18`, whose row was rebuilt
against its existing `v1788278423353` assets. A backfill pass re-runs
`objectsForHole` + `orderedRoute` for each hole in an existing row and writes
the block in. Images untouched, version untouched, every wrist that already
holds the package keeps it.

That matters because the alternative — bump the version — re-delivers ~100KB
per course to every wrist over WatchConnectivity for a few hundred bytes of
geometry.

### 2.3 The Watch must tolerate its absence

A package baked before this change has no `reference`. The manifest decode
therefore treats it as optional, exactly as `WatchMapManifest` already tolerates
a `version` that arrives as an integer, a double or a string rather than
refusing an otherwise valid package over its spelling.

A hole with no reference does not get a locally-computed default target. It
falls back to the Scene's target and the phone's Bubble. That is the rule in
§5.3 applied to inputs: **when the wrist lacks what it needs, it defers to the
phone, never to an approximation.**

---

## 3. Inputs

```text
WatchBubbleInput {
    playerCoordinate      // wrist GPS, or the Scene's phone fix
    targetCoordinate

    bagSnapshot           // §3.1
    bubbleProfile         // §3.2
    holeReference         // §2
    units
}
```

Three of those do not exist on any wire today.

### 3.1 Bag snapshot

```swift
struct WatchClub {
    let id: String          // stable; the club label is not an id
    let name: String
    let carryM: Double
    let totalM: Double
}
struct WatchBagSnapshot {
    let version: Int        // bumps on any change
    let clubs: [WatchClub]
    let source: String      // "account" | "ghost" — see below
    let maxAimM: Double?    // §9
}
```

The phone normalises before sending, using the bag functions it already has:
`gdNormaliseShotBagRows` sorts longest-total first and drops zero-carry rows;
`gdTotalM` applies the roll-out preset. The wrist receives finished numbers and
does not re-derive roll-out, firmness, or ordering. It does not need to know how
they were produced.

`source` is load-bearing and must cross. `gdPlayableShotBagRows` falls back to a
**ghost bag** of default carries when the account has none, and `getGDBForClub`
tags the result `ghostBag: true`. A Bubble built on a ghost bag is a stand-in,
and the wrist has to be able to say so rather than presenting invented distances
as the player's own.

### 3.2 Bubble profile snapshot

Per `docs/BUBBLE-BIBLE.md` §2 and `app/js/my-bubble.js`, the GPS Bubble takes
exactly two things from the saved My Bubble: **a degree value and a handedness**.
Size comes from the bag. The saved shape is deliberately *not* used — it used to
be, and a stored cluster width quietly resized the on-course Bubble.

```swift
struct WatchBubbleProfile {
    let version: Int
    let engineVersion: String     // §7
    let offsetDeg: Double?        // nil = no My Bubble set. NOT zero.
    let handedness: String        // "right" | "left"
}
```

`offsetDeg` must be genuinely optional. `Number(null)` is `0` and passes a bare
finite check, which is how "no bubble" became a fabricated 0.0° aim once already
— guarded in both `my-bubble.js` and `GDBubbleEngine.setBubble`. In Swift the
type system does this for us provided the field is `Double?` and the decoder
does not default it.

With no active saved bubble the phone sends `nil` and the wrist applies 0.0°
explicitly, matching `my-bubble.js`. It does **not** fall through to the
engine's placeholder 1.4° right, which was being applied to left-handers as a
right-hand miss.

### 3.3 Transport

Bag and profile share one small versioned payload. They belong on **neither**
existing path:

- Not the Scene. A Scene is a few hundred bytes republished many times a minute;
  the bag changes when the player edits it.
- Not the map package. That is per course; the bag is per player.

So: a third payload, sent on round start and on change, following the transport
rules the other two learned the hard way (`docs/WATCH_ARCHITECTURE.md`):

- Strip nulls recursively before sending. Capacitor bridges JS `null` as
  `NSNull` and `updateApplicationContext` throws `WCErrorCodePayloadUnsupportedTypes`
  on any `NSNull` anywhere in the payload. This has already broken the Scene
  *and*, separately, every command acknowledgement.
- Mirror as `sendMessage` when reachable, and queue via `transferUserInfo`
  otherwise. The queued stores are not reliable on this two-target Watch app.
- The wrist reports the versions it holds so the phone re-sends only what is
  stale, the same way `watchMapHave` works.

---

## 4. Outputs

```swift
struct WatchBubbleResult {
    let targetCoordinate: Coordinate
    let targetDistanceM: Double
    let selectedClub: ClubSelection
    let shotBearingDeg: Double

    let bubbleCentre: Coordinate     // aim offset applied; not the target
    let bubblePolygonGeo: [Coordinate]
    let bubblePolygonImage: [CGPoint]   // via WatchMapSpatialReference.imagePoint
    let bubbleBoundsImage: CGRect

    let engineVersion: String
    let confidence: Confidence       // .local | .ghostBag | .deferredToPhone
}
```

The renderer receives this and understands no Bubble maths.

`bubblePolygonImage` is in **lite-map image pixels**, not screen pixels. That is
the natural handoff: the map page already turns image pixels into screen points
through `WatchMapFrame.place`, and putting screen space in the engine's output
would hand it the camera.

---

## 5. The maths that has to cross

### 5.1 What the phone actually does

`app/js/bubble-engine.js` is **generated**. `dev/generate-bubble-engine-client.js`
copies ~55 named functions **byte for byte** out of `scripts/gd-app-core.js`
into a closure with a small declared adapter, and a test asserts every copy is
identical to core. Divergence is a CI failure and `gd-app-core.js` stays the
single authoritative source.

That is the codebase's established answer to "the same maths on two surfaces",
and **it cannot cross into Swift.** No codegen produces Swift from JavaScript.
The protection has to be replaced with something else (§6) or it does not exist.

### 5.2 The subset that crosses

Ported, in dependency order:

```text
bag        gdRolloutBasePct, gdBagTotalForCarry, gdCarryM, gdTotalM,
           gdNormaliseBagRow, gdNormaliseShotBagRows,
           gdResolveShotBagClub, gdMaxPlayableCarryM
profile    gdGetClubGroup, gdDefaultCarryForClub, gdGetClubPatternDefaults,
           gdBubbleGeometryTuning, gdDeriveAimOffset, gdDeriveBasePatternSize,
           gdDerivePatternWindow, gdDeriveClusterTilt, gdDeriveDistanceTendency,
           calculateBubbleProfile
render     calculateVisualBubbleRender, getGDBForClub, gdBubbleShotBearing,
           gdGpsAimDistanceM, gdGpsAimOffsetM, gdBubbleRenderCenter,
           gdBubbleAxes, gdBubbleLocalToLatLng, localPointToLatLng,
           buildBubbleShape, gdSmoothBubbleLocalRing
geo        bearing, project, projectOffset, normAng, haversine
```

**Not the bag roof.** `gdClampBubbleCenterToBagRoof`,
`gdBubbleRoofMaxDistanceM`, `gdBubbleForwardDistanceFromStart` and
`gdBubbleDepthForRoof` are defined in `gd-app-core.js`, copied into the client
by the generator, and **called by nothing**. The clamp was taken out of the
render path deliberately and `dev/fresh-app-boot.test.js` pins its absence from
the other direction ("bag reach must not shift the completed Driver bubble
centre"). Porting it would give the wrist behaviour the phone does not have, on
every out-of-range aim. The `beyond-bag-reach` parity case records what the
engine really does instead, so a Watch engine that helpfully ported the dead
clamp fails the harness rather than quietly disagreeing.

Orientation follows `scripts/gd-bubble-frame-core.js` and nothing else: 0° down
the origin→target line, 90° square right, clockwise positive, `acrossM` on
90/270 and `alongM` on 0/180. That file exists because four surfaces each
invented their own axes and two of them applied the *same* tilt function to
perpendicular references — a 90° disagreement sitting in plain sight in both
files and visible in neither. A fifth surface does not get to invent a sixth
convention.

### 5.3 What deliberately does not cross

| Not ported | Why | Wrist behaviour |
| --- | --- | --- |
| Wind (`gdWindEffectMeters`, `gdWindLandingFromAim`) | Display-target drift needing live conditions the wrist has no source for | Show the phone's target when wind is active |
| Micro-geometry (`gdSetBubbleMicroGeometry` …) | Built but ships **off**; enabling it is a Studio publish and the migration is unapplied | Identity — exactly what the phone renders today |
| Tournament mode | Policy, not geometry | Defer |
| Layup / fairway-line grab (`gdMappedFairwayLayupTarget`, `gdStartIsInMappedTeeArea`, `gdFairwayLineGrabAllowed`) | Needs the mapped tee area and full course package | §8 |
| `gdGpsBubbleDisplayPayload` pixel clamp | That is framing, not geometry | Framing Engine |

**The fallback rule.** When the wrist meets a case it has not ported, it uses
the Scene's value and reports `confidence: .deferredToPhone`. It never
approximates. A wrist that quietly substitutes its own answer for one it was not
built to give is worse than a wrist that says "the phone has this one".

---

## 6. Parity — build this first

Section 26 of the design is the load-bearing part, and there is a warning
already in the tree.

`WatchMap.swift`'s header says the projection "is a deliberate line-for-line
mirror of the generator's worldPx/applyTransform/invertTransform … the maths is
copied rather than approximated — and `dev/watch-map-projection.test.js` pins
the same numbers on the JavaScript side."

**`dev/watch-map-projection.test.js` does not exist.** `dev/watch-map-core.test.js`
tests the JavaScript only. There is also **no test target of any kind** in
`ios/App/App.xcodeproj`. So today nothing pins Swift to JavaScript anywhere in
this codebase, in the one place a document claims it does.

Do not repeat that with a second, much larger engine.

**Deliverable, before the Swift engine:**

1. `dev/fixtures/bubble-engine-parity.json` — inputs and expected outputs.
   Inputs are complete `WatchBubbleInput` values, not loose scalars: a bag, a
   profile, a hole reference, a player, a target.
2. `dev/bubble-engine-parity.test.js` — runs the fixtures through
   `app/js/bubble-engine.js` and asserts the expectations. This makes the
   fixture file authoritative on the JavaScript side, so it cannot silently
   describe an engine that no longer exists.
3. A **SwiftPM package**, `ios/WatchBubbleEngine`, rather than a target inside
   `App.xcodeproj`. It gets a test target (the xcodeproj has none, for anything),
   `swift test` runs it on the Mac without a watchOS simulator, and it is the
   shape the engine should be anyway — no UI, no WatchConnectivity, no round
   state, so a Garmin or Wear adapter can reuse it later. Nothing in it may
   import SwiftUI, WatchKit or WatchConnectivity; if it needs one of those it is
   not the engine. `BubbleEngineParityTests.swift` resolves the fixture by
   walking up from `#filePath` to the repo root — **not** a bundle resource
   copy, because a copy is a second source of truth and defeats the point.
4. Tolerances stated per field in the fixture, not global: metres to 0.1,
   degrees to 0.01, distances to 0.5.
5. Coverage that includes the corners, not just the happy path — ghost bag,
   `offsetDeg` absent, left-handed, target beyond the bag roof, no green shape,
   a hole with no mapped tee.

CI runs (2); the Watch test target runs (3). Either failing is a broken build.

---

## 7. Engine version

The Scene carries `schemaVersion` and nothing about the engine. Add:

- `bubbleEngineVersion` on the Scene's Bubble block — which engine produced the
  phone's numbers.
- The same on the profile snapshot — which engine the phone expects.
- The wrist reports the version it implements, beside `watchMapHave`.

When they differ, the wrist stops computing and renders the phone's Bubble,
reporting `.deferredToPhone`. A silent numeric disagreement between two engines
is the failure mode this whole document exists to prevent; detecting it is worth
more than a slightly staler Bubble.

Version string: `bubble-engine-v1`, bumped whenever any ported function changes
behaviour. The parity fixtures are versioned with it.

---

## 8. Default target, and where it stops

Design §16/§17 want the wrist to place a sensible opening target: driver
distance down the hole when the green is out of reach, the green when it is not.

The phone answers this with `gdTargetForGreenCentre`, which is not a
self-contained rule. It calls `gdMappedFairwayLayupTarget`, gated by
`gdStartIsInMappedTeeArea` and `gdFairwayLineGrabAllowed` — and that gate is
sharp-edged: it was once supplied under the wrong name, never opened, and every
out-of-reach hole laid up on the straight line to the green, cutting the dogleg.

With `reference.route` on the wrist (§2), the wrist can do the honest version:

```text
d = distance(player, reference.green)

d <= maxTotal + 3      -> target = reference.green
otherwise              -> target = point at maxTotal along reference.route
                          (the same "by shot distance along the route" rule as
                           fairwayLayupTargetByShotDistance)
```

That is the layup rule's *geometry*, and the route is exactly the input it
needs. What the wrist still cannot evaluate is the mapped-tee-area **gate** —
whether a fairway-line grab is allowed at all from where the player is standing.

Decision: the wrist computes the default target only from the route rule above,
and does so in two places only — **hole change** and **Reset**. It does not
recompute a default mid-hole, and it never overrides a target the player or the
phone has placed. Reset rebuilds a logical shot state (current fix, current
hole, default target, run the engine, centre the Bubble); it does not restore a
saved camera position.

If the phone's default and the wrist's default disagree on a dogleg, the
phone's wins on the next Scene. That is the fallback rule doing its job.

---

## 9. Writing back

Add `AIM_AT` to `CaddyWatchCommand.Kind`. It already maps to Marshal's
`AIM_DRAGGED` at [caddy-watch.js:257](../app/js/caddy-watch.js:257); the payload
is a coordinate.

**The wrist does not clamp aim.** The roof lives in Marshal —
[marshal.js:152](../app/js/marshal.js:152)'s `clampAim`, with `maxAimM` injected
at [line 146](../app/js/marshal.js:146) — never in the render path. A second
clamp on the wrist is precisely how two ends start disagreeing about where the
target is. The wrist sends the raw dragged coordinate and accepts the phone's
correction on the next Scene.

`maxAimM` still rides along on the bag snapshot, but for **presentation only**:
the Bubble Engine uses it for `gdClampBubbleCenterToBagRoof`, which shapes the
drawn Bubble, not for deciding where the target is allowed to be. Those are two
different questions and only the first belongs on the wrist.

Rate: `AIM_AT` is sent on drag *end*, not continuously. Local recalculation is
what makes the drag feel immediate; the phone does not need every intermediate
frame, and a Scene republished per drag frame would swamp the transport.

**Aim only.** Dragging the target is aiming, which the phone already supports.
Nothing in the drag path may place the *player* — tap-to-place is not part of
geo-mapped play, and "Head To the Tee" is a pin rather than a nudge. The wrist's
player position comes from GPS, always.

---

## 10. Club selection and hysteresis

```swift
struct ClubSelection {
    let clubId: String
    let clubName: String
    let targetDistanceM: Double
    let referenceDistanceM: Double   // the club's total
    let isGhost: Bool
}
```

The policy is `gdResolveShotBagClub`'s and is not reinvented: the club whose
**total** is nearest the target distance, ties resolved by the bag's existing
sort. No independent Watch recommendation philosophy.

Hysteresis is not in the phone's engine, because a mouse or finger on a large
map does not sit on a club boundary the way a wrist drag does. It is a **Watch
interaction concern and lives outside the engine** — the engine stays a pure
function of its inputs, including which club it was told to use.

`WatchPlayState` holds the current club and applies the band:

```text
current club stays selected until the target moves more than H metres past
the midpoint between it and the neighbouring club
```

Start `H` at 3m and tune. The architectural requirement is that the band exists
from the beginning and that it lives in the play state, not in the engine —
otherwise the engine stops being deterministic on its inputs and the parity
fixtures stop meaning anything.

Transition smoothing (100–200ms interpolation between Bubble shapes on a genuine
club change) is presentation only, in the renderer. The result changes
immediately; only the drawing catches up. No lag enters the shot state.

---

## 11. Boundaries

```text
INPUT              Interaction Engine    drag / crown / tap / reset
   |                                     -> candidate target
TARGET             Bubble Engine         distance, club, scale, orientation,
   |                                        geometry     [this document]
SHOT GEOMETRY      Framing Engine        where on screen, should the map move,
   |                                        how fast, what zoom
VISIBLE MAP        Renderer
```

The Bubble Engine never calls `panMap()`, `zoomMap()` or `centreCamera()`. It
answers where the Bubble is, what shape it is, which club, what distance — and
nothing about the screen.

It is also not allowed to clip to a fairway. The player must be able to test the
left side, the right side, a hazard carry, a lay-up, an aggressive line and a
conservative one. Bubble geometry is not fairway clipping. How far the target can
travel before the map starts scrolling is the Framing Engine's question.

Framing is a real gap: `WatchMapFrame` is a static viewport chooser (fit the
span of interest, cap magnification at 3×, refuse to show background past an
edge), not a camera model. And `WatchMapSpatialReference.coordinate(atImageX:y:)`
is currently marked "only used for diagnostics today" — it becomes the
load-bearing screen→geo path the moment a finger moves a target. It is already
proven as the inverse that round-trips; it just gets promoted.

---

## 12. Locked shot and offline

Most of this exists. `WatchSessionManager` already has a durable command outbox
with command-ID deduplication, persistence across launches, retry on
reachability change, and acknowledgement handling.

What is missing is the local snapshot, so a lock reads as locked instantly
rather than after a round trip:

```swift
struct WatchLockedShot {
    let id: String
    let holeNumber: Int
    let playerCoordinate: Coordinate
    let targetCoordinate: Coordinate
    let selectedClubId: String
    let targetDistanceM: Double
    let bubble: WatchBubbleResult
    let engineVersion: String
    let createdAt: Date
}
```

The Watch shows it locked immediately and queues `LOCK_AT` — which carries the
wrist's own `LocationObservation` and is subject to the existing accuracy
(≤100m) and staleness (≤5min) rules. Marshal still decides; the wrist is showing
intent, and a rejection surfaces the way rejections already do.

Once the wrist holds a course package, a bag snapshot and a profile snapshot,
this all keeps working with the phone in a bag: GPS updates, target movement,
distance, club selection, Bubble calculation, framing, local lock, hole
navigation. Round events queue.

---

## 13. State

```swift
struct WatchPlayState {
    var playerCoordinate: Coordinate?
    var currentHole: Int
    var targetCoordinate: Coordinate?
    var selectedClub: ClubSelection?     // held across drags for hysteresis
    var currentBubble: WatchBubbleResult?
    var lockedShot: WatchLockedShot?
}
```

The engine is stateless. Everything mutable is here, which is what makes
syncing, recovery and the parity fixtures clean — and what makes a Garmin
adapter realistic later, since it would reuse the engine and write its own state
holder.

---

## 14. Performance

A drag fires many updates a second. The hot path is coordinate maths, a bag
lookup, Bubble maths and a coordinate transform. No network, no database, no
image regeneration, no course geometry scans, no phone round-trips, no heavy
allocation. Pre-size the polygon buffer; the ring step count is fixed.

Everything is `Double`. `WatchMap.swift` already carries this rule for the
projection — a z20 world pixel is ~2.7e8 and single precision loses metres
inside a 448px image — and the same applies to any geometry that meets it.

---

## 15. Build order

1. ~~**Parity harness**~~ — **done.** `dev/fixtures/bubble-engine-parity.json`
   (11 cases), `dev/bubble-engine-parity.test.js` running them through
   `app/js/bubble-engine.js` with a deliberate `--update` to re-record, and
   `ios/WatchBubbleEngine` — a SwiftPM package with a real test target reading
   the same file by path. `npm run test:bubble-parity` and
   `npm run test:bubble-parity:swift` (§6).
2. ~~**Hole reference**~~ — **done.** `buildWatchHoleFrame` emits `reference`;
   `course-watch-maps.mjs` stores it and offers a
   `POST {courseId, action: "backfill-reference"}` that writes it into existing
   packages without re-baking or bumping the version, refusing any hole whose
   *own geometry* has moved (`sameReferenceGeometry` — deliberately not the
   projection basis, since surfaces are capture-time input and a hole reframes
   harmlessly once they are no longer listed); all 18 Millbrook holes
   backfilled 2026-09-02 against package `1788285633006`, images untouched;
   `manifestHole` forwards it field by field, omitted rather than nulled;
   `WatchMapManifest.Hole` decodes it tolerantly as optional (§2).
3. ~~**Bag + profile transport**~~ — **done.**
   `app/js/watch-player-delivery.js` builds the snapshot and decides whether to
   send it; `NativeRoundBridge.publishWatchPlayer` mirrors it live and queues it
   durably, null-stripped; `WatchPlayerStore.swift` caches it and reports
   `watchPlayerHave` back. Change detection is a content fingerprint rather than
   a counter, shared with the Swift side and pinned in the parity fixture, and
   the wrist recomputes it to refuse a truncated payload (§3.3).
   `ios/WatchBubbleEngine` is now a real dependency of the Watch Extension
   target, so the wire types are defined once.
4. **Engine version handshake** — before the engine ships, so a mismatched pair
   is detectable on day one (§7).
5. **The engine** — ported subset, stateless, fixtures green (§5).
6. **`AIM_AT`** — Swift enum, drag-end send, no local clamp (§9).
7. **Interaction + framing** — drag, crown, hysteresis, smoothing, reset,
   camera (§10, §11).
8. **Local locked shot** (§12).

Steps 1, 3 and 4 are phone-side or test-side, and step 2 is delivery-side —
none of them changes what the Watch draws. That is deliberate: the wrist keeps rendering the phone's Bubble,
exactly as it does today, right up until step 5 — and falls back to it forever
after, whenever it is asked something it was not built to answer.
