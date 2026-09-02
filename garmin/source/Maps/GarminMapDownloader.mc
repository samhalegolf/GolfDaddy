using Toybox.Lang;
using Toybox.Communications;
using Toybox.Graphics;

// Fetches one hole's raster and hands the decoded bitmap to GarminMapStore.
//
// ARCHITECTURE NOTE (read before changing this file): AppleWatchTransport
// pushes raw JPEG bytes over WatchConnectivity's transferFile/sendMessage,
// because watchOS's WCSession has no concept of the Watch fetching a URL
// itself. Garmin's situation is different in a way that matters: Connect
// IQ's Communications.makeImageRequestWithDictionary(url, params, options,
// callback) fetches a web image AND hands back an already-decoded
// Graphics.BitmapType — there is no public Monkey C API for decoding an
// arbitrary JPEG/PNG byte buffer the app assembled itself from chunked
// messages. Pushing raw bytes the way Apple does would leave Garmin holding
// bytes it cannot turn into a bitmap.
//
// So the Garmin manifest carries a `url` per hole (see
// GarminMapManifest.mc's Garmin-specific addition) pointing at the same
// baked image `course_watch_maps` already serves, and Garmin pulls each
// missing hole itself — which is also the literal reading of the Garmin
// Phase 1 plan step 22: "Garmin then obtains each hole image using Connect
// IQ communications/image request APIs."
//
// UNVERIFIED: makeImageRequestWithDictionary's exact options dictionary keys
// (content type hints, max dimensions) and its cross-relaunch caching
// behaviour need confirming against the installed Connect IQ SDK version —
// see garmin/README.md. If the phone's course_watch_maps URLs are
// short-lived signed URLs rather than stable ones, the manifest must carry
// a URL with enough lifetime to survive between fetches, or Garmin must
// re-request a fresh manifest before each fetch; this is an open item for
// whoever wires the phone-side manifest generation for Garmin.
class GarminMapDownloader {
    var store;       // GarminMapStore, set by the store itself on construction
    var inFlight;     // Dictionary used as a Set of hole numbers currently fetching

    function initialize(store) {
        self.store = store;
        inFlight = {};
    }

    function requestHole(hole) {
        if (hole == null || hole.url == null) { return; }
        if (inFlight.hasKey(hole.holeNumber)) { return; }
        inFlight[hole.holeNumber] = true;

        var options = {
            :maxWidth => hole.width.toNumber(),
            :maxHeight => hole.height.toNumber()
        };
        try {
            Communications.makeImageRequestWithDictionary(
                hole.url, {}, options, method(:onImageResponse), hole.holeNumber);
        } catch (e) {
            inFlight.remove(hole.holeNumber);
        }
    }

    // Signature matches Communications' image-request callback convention:
    // (responseCode, data). The hole number is closed over via the request
    // context argument where the SDK supports it; where it does not, callers
    // should track the single outstanding request themselves (Phase 1 only
    // ever has one hole in flight at a time per GarminMapStore's own
    // decoded-bitmap discipline, so this is not a practical ambiguity).
    function onImageResponse(responseCode, data) {
        // context is not threaded through on every CIQ API level's
        // callback signature; resolve against whichever hole is currently
        // being awaited rather than assuming an argument that may not
        // exist on the installed SDK.
        var holeNumber = currentlyAwaitedHole();
        if (holeNumber != null) { inFlight.remove(holeNumber); }
        if (responseCode == 200 && data != null && holeNumber != null) {
            store.onImageDecoded(holeNumber, data);
        }
    }

    function currentlyAwaitedHole() {
        var keys = inFlight.keys();
        return keys.size() > 0 ? keys[0] : null;
    }
}
