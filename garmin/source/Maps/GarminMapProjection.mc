using Toybox.Lang;
using Toybox.Math;

// The Garmin half of the "lite map" contract baked by
// scripts/gd-watch-map-core.js. Mirrors
// ios/App/ClarityCaddyWatch/WatchMap.swift's WatchMapSpatialReference line
// for line — worldPixel/imagePoint/coordinate are a deliberate copy of the
// generator's worldPx/applyTransform/invertTransform. If these two ever
// disagree the marker lands in the wrong place with no error to show for
// it, so the maths is copied rather than approximated, matching
// dev/watch-map-projection.test.js's pinned numbers on the JavaScript side.
//
// Everything is Double, never a 32-bit Number/Float: a z20 world pixel is
// ~2.7e8 and the transform's translation terms are larger still, so
// anything less than double precision loses metres of accuracy inside an
// image only a few hundred pixels wide.
class GarminMapSpatialReference {
    static var SUPPORTED_VERSION = 1;
    static var TILE_SIZE = 256.0;
    static var MAX_MERCATOR_LATITUDE = 85.05112878;

    var version;
    var refZoom;
    var a;
    var b;
    var tx;
    var ty;
    var imageWidth;
    var imageHeight;
    // Both optional on the wire, matching WatchMapSpatialReference.swift.
    // metresPerPixel feeds GarminMapCamera's nominal-Bubble-extent fallback
    // (GarminMapView.restingCamera) when no ring has been computed yet.
    var rotationDegrees;
    var metresPerPixel;

    function initialize(version, refZoom, a, b, tx, ty, imageWidth, imageHeight, rotationDegrees, metresPerPixel) {
        self.version = version;
        self.refZoom = refZoom;
        self.a = a;
        self.b = b;
        self.tx = tx;
        self.ty = ty;
        self.imageWidth = imageWidth;
        self.imageHeight = imageHeight;
        self.rotationDegrees = rotationDegrees;
        self.metresPerPixel = metresPerPixel;
    }

    // A package from a newer recipe, or one whose transform is degenerate,
    // is unusable rather than approximately usable — the caller shows the
    // numbers-only face instead of a map with drifting markers.
    function isUsable() {
        if (version != SUPPORTED_VERSION) { return false; }
        if (imageWidth == null || imageWidth <= 0 || imageHeight == null || imageHeight <= 0) { return false; }
        if (a == null || b == null || tx == null || ty == null) { return false; }
        return (a * a + b * b) > 0;
    }

    // Image-pixel position of a real-world coordinate. Returns null when the
    // reference is unusable or the coordinate itself is non-finite. Returns
    // a Dictionary { "x" => Double, "y" => Double } (Monkey C has no
    // lightweight point type in Toybox.Lang worth depending on here).
    function imagePoint(lat, lng) {
        if (!isUsable() || lat == null || lng == null) { return null; }
        var world = worldPixel(lat, lng, refZoom);
        var x = a * world["x"] - b * world["y"] + tx;
        var y = b * world["x"] + a * world["y"] + ty;
        return { "x" => x, "y" => y };
    }

    // Inverse of imagePoint — the half interactive aiming (Phase 3) needs,
    // and the half that proves the transform round-trips today.
    function coordinate(x, y) {
        if (!isUsable()) { return null; }
        var determinant = a * a + b * b;
        var sx = x - tx;
        var sy = y - ty;
        var worldX = (a * sx + b * sy) / determinant;
        var worldY = (a * sy - b * sx) / determinant;
        var scale = TILE_SIZE * Math.pow(2.0, refZoom.toDouble());
        var n = Math.PI * (1.0 - (2.0 * worldY) / scale);
        var lat = radToDeg(Math.atan(sinh(n)));
        var lng = (worldX / scale) * 360.0 - 180.0;
        return new GarminCoordinate(lat, lng);
    }

    function worldPixel(lat, lng, zoom) {
        var scale = TILE_SIZE * Math.pow(2.0, zoom.toDouble());
        var clamped = lat;
        if (clamped > MAX_MERCATOR_LATITUDE) { clamped = MAX_MERCATOR_LATITUDE; }
        if (clamped < -MAX_MERCATOR_LATITUDE) { clamped = -MAX_MERCATOR_LATITUDE; }
        var latRad = degToRad(clamped);
        var x = ((lng + 180.0) / 360.0) * scale;
        var y = ((1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0) * scale;
        return { "x" => x, "y" => y };
    }

    function degToRad(deg) { return deg * Math.PI / 180.0; }
    function radToDeg(rad) { return rad * 180.0 / Math.PI; }

    // Monkey C's Toybox.Math has no hyperbolic sine; sinh(n) = (e^n - e^-n)/2.
    function sinh(n) {
        return (Math.pow(Math.E, n) - Math.pow(Math.E, -n)) / 2.0;
    }

    static function fromDict(raw) {
        if (raw == null) { return null; }
        var version = GarminWire.intVal(raw, "version");
        var refZoom = GarminWire.intVal(raw, "refZoom");
        var transform = GarminWire.dictVal(raw, "transform");
        var imageWidth = GarminWire.num(raw, "imageWidth");
        var imageHeight = GarminWire.num(raw, "imageHeight");
        if (version == null || refZoom == null || transform == null || imageWidth == null || imageHeight == null) { return null; }
        var a = GarminWire.num(transform, "a");
        var b = GarminWire.num(transform, "b");
        var tx = GarminWire.num(transform, "tx");
        var ty = GarminWire.num(transform, "ty");
        if (a == null || b == null || tx == null || ty == null) { return null; }
        var rotationDegrees = GarminWire.num(raw, "rotationDegrees");
        var metresPerPixel = GarminWire.num(raw, "metresPerPixel");
        return new GarminMapSpatialReference(version, refZoom, a, b, tx, ty, imageWidth, imageHeight, rotationDegrees, metresPerPixel);
    }
}
