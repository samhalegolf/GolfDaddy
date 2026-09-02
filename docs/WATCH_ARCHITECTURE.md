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
with LOCK one tap away. Nothing on the Watch decides anything about the round —
the green comes from the Scene, the aim point comes from the Scene, and the
player is the wrist's own fix (or the phone's when the wrist has none). A hole
with no delivered image shows why, not a blank.

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
and **Playing** - the numbers face with LOCK and a live dot in the header. Either
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
