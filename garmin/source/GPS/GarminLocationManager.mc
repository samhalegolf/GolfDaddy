using Toybox.System;
using Toybox.Lang;
using Toybox.Position;
using Toybox.Time;

// Keeps one fresh, best-effort GPS fix while a round is live, so LOCK can
// mark the ball from Garmin's own position. Mirrors
// ios/App/ClarityCaddyWatch/WatchSessionManager.swift's WatchLocationManager:
// foreground-only, no background location mode — no golf-state transitions
// belong here, only a fix.
//
// Trust bound: only a fix with horizontalAccuracy in [0, 100] metres reaches
// `onFix`, the same 100m bound app/js/caddy-watch.js's locationObservation()
// and app/js/marshal.js's observationPoint() both enforce server-side for
// LOCK_AT. A less accurate fix is worse than none: it would place the player
// in a neighbouring fairway.
class GarminLocationManager {
    var lastFix;              // GarminCoordinate or null
    var lastAccuracy;         // Number/Double metres, or null
    var lastFixEpochMillis;   // Double, or null

    // Callback: onFix(coordinate, accuracyMetres, epochMillis) — coordinate
    // is null when a fix is unusable (mirrors CLLocation delegate's
    // usable-vs-not split, so callers do not have to re-check accuracy).
    var onFix;

    var started;

    function initialize() {
        lastFix = null;
        lastAccuracy = null;
        lastFixEpochMillis = null;
        started = false;
    }

    function start() {
        if (started) { return; }
        started = true;
        try {
            Position.enableLocationEvents(Position.LOCATION_CONTINUOUS, method(:onPositionInfo));
            if (GarminTransmitPolicy.muted()) { System.println("location events enabled"); }
            // Seed from the device's current answer rather than waiting for
            // the first event. On a watch that is the last known fix, which
            // the accuracy bound below will usually refuse until GPS is warm
            // - harmless. In the simulator it is the only fix there is:
            // Settings > Set Position answers getInfo() but never raises an
            // event, so without this read the wrist never has a position.
            poll();
        } catch (e) {
            started = false;
            if (GarminTransmitPolicy.muted()) { System.println("location enable threw: " + e.getErrorMessage()); }
        }
    }

    function stop() {
        if (!started) { return; }
        started = false;
        try {
            Position.enableLocationEvents(Position.LOCATION_DISABLE, method(:onPositionInfo));
        } catch (e) {
            // best-effort
        }
        lastFix = null;
        lastAccuracy = null;
        lastFixEpochMillis = null;
        eventSeen = false;
        if (onFix != null) { onFix.invoke(null, null, null); }
    }

    var eventSeen = false;   // a real event has arrived; polling can stop

    // Reads the device's current answer once, until the event stream has
    // delivered anything. Called from start() and on every Scene, because
    // the simulator's Settings > Set Position only ever answers this read
    // and never raises an event (2026-09-21); a real watch answers with its
    // last known fix and then takes over with events, at which point this
    // is a no-op.
    function poll() {
        if (!started || eventSeen) { return; }
        try {
            var info = Position.getInfo();
            if (info != null) { onPositionInfo(info); }
        } catch (e) {
            // best-effort; the event stream is the real source
        }
        eventSeen = false; // the read above is not an event
    }

    // Typed: Position.enableLocationEvents wants Method(loc as Position.Info) as Void.
    function onPositionInfo(info as Position.Info) as Void {
        eventSeen = true;
        if (info == null || info.position == null) { return; }
        var degrees = info.position.toDegrees(); // [lat, lng] in decimal degrees
        // The simulator reports 180,180 when it has no position at all; a
        // watch never produces a latitude beyond the poles either way.
        if (degrees[0] > 90.0 || degrees[0] < -90.0 || degrees[1] > 180.0 || degrees[1] < -180.0) { return; }
        var coordinate = new GarminCoordinate(degrees[0], degrees[1]);
        // Position.Info.accuracy is a coarse enum on many CIQ API levels
        // (Position.QUALITY_*) rather than a metre figure; where a device
        // reports it as metres this uses it directly, otherwise it falls
        // back to a conservative estimate per quality band so the same
        // <=100m trust bound the phone enforces still applies. Verify
        // Position.Info's exact accuracy field against the installed SDK —
        // this is one of the pieces flagged unverified in garmin/README.md.
        var accuracyM = estimateAccuracyMetres(info);
        var nowMs = Time.now().value() * 1000.0;
        // Simulator-only trace, once per accuracy change; compiled out of
        // live builds. Says what the simulator actually delivers.
        if (GarminTransmitPolicy.muted() && (lastAccuracy == null || accuracyM == null || lastAccuracy != accuracyM)) {
            System.println("position event: " + degrees[0] + "," + degrees[1] + " raw accuracy=" + ((info has :accuracy) ? info.accuracy : "n/a") + " -> " + accuracyM + "m");
        }

        lastFixEpochMillis = nowMs;
        lastAccuracy = accuracyM;

        var usable = accuracyM != null && accuracyM >= 0 && accuracyM <= 100;
        lastFix = usable ? coordinate : null;

        if (onFix != null) {
            onFix.invoke(usable ? coordinate : null, accuracyM, nowMs);
        }
    }

    function estimateAccuracyMetres(info) {
        // Newer Connect IQ API levels expose Position.Info.accuracy as a
        // metre figure (Float); older ones expose only a quality enum
        // (Position.QUALITY_GOOD / QUALITY_USABLE / QUALITY_POOR /
        // QUALITY_NOT_AVAILABLE / QUALITY_LAST_KNOWN). Handle both so this
        // compiles across the Phase 1 device matrix's API level spread.
        if (info has :accuracy && info.accuracy != null && !(info.accuracy instanceof Lang.Number)) {
            return info.accuracy;
        }
        if (info has :accuracy && info.accuracy != null) {
            if (info.accuracy == Position.QUALITY_GOOD) { return 8.0; }
            if (info.accuracy == Position.QUALITY_USABLE) { return 25.0; }
            if (info.accuracy == Position.QUALITY_POOR) { return 75.0; }
            if (info.accuracy == Position.QUALITY_LAST_KNOWN) { return null; }
            return null; // QUALITY_NOT_AVAILABLE or unrecognised
        }
        return null;
    }
}
