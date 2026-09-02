using Toybox.Lang;
using Toybox.Math;

// The player half of what Garmin needs: the playable bag and the saved My
// Bubble, in one small versioned payload. Mirrors
// ios/WatchBubbleEngine/Sources/WatchBubbleEngine/PlayerSnapshot.swift
// exactly, including the fingerprint format — it MUST match
// watchPlayerFingerprint() in app/js/watch-player-delivery.js byte for byte,
// pinned against shared cases in dev/fixtures/bubble-engine-parity.json. A
// quiet disagreement here means the phone re-sends a bag Garmin already has
// on every Scene, or worse, never re-sends one it does not.
//
// CHANGE DETECTION IS A FINGERPRINT, NOT A COUNTER — derived from the
// content itself, so "has this changed" is answerable by either end with no
// memory of what went before.
class GarminPlayerSnapshot {
    static var SUPPORTED_VERSION = 1;

    var version;
    var fingerprint;
    var bag;              // GarminBagSnapshot
    var bubble;            // GarminMyBubble
    var engineVersion;

    function initialize(version, fingerprint, bag, bubble, engineVersion) {
        self.version = version;
        self.fingerprint = fingerprint;
        self.bag = bag;
        self.bubble = bubble;
        self.engineVersion = engineVersion;
    }

    // A snapshot is usable when it is this schema, its fingerprint matches
    // its own contents, and its bag is not empty. Recomputing the
    // fingerprint is the integrity check: a payload that lost clubs
    // crossing Communications.transmit and Application.Storage would
    // otherwise be cached and played on — a silently short bag picks the
    // wrong club for every shot.
    function isUsable() {
        if (version != SUPPORTED_VERSION) { return false; }
        if (bag.byLengthDescending().size() == 0) { return false; }
        if (engineVersion == null || engineVersion.length() == 0) { return false; }
        return fingerprint.equals(computeFingerprint(bag, bubble, engineVersion));
    }

    // Shape: v1|g<0|1>|<club>:<carry>:<total>|...|b:<deg|->:<hand>|e:<engine>
    // Clubs emitted longest-total-first (the bag's own order), so a bag that
    // merely arrived shuffled has the same fingerprint. Distances rounded to
    // whole metres — that is the precision the bag is edited/displayed in.
    // "-" for the aim means NO My Bubble, distinct from "0" (a real,
    // saved, zero-degree aim).
    static function computeFingerprint(bag, bubble, engineVersion) {
        var parts = ["v1", bag.isGhost ? "g1" : "g0"];
        var rows = bag.byLengthDescending();
        for (var i = 0; i < rows.size(); i += 1) {
            var c = rows[i];
            parts.add(c.club + ":" + roundedInt(c.carryM) + ":" + roundedInt(c.totalM));
        }
        var aim;
        if (bubble.offsetDeg != null) {
            aim = formatFixed2(bubble.offsetDeg);
        } else {
            aim = "-";
        }
        parts.add("b:" + aim + ":" + bubble.handedness);
        parts.add("e:" + engineVersion);
        return joinWith(parts, "|");
    }

    static function roundedInt(value) {
        return Math.round(value).toNumber();
    }

    // %.2f equivalent — Monkey C's Lang.format supports fixed-decimal via
    // "%.2f"-style specifiers on most API levels; this hand-rolls it to
    // avoid depending on a format-string feature that may differ by SDK
    // version, matching an existing sign explicitly rather than relying on
    // a locale-sensitive formatter.
    static function formatFixed2(value) {
        var sign = value < 0 ? "-" : "";
        var v = value < 0 ? -value : value;
        var scaled = Math.round(v * 100.0).toNumber();
        var whole = scaled / 100;
        var frac = scaled % 100;
        var fracStr = frac < 10 ? ("0" + frac) : frac.toString();
        return sign + whole.toString() + "." + fracStr;
    }

    static function joinWith(parts, sep) {
        var out = "";
        for (var i = 0; i < parts.size(); i += 1) {
            out += parts[i];
            if (i < parts.size() - 1) { out += sep; }
        }
        return out;
    }

    // What Garmin reports back so the phone can skip a re-send.
    function inventory() {
        return { "fingerprint" => fingerprint };
    }

    // Parses the wire Dictionary the phone sends as `watchPlayer`. Mirrors
    // WatchPlayerSnapshot/WatchBagSnapshot/WatchBubbleProfile's tolerant
    // decode: a malformed field becomes an absent one rather than rejecting
    // the whole payload outright (isUsable() below is the real gate).
    static function fromDict(raw) {
        if (raw == null) { return null; }
        var version = GarminWire.intVal(raw, "version");
        if (version == null) { version = 1; }
        var fingerprint = GarminWire.str(raw, "fingerprint");
        var engineVersion = GarminWire.str(raw, "engineVersion");

        var bagDict = GarminWire.dictVal(raw, "bag");
        var bag = parseBag(bagDict);

        var bubbleDict = GarminWire.dictVal(raw, "bubble");
        var bubble = parseBubble(bubbleDict);

        if (fingerprint == null || bag == null || bubble == null) { return null; }
        return new GarminPlayerSnapshot(version, fingerprint, bag, bubble, engineVersion);
    }

    static function parseBag(dict) {
        if (dict == null) { return null; }
        var version = GarminWire.intVal(dict, "version");
        if (version == null) { version = 1; }
        var isGhost = GarminWire.boolVal(dict, "isGhost");
        if (isGhost == null) { isGhost = false; }
        var clubsArr = GarminWire.arrVal(dict, "clubs");
        var clubs = [];
        if (clubsArr != null) {
            for (var i = 0; i < clubsArr.size(); i += 1) {
                var c = clubsArr[i];
                if (!(c instanceof Lang.Dictionary)) { continue; }
                var club = GarminWire.str(c, "club");
                var carryM = GarminWire.num(c, "carryM");
                var totalM = GarminWire.num(c, "totalM");
                if (club != null && carryM != null && totalM != null) {
                    clubs.add(new GarminClub(club, carryM, totalM));
                }
            }
        }
        return new GarminBagSnapshot(version, clubs, isGhost);
    }

    static function parseBubble(dict) {
        var version = 1;
        var offsetDeg = null;
        var handedness = "right";
        if (dict != null) {
            var v = GarminWire.intVal(dict, "version");
            if (v != null) { version = v; }
            offsetDeg = GarminWire.num(dict, "offsetDeg");
            var h = GarminWire.str(dict, "handedness");
            if (h != null) { handedness = h; }
        }
        return new GarminMyBubble(version, offsetDeg, handedness);
    }
}
