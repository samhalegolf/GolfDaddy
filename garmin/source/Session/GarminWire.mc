using Toybox.Lang;

// Small safety helpers for reading untrusted Dictionaries off the wire
// (Communications messages, Storage reads). Connect IQ hands these back as
// plain Lang.Dictionary with no schema, the same trust boundary
// NativeRoundBridge's `withoutNulls` and WatchScene's tolerant Codable
// decoding sit at on iOS — a malformed field must become an absent one, not
// crash the whole payload.
module GarminWire {

    function str(dict, key) {
        if (dict == null || !(dict instanceof Lang.Dictionary) || !dict.hasKey(key)) { return null; }
        var v = dict[key];
        return (v instanceof Lang.String) ? v : null;
    }

    function num(dict, key) {
        if (dict == null || !(dict instanceof Lang.Dictionary) || !dict.hasKey(key)) { return null; }
        var v = dict[key];
        if (v instanceof Lang.Number or v instanceof Lang.Long) { return v.toDouble(); }
        if (v instanceof Lang.Float or v instanceof Lang.Double) { return v.toDouble(); }
        return null;
    }

    function intVal(dict, key) {
        var n = num(dict, key);
        return (n != null) ? n.toNumber() : null;
    }

    function boolVal(dict, key) {
        if (dict == null || !(dict instanceof Lang.Dictionary) || !dict.hasKey(key)) { return null; }
        var v = dict[key];
        return (v instanceof Lang.Boolean) ? v : null;
    }

    function dictVal(dict, key) {
        if (dict == null || !(dict instanceof Lang.Dictionary) || !dict.hasKey(key)) { return null; }
        var v = dict[key];
        return (v instanceof Lang.Dictionary) ? v : null;
    }

    function arrVal(dict, key) {
        if (dict == null || !(dict instanceof Lang.Dictionary) || !dict.hasKey(key)) { return null; }
        var v = dict[key];
        return (v instanceof Lang.Array) ? v : null;
    }

    // A GeoPoint-shaped { "lat" => Number, "lng" => Number } to a
    // GarminCoordinate, or null if either half is missing/non-finite.
    function coordinate(dict) {
        if (dict == null) { return null; }
        var lat = num(dict, "lat");
        var lng = num(dict, "lng");
        if (lat == null || lng == null) { return null; }
        return new GarminCoordinate(lat, lng);
    }
}
