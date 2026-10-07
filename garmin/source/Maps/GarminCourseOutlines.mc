using Toybox.Lang;
using Toybox.Application.Storage;

// The hole OUTLINES and TERRAIN: fairways, bunkers, water, trees (k), hazards
// (h, gorse/scrub), waste areas (z) and the green as
// rounded closed rings (scripts/gd-watch-map-core.js buildHoleOutlines), and
// the ground's light and shadow as rounded pieces that slot together
// (scripts/gd-watch-terrain-core.js) - all in whole IMAGE pixels of the map
// package they were cut from. The map face draws them itself, in the package
// palette, whenever it has no picture for a hole: the image needs Garmin's
// image service and the phone's internet; these came over the same link as
// the manifest.
//
// The phone sends one `courseOutlines` message per hole after the manifest
// parts, then the hole's terrain in further messages marked `part`, which are
// appended (GarminTransport deliverOutlines). Rings are delta-encoded: the
// first point absolute, each later one a step from the last. A terrain piece
// carries its label first: surface * 3 + shade (0 dark / 1 the surface's own
// colour - a hole in a piece / 2 lit; surfaces 0 rough, 1 fairway, 2 green).
//
// Each hole is stored under its own key: a hilly course is ~60 KB in all,
// and one Storage value that size is more than some watches allow.
//
// Pixels only mean something against the exact package they were cut from,
// so the session uses a hole only while course AND version match the manifest
// held (GarminSessionManager.outlinesFor).
class GarminCourseOutlines {
    static var INDEX_KEY = "GarminCourseOutlinesV2";
    static var HOLE_KEY = "GarminCourseOutlinesV2_h";

    var courseKey = null;
    var version = null;
    var held = {};           // Number -> true: holes in Storage
    var decodedHole = null;  // the one hole kept decoded (see hole)
    var decoded = null;

    function initialize() {
        var stored = null;
        try { stored = Storage.getValue(INDEX_KEY); } catch (e) { stored = null; }
        if (stored instanceof Lang.Dictionary) {
            courseKey = GarminWire.str(stored, "courseKey");
            version = GarminWire.num(stored, "version");
            var list = GarminWire.arrVal(stored, "holes");
            if (list != null) {
                for (var i = 0; i < list.size(); i += 1) {
                    if (list[i] instanceof Lang.Number) { held[list[i]] = true; }
                }
            }
        }
    }

    // One message. A different course or version starts over.
    function receive(raw) {
        var key = GarminWire.str(raw, "courseKey");
        var v = GarminWire.num(raw, "version");
        var n = GarminWire.intVal(raw, "n");
        if (key == null || v == null || n == null || n <= 0) { return; }
        if (courseKey == null || !courseKey.equals(key) || version != v) {
            var old = held.keys();
            for (var i = 0; i < old.size(); i += 1) {
                try { Storage.deleteValue(HOLE_KEY + old[i]); } catch (e) { }
            }
            courseKey = key;
            version = v;
            held = {};
        }
        var incoming = {
            "f" => rings(GarminWire.arrVal(raw, "f"), 6),
            "b" => rings(GarminWire.arrVal(raw, "b"), 6),
            "w" => rings(GarminWire.arrVal(raw, "w"), 6),
            "k" => rings(GarminWire.arrVal(raw, "k"), 6),
            "h" => rings(GarminWire.arrVal(raw, "h"), 6),
            "z" => rings(GarminWire.arrVal(raw, "z"), 6),
            "g" => GarminWire.arrVal(raw, "g"),
            "t" => rings(GarminWire.arrVal(raw, "t"), 7),
            "c" => trees(GarminWire.arrVal(raw, "c"))
        };
        var isPart = GarminWire.boolVal(raw, "part");
        var current = (isPart != null && isPart) ? stored(n) : null;
        if (current != null) {
            current["f"].addAll(incoming["f"]);
            current["b"].addAll(incoming["b"]);
            current["w"].addAll(incoming["w"]);
            current["k"].addAll(incoming["k"]);
            current["h"].addAll(incoming["h"]);
            current["z"].addAll(incoming["z"]);
            current["t"].addAll(incoming["t"]);
            current["c"].addAll(incoming["c"]);
            if (current["g"] == null && incoming["g"] != null) { current["g"] = incoming["g"]; }
        } else {
            current = incoming;
        }
        try { Storage.setValue(HOLE_KEY + n, current); } catch (e) { }
        held[n] = true;
        if (decodedHole == n) { decodedHole = null; decoded = null; }
        try { Storage.setValue(INDEX_KEY, { "courseKey" => courseKey, "version" => version, "holes" => held.keys() }); } catch (e) { }
    }

    function stored(n) {
        if (!held.hasKey(n)) { return null; }
        var value = null;
        try { value = Storage.getValue(HOLE_KEY + n); } catch (e) { value = null; }
        if (!(value instanceof Lang.Dictionary)) { return null; }
        // Holes stored before a layer existed simply have none of it.
        var layers = ["t", "k", "h", "z", "c"];
        for (var i = 0; i < layers.size(); i += 1) {
            if (!value.hasKey(layers[i]) || value[layers[i]] == null) { value[layers[i]] = []; }
        }
        return value;
    }

    // The hole decoded and ready to place, or null:
    // { "f"/"b"/"w"/"k"/"h"/"z" => [ring...], "g" => ring or null, "t" => [piece...],
    //   "c" => [packed tree...] }
    // where a ring is { "p" => [x0, y0, ...] absolute image px, "box" => [minX, minY, maxX, maxY] }
    // and a piece is a ring with "label". Only the hole being drawn is kept.
    function hole(n) {
        if (n == null || !held.hasKey(n)) { return null; }
        if (decodedHole != n) {
            var raw = stored(n);
            if (raw == null) { return null; }
            decoded = {
                "f" => decodeAll(raw["f"], false), "b" => decodeAll(raw["b"], false), "w" => decodeAll(raw["w"], false),
                "k" => decodeAll(raw["k"], false), "h" => decodeAll(raw["h"], false), "z" => decodeAll(raw["z"], false),
                "g" => (raw["g"] != null) ? decodeRing(raw["g"], 0) : null,
                "t" => decodeAll(raw["t"], true),
                // Trees stay packed (scripts/gd-watch-map-core.js packTree): one
                // Number each, unpacked as they are drawn (GarminTreeSprites).
                "c" => raw["c"]
            };
            decodedHole = n;
        }
        return decoded;
    }

    // The hole's trees, packed one per Number (x + y*2048 + r*2^22 + type*2^29).
    function trees(list) {
        var out = [];
        if (list == null) { return out; }
        for (var i = 0; i < list.size(); i += 1) {
            if (list[i] instanceof Lang.Number && list[i] >= 0) { out.add(list[i]); }
        }
        return out;
    }

    function rings(list, minimum) {
        var out = [];
        if (list == null) { return out; }
        for (var i = 0; i < list.size(); i += 1) {
            if (list[i] instanceof Lang.Array && list[i].size() >= minimum) { out.add(list[i]); }
        }
        return out;
    }

    function decodeAll(list, labelled) {
        var out = [];
        for (var i = 0; i < list.size(); i += 1) {
            var r = decodeRing(list[i], labelled ? 1 : 0);
            if (r != null) {
                if (labelled) { r["label"] = list[i][0].toNumber(); }
                out.add(r);
            }
        }
        return out;
    }

    // Undoes the delta encoding from `start`, and boxes the ring so a draw
    // can skip what is off screen without touching its points.
    function decodeRing(ring, start) {
        if (!(ring instanceof Lang.Array) || ring.size() - start < 6) { return null; }
        var count = ring.size() - start;
        var out = new [count];
        var x = 0;
        var y = 0;
        var minX = 99999;
        var minY = 99999;
        var maxX = -99999;
        var maxY = -99999;
        for (var i = 0; i + 1 < count; i += 2) {
            x += ring[start + i].toNumber();
            y += ring[start + i + 1].toNumber();
            out[i] = x;
            out[i + 1] = y;
            if (x < minX) { minX = x; }
            if (x > maxX) { maxX = x; }
            if (y < minY) { minY = y; }
            if (y > maxY) { maxY = y; }
        }
        return { "p" => out, "box" => [minX, minY, maxX, maxY] };
    }
}
