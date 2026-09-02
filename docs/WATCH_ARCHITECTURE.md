# Caddy Watch architecture

## Authority

Marshal owns the round. It decides the live and viewed holes, targets, Bubble,
Lock/Unlock, Shot End, scoring, Green Focus and shot completion. Wearables are
presentations and constrained inputs only; they never persist a second round or
reimplement shot rules.

`app/js/caddy-watch.js` projects the Marshal Scene into `CaddyWatchScene`
(schema version 1) and routes `CaddyWatchCommand` values back to validated
Marshal signals. The module is pure JavaScript and has no DOM, Leaflet, Swift,
Kotlin or Garmin fields.

## Implemented contract

`CaddyWatchScene` contains a revisioned round ID, flow/mode, viewed/live hole,
front/centre/back distances, engine-provided Bubble/club values, controls,
score, and compact local geometry. Modes are `standard`, `bubble`, and
`green-focus`; an adapter may display its own menu/hole picker from the supplied
hole controls. A failed/uncertain adapter must show `standard`; that never sends
a Marshal signal.

Geometry is local metres around the green, rotated to the player's approach.
The green polygon, route, player and target therefore share one physical scale.
No satellite tiles, Leaflet state, phone pixels or full course package cross the
boundary. Missing or malformed green shapes yield an empty polygon, not invented
geometry.

Supported commands are `LOCK`, `UNLOCK`, `AIM_AT`, `SHOT_END`,
`VIEW_NEXT_HOLE`, `VIEW_PREVIOUS_HOLE`, `VIEW_HOLE`, `SET_SCORE`,
`REQUEST_LATEST_SCENE`, `LOCK_AT`, and `SHOT_END_AT`. Mutating commands require
`commandId`, `roundId`, and a non-future base revision. Repeated command IDs are
accepted as idempotent no-ops. Hole navigation remains view-only: it cannot move
`live.hole`.

## Location observations

`LOCK_AT` and `SHOT_END_AT` use a `LocationObservation`:

```text
coordinate: { lat, lng }
horizontalAccuracy: metres (0–100)
timestamp: milliseconds, no older than five minutes
source: phone-web | phone-native | apple-watch | wear-os | garmin
```

The observation affects only that action. It never replaces the phone's current
fix globally. Shot completion metadata records the supplied location provenance.

## Lite maps

Course imagery is deliberately not part of the Scene. `scripts/gd-watch-map-core.js`
bakes one flat vector image per hole plus a spatial reference; the phone reads
that package from `course_watch_maps` and pushes it to the wrist, where it is
cached on disk and drawn under the player's own GPS fix.

The Scene carries only `course.key`. Everything else travels on its own path,
because a Scene is a few hundred bytes republished many times a minute and a
package is ~100KB of imagery that changes only when a course is regenerated:

```text
app/js/watch-map-delivery.js   reads /api/course-watch-maps, builds the manifest
NativeRoundBridge.swift        transferUserInfo(manifest) + transferFile(image)
WatchMapStore.swift            durable cache, one course/version at a time
WatchMap.swift                 projection + viewport maths
HoleMapView.swift              the drawn page
```

Recipe v2 frames each bake on a **play corridor** — 55m either side of the
hole's own route — rather than on the union of every mapped object. Under this
codebase's surface-cloning model a hole owns every surface inside its
axis-aligned capture box, which for a 507m diagonal par 5 is 19.3ha, so v1
framed on the neighbourhood: Millbrook's 1st drew six fairway corridors, five of
them 104–233m off the play line, and spent under 9% of its width on the hole
being played.

The corridor decides framing only. Every polygon is still drawn and simply falls
off the edge of the viewBox, because filtering whole polygons does not work here
— most OSM fairway ways are multi-hole ribbons, so keeping one drags a
neighbouring hole back into the frame and dropping it deletes the near part the
player can see. Only geometry entirely off-canvas is culled, and nothing is
clipped to the canvas rectangle: that would draw the outline stroke along the
cut. Route bend points (`type: "fairway"`, not `fairway_area`) are ordered by
distance along the hole rather than by key order, because a corridor measured
along a zig-zagged route is not the hole's corridor.

A manifest hole is `{holeNumber, asset, width, height, spatialReference,
reference?}`. The spatial reference is the generator's own `{refZoom,
transform{a,b,tx,ty}, imageWidth, imageHeight}`; the Watch re-implements
`worldPx` and the similarity transform to match it exactly, in `Double`
throughout — a z20 world pixel is ~2.7e8, so single precision would lose metres
inside a 448px image. A package whose reference version is not 1, or whose
transform is degenerate, is refused rather than drawn against.

`reference` is the hole's golf geometry — `{green, greenShape?, tee?, route?,
bearingDeg?, lengthM?}` — travelling with the image that was drawn from it. All
of it was already computed to draw the hole and used to be discarded, so the
wrist received a picture it could not measure anything against and every Bubble
had to be computed on the phone and sent over. `tee`, `route`, `bearingDeg` and
`lengthM` are one fact, the hole's play line, and travel together or not at all:
a hole with no mapped tee has none of them rather than a route measured from the
green standing in for the tee. `bearingDeg` is derived from the transform —
`(360 - rotationDegrees) % 360` — rather than measured a second time, so it
cannot drift from the picture. `greenFront`/`greenBack` deliberately stay behind
as spatial-reference validation: they are ranked from the tee in raw degree
space, and the wrist already answers front/centre/back properly from the polygon
against its own fix.

The reference is optional at every level and never costs a package. One baked
before the generator emitted it is still a perfectly good picture of a hole; a
malformed one is decoded away rather than thrown on (which would reject the
whole manifest and leave the wrist with no map at all); and a missing field
costs the wrist a local calculation, which falls back to the Scene, and nothing
else. Because it derives from `course_maps.objects_json` and never from the
image, `POST /api/course-watch-maps {courseId, action:"backfill-reference"}`
writes it into an already-baked package without re-baking imagery or bumping
`watch_package_version` — but only for holes whose own geometry has not moved
since, because a reference describing today's green under an image drawn from
last week's would put the wrist somewhere the picture disagrees with, silently,
both halves being individually valid. A hole that fails is left alone and named
in the report; its fix is a regenerate.

What that guard must **not** compare is the projection basis. The canvas is
framed on the play corridor plus whichever mapped surface vertices fall inside
it, and surfaces are capture-time input: they are collected to be drawn, they
become part of the image, and `objects_json` settles back to the lean
tee/green/route set that GPS Play actually needs. So a hole reframes whenever
the surfaces are no longer listed — all 18 Millbrook holes did, from 179–448px
wide down to 96–251px — while its tee, green, green extents, route and bearing
stayed byte-identical. None of that is in the reference, which is lat/lng and
travels beside the *stored* spatial reference that still projects it onto the
*stored* image exactly as before. `sameReferenceGeometry` therefore compares the
hole itself, not the canvas.

Both transports are durable queues, and neither ordering is guaranteed: an image
is filed from its own transfer metadata and reconciled with the manifest
afterwards. The filesystem is the state, so a half-delivered package reports
exactly the holes it has. The Watch reports its inventory back as `watchMapHave`
so the phone re-sends only what is missing; losing that report costs a re-send,
never correctness.

The bake is WebP and **watchOS has no WebP decoder** (ImageIO: "could not find
plugin for image source ... 'RIFF'"), so `NativeRoundBridge.publishWatchMapAsset`
re-encodes each hole as JPEG (quality 0.8) before it leaves the phone. PNG was
tried first and came out at 50-68KB per hole, over the `sendMessage` payload
limit. The asset keeps its manifest name; the Watch files by name and decodes by
content. A raw WebP file left on the wrist by an older phone build is not
counted as delivered (`WatchMapStore` checks the RIFF magic), so the phone is
asked for it again rather than told "have".

A reachable Watch also receives the manifest and each image as live
`sendMessage` payloads, the same mirror `publishScene` uses and for the same
reason — the queued stores do not reach this two-target Watch app reliably, and
a hole bakes small enough to fit a message. Writing identical bytes to the same
versioned path twice is a no-op, so the mirror and the queue cannot disagree.

The map is a second page, not a replacement: page one stays the numbers face
with LOCK one tap away. **LOCK flips to the map by itself** — the shot has just
become a thing to look at — and **swiping back to the numbers is the unlock**:
the map is only ever entered programmatically, so a page change to the numbers
while the shot is locked can only be the player's swipe, and it sends `UNLOCK`.
There is no separate locked face and no rendering of the Bubble on a black
background; the numbers page is always the rangefinder. The green comes from
the Scene, the player is the wrist's own fix (or the phone's when the wrist has
none). A hole with no delivered image shows why, not a blank.

## The player snapshot: bag and My Bubble

A third payload, alongside the Scene and the lite-map package, because it fits
neither. A Scene is a few hundred bytes republished many times a minute, so
equipment riding it would trail every distance update; a map package is ~100KB
per COURSE, while a bag belongs to the PLAYER and changes when they edit it.

```text
app/js/watch-player-delivery.js   builds the snapshot, decides whether to send
NativeRoundBridge.publishWatchPlayer   sendMessage mirror + transferUserInfo
WatchPlayerStore.swift            durable cache, one snapshot at a time
WatchBubbleEngine (SwiftPM)       the wire types, shared with the engine
```

The snapshot is `{version, fingerprint, bag{isGhost, clubs[]}, bubble{handedness,
offsetDeg?}, engineVersion}`. The bag is the engine's own playable bag — the
account bag, or the ghost stand-in when there is none — already normalised,
sorted longest-total-first and with the roll-out preset applied, so the wrist
consumes finished numbers and has no opinion about how they were produced.
`isGhost` travels because a Bubble built on a stand-in bag is a stand-in and the
wrist must be able to say so. The bubble is a degree value and a handedness and
nothing else (Bubble Bible s2); `offsetDeg` is **omitted** when no My Bubble is
set rather than sent as zero, because a saved 0.0° aim is a real and different
thing and a fabricated one was once applied to every player, left-handers
included, as a right-hand miss.

Change detection is a **fingerprint, not a counter**. A counter has to be stored
on both ends and kept in step, and the moment they disagree a stale bag looks
current. The fingerprint is derived from the content —
`v1|g0|Driver:205:228|…|b:3.20:right|e:bubble-engine-v1` — so either end can
answer "has this changed" with no memory of what went before. It is a readable
string rather than a hash on purpose: no collisions to reason about, and a
misbehaving delivery says in the log exactly what the wrist holds.

The wrist reports its fingerprint back as `watchPlayerHave` on activation, on
adoption, and whenever the phone comes back into range. An **empty** fingerprint
is a real answer — a fresh install or a cleared cache — and is deliberately
distinct from never having reported: collapsing the two leaves a wrist that has
lost its bag un-resupplied because the phone still believes it sent one. An
answer from the wrist settles the question outright; the phone's own note of
what it last sent only stands in while the first report is still in flight.

The wrist **recomputes** the fingerprint from the contents it receives and
refuses a snapshot that does not match. WatchConnectivity payloads cross a
Capacitor bridge, a plist encoding and a radio, and a snapshot that lost half its
clubs on the way would otherwise be cached and played on — a silently short bag
picks the wrong club for every shot. That check is also why the two
implementations are pinned against shared cases in
`dev/fixtures/bubble-engine-parity.json`: a quiet disagreement here would make
the wrist reject every bag the phone ever sends, and nothing would say why.

`engineVersion` rides along so the wrist can tell whether it implements the same
Bubble maths the phone's numbers came from. Nothing on the wrist computes a
Bubble locally yet; when it does, a mismatch means render the phone's answer
rather than a second opinion.

## The Watch Bubble Engine

`ios/WatchBubbleEngine` computes the Bubble on the wrist: which club a distance
resolves to, the pattern that club derives, the caps and floors that size it,
and the 168-point ring that draws it. It is stateless —
`BubbleEngine.calculate(input)` — and everything mutable belongs to the play
state. It answers where the Bubble is and what shape it is, and says nothing
about the screen: no panning, no zoom, no camera.

`WatchSessionManager.localBubble` runs it for the Scene's target against the
wrist's own fix, the same way `WristDistances` already answers front/centre/back
— the wrist is its own rangefinder, and now its own Bubble too. It is gated on
the version handshake and returns nothing when the versions disagree, no bag has
arrived, no target is in play, or there is no trustworthy fix. None of those is
an error, and none shows the player anything: the map page draws the Scene's
target as a picture, exactly as it did before.

The port is deliberately narrow. Wind, micro-geometry (built but shipping off),
tournament mode and the display **pixel** clamp do not cross — the last because
it measures the Bubble against a map viewport, which is framing. Neither does
the bag-roof clamp, which is defined in `gd-app-core.js`, copied into the client
by the generator, and called by nothing.

Three quirks of the phone engine are reproduced rather than corrected, because a
wrist that "improved" on any of them would disagree with the phone with nothing
to say why: the main ring is drawn at 1.02 scale; the visual tilt adjustment
never mirrors for left-handers (`calculateBubbleProfile` returns no handedness,
so the caller's "right" fallback always wins); and JavaScript's `Math.round`
rounds negative halves the opposite way from Swift's. All three are pinned —
the first two by parity cases, the third by direct unit test after a mutation
check showed no fixture value reaches a half.

## Aiming on the wrist

The target is the control point: a drag moves the TARGET, never the player. The
player comes from GPS and only from GPS — tap-to-place is not part of geo-mapped
play, and a drag that could relocate the golfer would be exactly that.

```text
finger  ->  view point
        ->  image pixel        WatchMapCamera.imagePoint
        ->  coordinate         WatchMapSpatialReference.coordinate
        ->  Bubble             WatchPlayState.moveTarget -> BubbleEngine
        ->  drawn immediately
lift    ->  AIM_AT, once
```

`AIM_AT` carries `{point:{lat,lng}}` — the shape Marshal's `AIM_DRAGGED` reads —
and is sent on drag END, not per frame. Local recomputation is what makes the
drag feel immediate; the phone does not need the intermediate frames, and a
Scene republished per frame would swamp the link for numbers nobody reads.

**The bag's roof is applied on the wrist** (`WatchPlayState.clampedToBag`): a
target dragged past the longest total in the bag is pulled back to it along its
own bearing — Marshal's `clampAim` rule, on the wrist's own target, never on the
drawn ring. It used to be sent raw and the wrist took the phone's correction on
the next Scene; now that the wrist keeps its own target while driving, the roof
has to be on both ends or they disagree about where the aim is. The point sent
is already inside the bag, so Marshal's clamp is a no-op on it.

**The Scene's target is adopted only while the wrist has none of its own.**
Once the wrist has placed a target — by its default rule or by a drag — a Scene
revision neither moves it nor re-frames the map. The wrist is driving; a picture
that re-fits itself around the phone on every revision is the phone driving by
proxy, and it read on the wrist as the origin wandering. The wrist's target is
cleared on a new hole (`WatchPlayState.enter`) and placed afresh: from the Scene
if the phone has one (after LOCK, its own default layup), otherwise by the
wrist's default rule off the green and route the manifest carries for the hole
(`LoadedHoleMap.reference` → `WatchPlayState.reset`). A long hole therefore
opens on a Driver Bubble on the fairway line before anyone has locked.

**The camera frames the Bubble, not the player** (`WatchMapCamera.bubble`): the
ring — or a 45x55m nominal extent around a bare target — at 42% of the view,
floored at the width fill so there are no side bars. The player is allowed off
the bottom; the aim line still reaches the edge and pivots as the target moves,
which is the cue that the origin is a fixed point. `play` (player low, hole
ahead) remains for a hole with no target at all. The camera is set on appear, a
new hole, the first fix and the first Scene target — and by the crown and the
edge pan — never on a Scene revision and never on drag end.

**A tap places the target and moves nothing else.** A drag — press, hold 0.2s
(a click says the target is picked up), then move — keeps the target under the
finger and the map under both stays put: what is being placed stays where it is
being placed. The hold is what lets the page be swiped away: a drag that began
on touch-down took every horizontal swipe, and swiping back to the numbers is
the UNLOCK. The map moves only when the finger reaches the very
edge of the view (`WatchMapCamera.edgeInset`, 16pt) and holds there for
`edgeDwell` (0.4s) — so a sweep to the far side does not set it moving on the
way past — and then it creeps at `edgePanSpeed` (45pt/s) in the edge's
direction, putting the target back under the finger on every step. The old
comfort-rect follow, which panned the moment the Bubble's ring reached 22% of
the view, is gone: it moved the map on a plain tap and read as far too
sensitive. The club and the distance to the target are drawn inside the Bubble,
live, off the wrist's own engine result.

Aiming needs three things at once: the phone says the shot can be aimed
(`controls.canAim`), the wrist runs the same engine (the version handshake), and
it holds a bag. Any missing and the map is the picture it was before — the hole,
the player, the phone's target, no drag.

**The club transition band lives in `WatchPlayState`, not the engine.** A finger
crossing the boundary between two clubs crosses it many times a second, and
without a band the answer flickers 6i, 5i, 6i, 5i with the Bubble jumping after
it. But a band is memory — the answer depends on which club was showing a moment
ago — and memory in the engine would end its being a pure function of its
inputs, which is the property the parity fixtures rest on. So the state holds the
club, the engine is TOLD which club to use (`heldClub`), and the fixtures keep
working. The band is 3m past the midpoint of the two clubs' totals, applied on
the side the target is moving toward; that asymmetry is the hysteresis, and it
means 164m is a 6-iron if you were on a 6-iron and a 5-iron if you were on a 5.

Reset rebuilds a shot rather than restoring a camera: current fix, current hole,
the default target down the route, engine, frame. A reset that put the player
back where the map happened to be looking would return them to a view they had
already decided was wrong. It clears the held club too — the band smooths a drag,
and carrying it through a reset would let a club they have left behind survive
the thing meant to start over.

## The locked shot, before the phone answers

Pressing LOCK sends a command and then waits — for the radio, for Marshal, and
for the next Scene to say the shot is closed. On a good link that is fast enough
not to notice; in a bag at the far end of a fairway it is not, and the player has
already walked off. `WatchLockedShot` lets the wrist read locked at once, from
the club and distance its own engine produced.

It is **intent, not truth**. Marshal owns the round and can refuse — no live
round, a stale revision, a location it will not accept — and a record that
outlives its own uncertainty is not a nicety, it is a shot the player believes
is logged and is not. So there are exactly three ways out, all explicit:

```text
rejected     the lock did not happen        discard at once
confirmed    the Scene moved past it        the Scene is truth now
expired      nothing came back in 20s       stop claiming, whatever the reason
```

The expiry matters most because it is the only one that survives a case nobody
thought of: any bug in the other two costs twenty seconds of a wrong screen
rather than a whole round of one. The decision is one pure function on the
record — round, Scene revision, whether the command is still queued, and the
clock — so it is tested without a radio, a Scene or a wrist, and all three
endings are mutation-checked.

The record is keyed by the LOCK command's own id, so an acknowledgement names
exactly the record it settles; it carries the engine version that produced it;
and it survives a relaunch, because the outbox does and a lock that vanished
while its command did not would leave the wrist waiting with no explanation.

It stores the Bubble's **shape**, not its 168 ring points — the ring is derived,
and storing derived geometry beside the inputs that produce it is how the two
drift apart.

While it is unconfirmed the numbers page names the wrist's own club, not the
Scene's (the Scene has not caught up), and offers no LOCK or UNLOCK control —
UNLOCK would act against a shot the phone may not have accepted, and LOCK would
invite a second one. The player is on the map page by then anyway: LOCK took
them there.

A wrist that computed nothing of its own records nothing and waits exactly as it
did before, so this never invents a shot it cannot describe.

## Engine version handshake

Two engines, one written in JavaScript and generated from `gd-app-core.js`, one
written in Swift and generated by nobody. The parity fixtures catch a
disagreement at the moment they run; they cannot catch a phone that has since
shipped a new engine to a wrist that has not been updated. Only a version
exchanged at runtime can, and the failure it prevents is the silent one — two
engines each answering confidently and differently, a Watch showing a 6-iron
where the phone shows a 5, no error anywhere, and no way for the player to know
which to believe.

`BUBBLE_ENGINE_VERSION` is declared **once**, in `app/js/caddy-watch.js`
alongside `SCHEMA_VERSION`, because it is a fact about the wearable contract and
two payloads have to agree on it: the Scene's `bubble.engineVersion` says which
engine drew the Bubble on screen, and the player snapshot's `engineVersion` says
which engine the bag on the wrist was normalised for.
`app/js/watch-player-delivery.js` reads it rather than declaring one, with no
fallback string — a snapshot that cannot state its engine cannot take part in
the handshake, so it is not sent at all. `BubbleEngineVersion.current` in
`ios/WatchBubbleEngine` is the Swift half, and tests on both sides pin all three
against the fixture so bumping one alone fails the build.

`BubbleEngineVersion.agreement(scene:snapshot:)` resolves it on the wrist:

```text
agreed              versions match           -> the wrist may compute
mismatch            phone runs another       -> render the phone's Bubble
phoneInconsistent   scene and bag disagree   -> a phone mid-upgrade; defer
undeclared          nothing said yet         -> defer
```

Exact match only. A compatibility range would be a claim about which changes
were behavioural, and every change to this engine is behavioural — it exists to
produce numbers. One declaration is enough to decide, because a phone only ever
sends one value and a Scene and a bag legitimately arrive in either order;
requiring both would leave the wrist deferring through the gap for nothing. An
empty string is silence rather than a differing version, because null-stripping
on the way over can legitimately turn an absent field into one. Only `agreed` is
permissive, asserted as such over every state so that adding one later cannot
quietly default to allowing local computation.

Deferring costs a slightly staler Bubble — the phone's, off the Scene, which is
exactly what the wrist rendered before it had an engine at all. That is a good
trade and it is taken automatically, with nothing shown to the player: this is
not their problem to solve.

The wrist reports the engine it implements in `watchPlayerHave`, beside the bag
fingerprint, so a mismatch is visible from the phone's side too rather than only
inferable from a Watch that mysteriously never computes. Nothing on the phone
changes behaviour on it — the wrist is the end that defers.

## Native Round Bridge and adapters

`app/js/native-round-bridge.js` is inert on web. On native iOS it hands the
latest scene to `NativeRoundBridge.swift`, which uses WatchConnectivity's latest
application context for presentation and returns Watch messages/user-info as
generic commands. This is the one intended native seam for a future Apple Watch
app, Live Activity, Lock Screen actions, native location and reconciliation.
`npm run native:sync` re-registers this app-owned Capacitor bridge after sync;
Capacitor otherwise regenerates its plugin list from npm packages only.

`ios/App/ClarityCaddyWatch` is the companion target. It decodes only schema v1
and displays no-round, Standard, Bubble and hole-map states. It rejects
unsupported schema versions, retains the latest valid context while stale, and
will not replace a scene with an older revision for the same round. It has a
durable command outbox with command-ID deduplication after reconnection, and its
own GPS for `LOCK_AT` and for placing the player on a lite map. It still owns no
golf data: it downloads no course, keeps no round, and every value it draws
comes from the Scene or a package the phone pushed it.

Future Wear OS and Garmin adapters consume the same scene/command/location
contracts. Their platform-specific Data Layer/Connect IQ translation belongs in
those adapters, not in Marshal. Garmin receives simplified geometry only.

## Preserved shot semantics

`LOCK` closes the prior open shot at the supplied accepted location and opens the
next one. `SHOT_END` closes only the final open shot. Bubble is a presentation of
the locked/aiming shot—there is no extra Watch Lock or generic per-shot Log
button. Green Focus and outstanding-shot completion continue to use Marshal's
existing deferred logging model.

## Handover: who is driving

Marshal owns the round on the phone whichever surface the player is looking at.
What changes at a handover is presentation: which surface is **driving**, and
therefore what each screen should say. That answer lives on the Scene as
`surface`, so both ends read one fact and either end may change it:

```text
surface.active    "phone" | "watch"
surface.handover  null | { id, state: "offered" | "confirmed", from: "phone" | "watch" }
surface.watch     { paired, appInstalled, reachable }   -- native's report of the wrist
```

A phone-initiated handover (`caddyWatch.handToWatch()`, the Send to Watch
button) is only **offered** until the Watch answers with a `TAKE_OVER` command
for that handover ID. That answer is what separates a Watch that has the round
from one still in a drawer: the phone's handover screen says "Sending…" or
"Open Clarity Caddy on your Watch" until it arrives, and "Your Watch is driving"
after. A wrist-initiated takeover is confirmed by the asking. `HAND_BACK` from
the wrist and `takeBack()` on the phone return the phone to driving. Surface
commands go through the same command gate as everything else (round ID,
command-ID idempotency) but never reach Marshal, so they cannot be
"marshal-rejected" and LOCK works from the wrist whichever surface is driving.

A handover belongs to one round: it lapses when the round ends and a new round
starts with the phone driving. The Watch answers each offered handover once
(by ID), so a repeated Scene does not become a repeated command.

On the phone `app/js/watch-handover.js` draws one card in the top-right slot of
the play screen (the corner the GPS/demo badges use), with three lives read off
`surface` and the lite-map errand's count (`surface.watch.maps`): **Loading
course · 7 of 18 holes** while the package goes across, **Play on Watch** with a
thumbnail of the hole once it is there (or when there is no package to wait
for), a short **Handing over** spinner while the offer is out, and then, as a
small phone, **Play on phone** while the wrist drives - behind a "Playing on
Watch" mask that dims the map, sits above the dock and Play so a phone in a
pocket cannot be driven by accident, and below the top bar so Back/Home still
work.

The Watch has the same four faces off the same state (`WatchSessionManager.face`):
**Receiving course** with the store's own hole count, **Ready** - the hole drawn
from the delivered map with the wrist's own distance to the green (or the hole's
length before there is a fix) and a **Play here** button, **Taking the round**,
and **Playing** - the numbers face with LOCK and a live dot in the header, with
the map as page two (LOCK flips to it; swiping back unlocks). Either
end can finish the handover: tap the card, or press Play here. Taking the round
back is done from the phone's card. While the wrist drives, the numbers face
uses the wrist's own fix for front/centre/back against the Scene's green
geometry (`WristDistances`), so a phone in the bag showing Preview does not
blank the wrist; the wrist's fix also fills in whenever the phone offers no
distance.

`NativeRoundBridge.watchState` / the `watchState` event supply the rest of
`surface.watch`; `watch-map-delivery.js` reports the count and keeps the fetched
images as thumbnails; the Watch reports `watchMapHave` (live-mirrored, debounced
as holes land) and native relays it as a `watchMapInventory` event so both ends
count the same holes. On web nothing reports a Watch, so none of this UI appears.

Open questions carried from the design: whether the card should offer handover
at the live hole while the rest of the package keeps filling (today it waits for
the whole package), and whether the parked phone-shaped card should retire into
the settings row later in the round (today it stays).
