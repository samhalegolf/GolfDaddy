using Toybox.Lang;
using Toybox.Application.Storage;
using Toybox.Graphics;

// Mirrors the INTENT of ios/App/ClarityCaddyWatch/WatchMapStore.swift, not
// its filesystem implementation (see the Garmin Phase 1 plan step 23): which
// course/version is current, which holes are available, and the bitmap for
// the hole actually being looked at.
//
// Storage/RAM discipline (plan steps 24 + 26): the manifest is small and
// persists via Application.Storage across a relaunch. Decoded bitmaps do
// NOT persist — Monkey C's Storage holds primitives/Arrays/Dictionaries, not
// opaque Graphics.BitmapType objects, and GarminMapDownloader fetches by URL
// (see its header comment), so re-fetching a hole after a relaunch is cheap
// and network-backed rather than something that needs its own cache file.
// At most ONE decoded bitmap is held resident at a time, which is stricter
// than Apple's four-hole LRU (WatchMapStore.swift) — appropriate for the
// more memory-constrained end of the Garmin device matrix (plan step 26).
// A capable device may raise this to two (current + next) once
// DeviceCapabilities reports enough headroom; Phase 1 ships the
// conservative default.
class GarminMapStore {
    static var STORAGE_KEY = "GarminMapManifestV1";
    static var READY_HOLES_KEY = "GarminMapReadyHolesV1";
    static var RESIDENT_BITMAP_LIMIT = 1;

    var manifest;          // GarminMapManifest or null
    var readyHoles;         // Dictionary used as a Set of hole numbers
    var downloader;
    var residentBitmaps;    // Dictionary: holeNumber -> Graphics.BitmapType, capped at RESIDENT_BITMAP_LIMIT
    var residentOrder;      // Array of hole numbers, oldest first

    function initialize() {
        manifest = null;
        readyHoles = {};
        residentBitmaps = {};
        residentOrder = [];
        downloader = new GarminMapDownloader(self);
        restore();
    }

    // ------------------------------------------------------------- reads

    // The hole's decoded bitmap, or null when not yet fetched this session
    // — the caller (NumbersView/MapView) shows the numbers-only state and
    // GarminMapStore keeps fetching in the background via requestHole().
    function bitmapFor(holeNumber, courseKey) {
        if (manifest == null || courseKey == null || !manifest.courseKey.equals(courseKey)) { return null; }
        if (residentBitmaps.hasKey(holeNumber)) { return residentBitmaps[holeNumber]; }
        requestHole(holeNumber);
        return null;
    }

    function requestHole(holeNumber) {
        if (manifest == null) { return; }
        var hole = manifest.hole(holeNumber);
        if (hole == null) { return; }
        downloader.requestHole(hole);
    }

    function readyHoleCount(courseKey) {
        if (manifest == null || courseKey == null || !manifest.courseKey.equals(courseKey)) { return 0; }
        return readyHoles.keys().size();
    }

    // What the phone needs in order to know Garmin already has a hole and
    // skip re-advertising it (plan step 33).
    function inventory() {
        if (manifest == null) {
            return { "courseKey" => "", "version" => "", "holes" => [] };
        }
        return {
            "courseKey" => manifest.courseKey,
            "version" => manifest.version.toString(),
            "holes" => readyHoles.keys()
        };
    }

    // ------------------------------------------------------------ writes

    // Adopts a manifest pushed by the phone. Ignores anything malformed, and
    // ignores an older package for a course already held at a newer version.
    function receiveManifest(raw) {
        var incoming = GarminMapManifest.fromDict(raw);
        if (incoming == null || !incoming.isUsable()) { return; }
        if (manifest != null && manifest.courseKey.equals(incoming.courseKey) && manifest.version > incoming.version) { return; }
        if (manifest == null || !manifest.courseKey.equals(incoming.courseKey) || manifest.version != incoming.version) {
            // A genuinely new package: nothing is ready yet, and stale
            // resident bitmaps from the old course/version must go.
            readyHoles = {};
            residentBitmaps = {};
            residentOrder = [];
        }
        manifest = incoming;
        persistManifest();
    }

    // Callback from GarminMapDownloader once a hole's image has actually
    // decoded. Marks it ready, persists the ready-set, and keeps at most
    // RESIDENT_BITMAP_LIMIT decoded bitmaps in memory.
    function onImageDecoded(holeNumber, bitmap) {
        readyHoles[holeNumber] = true;
        persistReadyHoles();

        residentBitmaps[holeNumber] = bitmap;
        residentOrder.add(holeNumber);
        while (residentOrder.size() > RESIDENT_BITMAP_LIMIT) {
            var evict = residentOrder[0];
            residentOrder = residentOrder.slice(1, residentOrder.size());
            if (!residentOrder.contains(evict)) { residentBitmaps.remove(evict); }
        }
    }

    // ----------------------------------------------------------- layout

    function persistManifest() {
        if (manifest == null) { return; }
        try {
            var holesOut = [];
            for (var i = 0; i < manifest.holes.size(); i += 1) {
                var h = manifest.holes[i];
                holesOut.add({
                    "holeNumber" => h.holeNumber, "asset" => h.asset, "url" => h.url,
                    "width" => h.width, "height" => h.height,
                    "spatialReference" => {
                        "version" => h.spatialReference.version, "refZoom" => h.spatialReference.refZoom,
                        "transform" => { "a" => h.spatialReference.a, "b" => h.spatialReference.b,
                                          "tx" => h.spatialReference.tx, "ty" => h.spatialReference.ty },
                        "imageWidth" => h.spatialReference.imageWidth, "imageHeight" => h.spatialReference.imageHeight,
                        "rotationDegrees" => h.spatialReference.rotationDegrees, "metresPerPixel" => h.spatialReference.metresPerPixel
                    },
                    "reference" => (h.greenLat != null) ? { "green" => { "lat" => h.greenLat, "lng" => h.greenLng } } : null
                });
            }
            Storage.setValue(STORAGE_KEY, { "courseKey" => manifest.courseKey, "version" => manifest.version, "holes" => holesOut });
        } catch (e) {
            // Losing this costs a re-adoption of the next manifest push,
            // never a wrong course.
        }
    }

    function persistReadyHoles() {
        try {
            Storage.setValue(READY_HOLES_KEY, readyHoles.keys());
        } catch (e) {
            // best-effort
        }
    }

    function restore() {
        var storedManifest = null;
        var storedReady = null;
        try {
            storedManifest = Storage.getValue(STORAGE_KEY);
            storedReady = Storage.getValue(READY_HOLES_KEY);
        } catch (e) {
            storedManifest = null;
            storedReady = null;
        }
        if (storedManifest instanceof Lang.Dictionary) {
            var incoming = GarminMapManifest.fromDict(storedManifest);
            if (incoming != null && incoming.isUsable()) { manifest = incoming; }
        }
        if (storedReady instanceof Lang.Array) {
            for (var i = 0; i < storedReady.size(); i += 1) { readyHoles[storedReady[i]] = true; }
        }
    }
}
