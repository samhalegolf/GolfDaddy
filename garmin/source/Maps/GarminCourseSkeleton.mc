using Toybox.Lang;
using Toybox.Application.Storage;

// The COURSE SKELETON: the least geometry this wrist needs to play every
// hole on its own GPS - front/centre/back, hole length, the layup line and
// the tee zone - when the phone's Scene has gone quiet (a phone in a bag
// that has dropped the link, a dead phone) or has not reached a hole yet.
//
// Built by the phone (app/js/watch-map-delivery.js courseSkeleton) from the
// very references the map package is made of, stamped with that package's
// course key and version, and sent AHEAD of the package's parts as one small
// message (GarminTransport deliverSkeleton, iOS and Android). The session
// only trusts it while it matches both the Scene's course and the map
// package's version (GarminSessionManager.skeletonFor), so it can never put
// a green somewhere the picture under it disagrees with.
//
// Wire form, compact because Connect IQ refuses large messages: points are
// whole MICRODEGREE offsets from `o`, an origin sent as two strings (a
// decimal in a Connect IQ dictionary may arrive as a 32-bit float, ~0.5 m
// out at these latitudes). Per hole: n, len, t (tee), g (green centre),
// s (green outline, flat), r (route between tee and green, flat).
class GarminCourseSkeleton {
    static var STORAGE_KEY = "GarminCourseSkeletonV1";

    var courseKey;
    var version;     // Double: the map package version it was cut from
    var raw;         // the merged wire dictionary, kept for Storage
    var holes;       // Number -> the hole's raw wire entry (decoded on first use)
    var parsed;      // Number -> Dictionary of GarminCoordinates (see parseHole)
    var originLat;
    var originLng;

    function initialize(raw) {
        self.raw = raw;
        courseKey = GarminWire.str(raw, "courseKey");
        version = GarminWire.num(raw, "version");
        holes = {};
        parsed = {};
        var o = GarminWire.arrVal(raw, "o");
        originLat = (o != null && o.size() == 2) ? toDouble(o[0]) : null;
        originLng = (o != null && o.size() == 2) ? toDouble(o[1]) : null;
        var list = GarminWire.arrVal(raw, "holes");
        if (list == null || originLat == null || originLng == null) { return; }
        // Indexed only. Decoding every point of every hole at once tripped
        // the Forerunner 255's watchdog (120k budget) on arrival
        // (2026-10-05); a round only ever needs the hole being played, so
        // each is decoded the first time it is asked for.
        for (var i = 0; i < list.size(); i += 1) {
            var n = (list[i] instanceof Lang.Dictionary) ? GarminWire.intVal(list[i], "n") : null;
            if (n != null && n > 0) { holes[n] = list[i]; }
        }
    }

    function isUsable() { return courseKey != null && version != null && holes.size() > 0; }

    // -------------------------------------------------------------- wire

    static function fromDict(raw) {
        if (!(raw instanceof Lang.Dictionary)) { return null; }
        var s = new GarminCourseSkeleton(raw);
        return s.isUsable() ? s : null;
    }

    // A PART (the link refused the whole course and the phone halved it):
    // its holes merged into this skeleton when course and version match.
    // Returns false when it belongs to a different package.
    function merge(part) {
        if (!courseKey.equals(part.courseKey) || version != part.version) { return false; }
        var mine = GarminWire.arrVal(raw, "holes");
        var theirs = GarminWire.arrVal(part.raw, "holes");
        if (mine == null || theirs == null) { return false; }
        // Only the incoming part's own origin can decode its offsets, and
        // every part of one package is cut against the same origin.
        for (var i = 0; i < theirs.size(); i += 1) {
            var n = (theirs[i] instanceof Lang.Dictionary) ? GarminWire.intVal(theirs[i], "n") : null;
            if (n == null || n <= 0) { continue; }
            if (!holes.hasKey(n)) { mine.add(theirs[i]); }
            holes[n] = theirs[i];
            parsed.remove(n);
        }
        return true;
    }

    function persist() {
        try { Storage.setValue(STORAGE_KEY, raw); } catch (e) { }
    }

    static function restore() {
        var stored = null;
        try { stored = Storage.getValue(STORAGE_KEY); } catch (e) { stored = null; }
        return fromDict(stored);
    }

    // ------------------------------------------------------------- reads

    function hole(n) {
        if (n == null || !holes.hasKey(n)) { return null; }
        if (!parsed.hasKey(n)) { parsed[n] = parseHole(holes[n]); }
        return parsed[n];
    }
    function green(n) { var h = hole(n); return h != null ? h["g"] : null; }
    function tee(n) { var h = hole(n); return h != null ? h["t"] : null; }
    function lengthM(n) { var h = hole(n); return h != null ? h["len"] : null; }

    // Tee, route, green: the hole's fairway line, as the Scene's hole.line.
    // Empty without a tee (a hole whose play line was never mapped).
    function line(n) {
        var h = hole(n);
        if (h == null || h["t"] == null) { return []; }
        var out = [h["t"]];
        var r = h["r"];
        for (var i = 0; i < r.size(); i += 1) { out.add(r[i]); }
        out.add(h["g"]);
        return out;
    }

    // { "front", "centre", "back" } in metres from `from`: the centre is the
    // green point, front and back the nearest and farthest outline points
    // (the phone's own rule); both are the centre when there is no outline.
    function distances(n, from) {
        var h = hole(n);
        if (h == null || from == null) { return null; }
        var centre = GarminGeo.distance(from, h["g"]);
        var front = centre;
        var back = centre;
        var shape = h["s"];
        for (var i = 0; i < shape.size(); i += 1) {
            var d = GarminGeo.distance(from, shape[i]);
            if (d < front) { front = d; }
            if (d > back) { back = d; }
        }
        return { "front" => front, "centre" => centre, "back" => back };
    }

    // ----------------------------------------------------------- helpers

    function parseHole(entry) {
        if (!(entry instanceof Lang.Dictionary)) { return null; }
        var n = GarminWire.intVal(entry, "n");
        var g = point(GarminWire.arrVal(entry, "g"), 0);
        if (n == null || n <= 0 || g == null) { return null; }
        var t = point(GarminWire.arrVal(entry, "t"), 0);
        return {
            "n" => n, "g" => g, "t" => t,
            "len" => GarminWire.num(entry, "len"),
            "s" => points(GarminWire.arrVal(entry, "s")),
            "r" => points(GarminWire.arrVal(entry, "r"))
        };
    }

    function points(flat) {
        var out = [];
        if (flat == null) { return out; }
        for (var i = 0; i + 1 < flat.size(); i += 2) {
            var p = point(flat, i);
            if (p != null) { out.add(p); }
        }
        return out;
    }

    function point(flat, i) {
        if (flat == null || flat.size() < i + 2) { return null; }
        var a = flat[i];
        var b = flat[i + 1];
        if (!(a instanceof Lang.Number or a instanceof Lang.Long or a instanceof Lang.Float or a instanceof Lang.Double)) { return null; }
        if (!(b instanceof Lang.Number or b instanceof Lang.Long or b instanceof Lang.Float or b instanceof Lang.Double)) { return null; }
        return new GarminCoordinate(originLat + a.toDouble() / 1000000.0d, originLng + b.toDouble() / 1000000.0d);
    }

    function toDouble(v) {
        if (v instanceof Lang.String) { return v.toDouble(); }
        if (v instanceof Lang.Number or v instanceof Lang.Long or v instanceof Lang.Float or v instanceof Lang.Double) { return v.toDouble(); }
        return null;
    }
}
