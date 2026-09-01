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

A manifest hole is `{holeNumber, asset, width, height, spatialReference}`. The
spatial reference is the generator's own `{refZoom, transform{a,b,tx,ty},
imageWidth, imageHeight}`; the Watch re-implements `worldPx` and the similarity
transform to match it exactly, in `Double` throughout — a z20 world pixel is
~2.7e8, so single precision would lose metres inside a 448px image. A package
whose reference version is not 1, or whose transform is degenerate, is refused
rather than drawn against.

Both transports are durable queues, and neither ordering is guaranteed: an image
is filed from its own transfer metadata and reconciled with the manifest
afterwards. The filesystem is the state, so a half-delivered package reports
exactly the holes it has. The Watch reports its inventory back as `watchMapHave`
so the phone re-sends only what is missing; losing that report costs a re-send,
never correctness.

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
