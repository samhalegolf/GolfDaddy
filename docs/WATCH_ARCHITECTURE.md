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

## Native Round Bridge and adapters

`app/js/native-round-bridge.js` is inert on web. On native iOS it hands the
latest scene to `NativeRoundBridge.swift`, which uses WatchConnectivity's latest
application context for presentation and returns Watch messages/user-info as
generic commands. This is the one intended native seam for a future Apple Watch
app, Live Activity, Lock Screen actions, native location and reconciliation.
`npm run native:sync` re-registers this app-owned Capacitor bridge after sync;
Capacitor otherwise regenerates its plugin list from npm packages only.

The first Apple Watch UI target is intentionally not added in this foundation:
the bridge is production-shaped but no untested Watch target is claimed. That
target should render Standard first, then Bubble/Green Focus, and use the same
touch interactions for Lock and tap-to-aim. It must maintain an outbox for
durable Watch commands, retry after reachability changes, and rely on command-ID
deduplication after reconnection.

Future Wear OS and Garmin adapters consume the same scene/command/location
contracts. Their platform-specific Data Layer/Connect IQ translation belongs in
those adapters, not in Marshal. Garmin receives simplified geometry only.

## Preserved shot semantics

`LOCK` closes the prior open shot at the supplied accepted location and opens the
next one. `SHOT_END` closes only the final open shot. Bubble is a presentation of
the locked/aiming shot—there is no extra Watch Lock or generic per-shot Log
button. Green Focus and outstanding-shot completion continue to use Marshal's
existing deferred logging model.
