using Toybox.Lang;

// Mirrors CaddyWatchScene v1 exactly as
// ios/App/ClarityCaddyWatch/WatchScene.swift does. All display values are
// optional because the phone may legitimately have a partial course package
// or no Bubble model. Wraps the raw Dictionary rather than copying every
// field into typed properties up front — Monkey C has no Codable, and the
// scene arrives many times a minute, so accessors read straight through to
// the wire on demand.
class GarminScene {
    static var SUPPORTED_SCHEMA_VERSION = 1;

    var raw;   // the raw Dictionary this Scene was built from

    function initialize(raw) {
        self.raw = raw;
    }

    function schemaVersion() { return GarminWire.intVal(raw, "schemaVersion"); }
    function isSupported() { return schemaVersion() == SUPPORTED_SCHEMA_VERSION; }

    function roundId() { return GarminWire.str(raw, "roundId"); }
    function hasRound() { var id = roundId(); return id != null && id.length() > 0; }
    function revision() { var r = GarminWire.intVal(raw, "revision"); return (r != null) ? r : 0; }
    function mode() { return GarminWire.str(raw, "mode"); }
    function isBubbleMode() { var m = mode(); return m != null && m.equals("bubble") && bubbleDict() != null; }

    function courseDict() { return GarminWire.dictVal(raw, "course"); }
    function courseKey() { var c = courseDict(); return c != null ? GarminWire.str(c, "key") : null; }

    function holeDict() { return GarminWire.dictVal(raw, "hole"); }
    function holeNumber() { var h = holeDict(); return h != null ? GarminWire.intVal(h, "number") : null; }
    function holePar() { var h = holeDict(); return h != null ? GarminWire.intVal(h, "par") : null; }
    function holeTeeToGreenM() { var h = holeDict(); return h != null ? GarminWire.num(h, "teeToGreenM") : null; }

    function distanceDict() { return GarminWire.dictVal(raw, "distance"); }
    function distanceTargetM() { var d = distanceDict(); return d != null ? GarminWire.num(d, "target") : null; }
    function distanceFrontM() { var d = distanceDict(); return d != null ? GarminWire.num(d, "front") : null; }
    function distanceCentreM() { var d = distanceDict(); return d != null ? GarminWire.num(d, "centre") : null; }
    function distanceBackM() { var d = distanceDict(); return d != null ? GarminWire.num(d, "back") : null; }

    function suggestionDict() { return GarminWire.dictVal(raw, "suggestion"); }
    function suggestedClub() { var s = suggestionDict(); return s != null ? GarminWire.str(s, "club") : null; }
    function suggestedCarryM() { var s = suggestionDict(); return s != null ? GarminWire.num(s, "carryM") : null; }
    function suggestedTotalM() { var s = suggestionDict(); return s != null ? GarminWire.num(s, "totalM") : null; }

    function target() { return GarminWire.coordinate(GarminWire.dictVal(raw, "target")); }

    function locationDict() { return GarminWire.dictVal(raw, "location"); }
    function phoneLocation() { var l = locationDict(); return l != null ? GarminWire.coordinate(GarminWire.dictVal(l, "coordinate")) : null; }

    function bubbleDict() { return GarminWire.dictVal(raw, "bubble"); }
    function bubbleEngineVersion() { var b = bubbleDict(); return b != null ? GarminWire.str(b, "engineVersion") : null; }
    function bubbleCentre() { var b = bubbleDict(); return b != null ? GarminWire.coordinate(GarminWire.dictVal(b, "centre")) : null; }
    function bubbleWidthM() { var b = bubbleDict(); return b != null ? GarminWire.num(b, "widthM") : null; }
    function bubbleDepthM() { var b = bubbleDict(); return b != null ? GarminWire.num(b, "depthM") : null; }
    function bubbleTiltDeg() { var b = bubbleDict(); return b != null ? GarminWire.num(b, "tiltDeg") : null; }
    function bubbleClub() { var b = bubbleDict(); return b != null ? GarminWire.str(b, "club") : null; }

    // Default aim target: an explicit target, falling back to the Bubble's
    // own centre — same fallback WatchSessionManager.localBubble uses.
    function aimTarget() {
        var t = target();
        if (t != null) { return t; }
        return bubbleCentre();
    }

    function controlsDict() { return GarminWire.dictVal(raw, "controls"); }
    function canLock() { var c = controlsDict(); var v = c != null ? GarminWire.boolVal(c, "canLock") : null; return v == null ? false : v; }
    function canUnlock() { var c = controlsDict(); var v = c != null ? GarminWire.boolVal(c, "canUnlock") : null; return v == null ? false : v; }
    function canAim() { var c = controlsDict(); var v = c != null ? GarminWire.boolVal(c, "canAim") : null; return v == null ? false : v; }
    function canPreviousHole() { var c = controlsDict(); var v = c != null ? GarminWire.boolVal(c, "canPreviousHole") : null; return v == null ? false : v; }
    function canNextHole() { var c = controlsDict(); var v = c != null ? GarminWire.boolVal(c, "canNextHole") : null; return v == null ? false : v; }

    function surfaceDict() { return GarminWire.dictVal(raw, "surface"); }
    function surfaceActive() { var s = surfaceDict(); return s != null ? GarminWire.str(s, "active") : null; }
    // "watch" means A wrist is driving — Apple Watch or Garmin alike. See
    // garmin/README.md for why this stays coarse-grained in Phase 1: no
    // schema migration is required for Garmin to participate.
    function isDriving() { var a = surfaceActive(); return a != null && a.equals("watch"); }

    function handoverDict() { var s = surfaceDict(); return s != null ? GarminWire.dictVal(s, "handover") : null; }
    function handoverId() { var h = handoverDict(); return h != null ? GarminWire.str(h, "id") : null; }
    function handoverState() { var h = handoverDict(); return h != null ? GarminWire.str(h, "state") : null; }
    function handoverFrom() { var h = handoverDict(); return h != null ? GarminWire.str(h, "from") : null; }
}
