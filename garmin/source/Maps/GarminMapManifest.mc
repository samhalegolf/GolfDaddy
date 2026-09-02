using Toybox.Lang;

// One course's lite-map package as the phone describes it, baked by
// scripts/gd-watch-map-core.js. Mirrors
// ios/App/ClarityCaddyWatch/WatchMap.swift's WatchMapManifest field-for-field.
// `version` is the generator's millisecond package version and is the whole
// cache key — a regenerated package lands under a new version and never
// overwrites the old one.
class GarminMapManifestHole {
    var holeNumber;
    var asset;
    var url;                 // Garmin-specific addition (plan step 21): where
                              // GarminMapDownloader fetches the raster from —
                              // see GarminMapDownloader.mc for why Garmin
                              // pulls by URL rather than receiving pushed
                              // bytes the way AppleWatchTransport does.
    var width;
    var height;
    var spatialReference;   // GarminMapSpatialReference
    var greenLat;            // hole reference, reduced to what Phase 1 needs
    var greenLng;

    function initialize(holeNumber, asset, url, width, height, spatialReference, greenLat, greenLng) {
        self.holeNumber = holeNumber;
        self.asset = asset;
        self.url = url;
        self.width = width;
        self.height = height;
        self.spatialReference = spatialReference;
        self.greenLat = greenLat;
        self.greenLng = greenLng;
    }
}

class GarminMapManifest {
    var courseKey;
    var version;    // Number (millisecond timestamp) — Monkey C Number is 32-bit;
                     // stored/compared as Double to avoid overflow on a ms epoch.
    var holes;       // Array of GarminMapManifestHole

    function initialize(courseKey, version, holes) {
        self.courseKey = courseKey;
        self.version = version;
        self.holes = holes;
    }

    function hole(number) {
        for (var i = 0; i < holes.size(); i += 1) {
            if (holes[i].holeNumber == number) { return holes[i]; }
        }
        return null;
    }

    // Mirrors WatchMapManifest.isValidAssetName: h<1-2 digits>.webp or .png.
    static function isValidAssetName(name) {
        if (name == null) { return false; }
        var isWebp = name.find(".webp") == name.length() - 5;
        var isPng = name.find(".png") == name.length() - 4;
        if (!isWebp && !isPng) { return false; }
        if (name.substring(0, 1).equals("h") == false) { return false; }
        return true;
    }

    // Mirrors functions/course-watch-maps.mjs's slug(): lowercase
    // alphanumerics and hyphens only.
    static function isValidCourseKey(key) {
        if (key == null) { return false; }
        var len = key.length();
        if (len < 1 || len > 90) { return false; }
        for (var i = 0; i < len; i += 1) {
            var ch = key.substring(i, i + 1);
            var code = ch.toCharArray()[0].toNumber();
            var isLowerAlpha = code >= 'a'.toNumber() && code <= 'z'.toNumber();
            var isDigit = code >= '0'.toNumber() && code <= '9'.toNumber();
            if (!isLowerAlpha && !isDigit && !ch.equals("-")) { return false; }
        }
        return true;
    }

    function isUsable() {
        if (!isValidCourseKey(courseKey)) { return false; }
        if (version == null || version <= 0) { return false; }
        if (holes.size() == 0) { return false; }
        for (var i = 0; i < holes.size(); i += 1) {
            var h = holes[i];
            if (h.holeNumber <= 0) { return false; }
            if (!isValidAssetName(h.asset)) { return false; }
            if (h.spatialReference == null || !h.spatialReference.isUsable()) { return false; }
        }
        return true;
    }

    // Parses the wire Dictionary the phone sends as `watchMapManifest`.
    static function fromDict(raw) {
        if (raw == null) { return null; }
        var courseKey = GarminWire.str(raw, "courseKey");
        var versionNum = GarminWire.num(raw, "version");
        var holesArr = GarminWire.arrVal(raw, "holes");
        if (courseKey == null || versionNum == null || holesArr == null) { return null; }

        var holes = [];
        for (var i = 0; i < holesArr.size(); i += 1) {
            var h = holesArr[i];
            if (!(h instanceof Lang.Dictionary)) { continue; }
            var holeNumber = GarminWire.intVal(h, "holeNumber");
            var asset = GarminWire.str(h, "asset");
            var url = GarminWire.str(h, "url");
            var width = GarminWire.num(h, "width");
            var height = GarminWire.num(h, "height");
            var srDict = GarminWire.dictVal(h, "spatialReference");
            var sr = GarminMapSpatialReference.fromDict(srDict);
            if (holeNumber == null || asset == null || width == null || height == null || sr == null) { continue; }

            var greenLat = null;
            var greenLng = null;
            var refDict = GarminWire.dictVal(h, "reference");
            if (refDict != null) {
                var greenDict = GarminWire.dictVal(refDict, "green");
                if (greenDict != null) {
                    greenLat = GarminWire.num(greenDict, "lat");
                    greenLng = GarminWire.num(greenDict, "lng");
                }
            }

            holes.add(new GarminMapManifestHole(holeNumber, asset, url, width, height, sr, greenLat, greenLng));
        }
        return new GarminMapManifest(courseKey, versionNum, holes);
    }
}
