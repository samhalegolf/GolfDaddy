using Toybox.Lang;
using Toybox.System;

// The existing, platform-neutral wearable command vocabulary. Mirrors
// ios/App/ClarityCaddyWatch/WatchScene.swift's CaddyWatchCommand exactly —
// same type strings, same payload shapes. Per the Garmin Phase 1 plan step 7:
// Garmin sends LOCK/UNLOCK/LOCK_AT/AIM_AT/VIEW_PREVIOUS_HOLE/VIEW_NEXT_HOLE/
// TAKE_OVER/HAND_BACK, never a GARMIN_-prefixed vocabulary of its own — the
// command describes the golfer's intent, not the device.
module GarminCommandKind {
    var LOCK = "LOCK";
    var UNLOCK = "UNLOCK";
    var PREVIOUS_HOLE = "VIEW_PREVIOUS_HOLE";
    var NEXT_HOLE = "VIEW_NEXT_HOLE";
    var LOCK_AT = "LOCK_AT";
    var AIM_AT = "AIM_AT";
    var TAKE_OVER = "TAKE_OVER";
    var HAND_BACK = "HAND_BACK";
}

// One command, ready to serialise to a Dictionary for Communications.transmit.
// `device` is app/js/marshal.js's free-form field (not schema-gated) — see
// garmin/README.md — so "garmin" is a valid value with no phone-side change.
class GarminCommand {
    var commandId;
    var roundId;
    var baseRevision;
    var createdAt;    // epoch millis, Double
    var device;
    var type;         // one of GarminCommandKind
    // payload: either a location observation (LOCK_AT) or a point (AIM_AT),
    // matching CommandPayload's two optional fields.
    var payloadLocation;   // Dictionary or null: { coordinate, source, horizontalAccuracy, timestamp }
    var payloadPoint;      // GarminCoordinate or null

    function initialize(commandId, roundId, baseRevision, createdAt, type, payloadLocation, payloadPoint) {
        self.commandId = commandId;
        self.roundId = roundId;
        self.baseRevision = baseRevision;
        self.createdAt = createdAt;
        self.device = "garmin";
        self.type = type;
        self.payloadLocation = payloadLocation;
        self.payloadPoint = payloadPoint;
    }

    // The wire Dictionary, ready to hand to Communications.transmit wrapped
    // as { "command" => wire() } — matching NativeRoundBridge's
    // acknowledgeCommand/watchCommand event shape exactly.
    function wire() {
        var payload = {};
        if (payloadLocation != null) { payload["location"] = payloadLocation; }
        if (payloadPoint != null) { payload["point"] = { "lat" => payloadPoint.lat, "lng" => payloadPoint.lng }; }
        return {
            "commandId" => commandId,
            "roundId" => roundId,
            "baseRevision" => baseRevision,
            "createdAt" => createdAt,
            "device" => device,
            "type" => type,
            "payload" => payload
        };
    }

    // Rebuild from a persisted Dictionary (Application.Storage round-trip).
    static function fromDict(dict) {
        var payload = GarminWire.dictVal(dict, "payload");
        var location = payload != null ? GarminWire.dictVal(payload, "location") : null;
        var point = payload != null ? GarminWire.coordinate(GarminWire.dictVal(payload, "point")) : null;
        var cmd = new GarminCommand(
            GarminWire.str(dict, "commandId"),
            GarminWire.str(dict, "roundId"),
            GarminWire.intVal(dict, "baseRevision"),
            GarminWire.num(dict, "createdAt"),
            GarminWire.str(dict, "type"),
            location,
            point
        );
        return cmd;
    }
}

// Mirrors the shape locationObservation() in app/js/caddy-watch.js and
// observationPoint() in app/js/marshal.js validate: coordinate, source
// (must be exactly "garmin" — see garmin/README.md), horizontalAccuracy
// (<=100m), timestamp (<=5min old on the phone's clock, so Garmin only needs
// to send an honest epoch-millis timestamp).
module GarminLocationObservation {
    // Builds the wire Dictionary for a LOCK_AT payload.location, or null if
    // the fix is not trustworthy enough to send — mirrors
    // WatchLocationObservation's Apple init(_:maxAgeSeconds:).
    function build(coordinate, horizontalAccuracy, fixEpochMillis, nowEpochMillis, maxAgeSeconds) {
        if (coordinate == null) { return null; }
        if (horizontalAccuracy == null || horizontalAccuracy < 0 || horizontalAccuracy > 100) { return null; }
        if (fixEpochMillis == null) { return null; }
        var ageSeconds = (nowEpochMillis - fixEpochMillis) / 1000.0;
        if (ageSeconds > maxAgeSeconds) { return null; }
        return {
            "coordinate" => { "lat" => coordinate.lat, "lng" => coordinate.lng },
            "source" => "garmin",
            "horizontalAccuracy" => horizontalAccuracy,
            "timestamp" => fixEpochMillis
        };
    }
}

// Mirrors WatchCommandAcknowledgement — the only authoritative outcome of a
// command. Native transport (GarminTransport, on the phone) never infers
// success; this is what Marshal decided.
class GarminAcknowledgement {
    var commandId;
    var accepted;
    var reason;      // String or null
    var revision;    // Number or null

    function initialize(dict) {
        commandId = GarminWire.str(dict, "commandId");
        var a = GarminWire.boolVal(dict, "accepted");
        accepted = (a == null) ? false : a;
        reason = GarminWire.str(dict, "reason");
        revision = GarminWire.intVal(dict, "revision");
    }
}
