using Toybox.Lang;
using Toybox.Communications;
using Toybox.Graphics;
using Toybox.WatchUi;

// Fetches one hole's raster and hands the decoded bitmap to GarminMapStore.
//
// ARCHITECTURE NOTE (read before changing this file): AppleWatchTransport
// pushes raw JPEG bytes over WatchConnectivity's transferFile/sendMessage,
// because watchOS's WCSession has no concept of the Watch fetching a URL
// itself. Garmin's situation is different in a way that matters: Connect
// IQ's Communications.makeImageRequest(url, params, options,
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
// VERIFIED against SDK 9.2.0 (2026-09-19): the API is
// Communications.makeImageRequest(url, parameters, options, responseCallback)
// — there is no makeImageRequestWithDictionary, and no fifth context
// argument. :maxWidth/:maxHeight are real options keys. Its cross-relaunch
// caching behaviour is still unconfirmed.
//
// RESOLVED 2026-09-19 — the URL lifetime worry that used to sit here was
// unfounded, and the phone now sends the URL. app/js/watch-map-delivery.js
// attaches an absolute `url` per hole, pointing at
// /api/course-watch-map-assets. That endpoint is a read-only proxy over
// imagery that is public by design (functions/course-watch-map-assets.mjs
// says so in its own header), it takes no Authorization header -- which
// matters, because makeImageRequest cannot send one -- and it serves
// `immutable, max-age=31536000` over a versioned vN path. Nothing is signed
// and nothing expires, so a URL is good for as long as the package is.
//
// ONE REQUEST AT A TIME, BY CONSTRUCTION. makeImageRequest's callback
// carries no context — just a response code and a bitmap — so the only way
// to know which hole a bitmap belongs to is to have asked for exactly one.
// `awaiting` is that one: the hole number plus the course key and package
// version it was requested under. A second request while one is pending is
// refused (the map face asks again on its next redraw, so nothing is lost),
// and a response is dropped unless the store still holds the same package.
// Before this, `inFlight` was a set: change hole mid-fetch and two were
// pending, the response was credited to whichever key came first, and hole
// 3's picture was stored — and persisted as ready — under hole 4.
class GarminMapDownloader {
    var store;       // GarminMapStore, set by the store itself on construction
    var awaiting;     // Dictionary { "holeNumber", "courseKey", "version" } or null

    function initialize(store) {
        self.store = store;
        awaiting = null;
    }

    function requestHole(hole, courseKey, version) {
        if (hole == null || hole.url == null || courseKey == null || version == null) { return; }
        if (awaiting != null) { return; }
        awaiting = { "holeNumber" => hole.holeNumber, "courseKey" => courseKey, "version" => version };

        var options = {
            :maxWidth => hole.width.toNumber(),
            :maxHeight => hole.height.toNumber()
        };
        try {
            // parameters == null, not {}: these URLs may be signed, and an
            // empty dictionary can still append a bare "?" on some versions.
            Communications.makeImageRequest(
                hole.url, null, options, method(:onImageResponse));
        } catch (e) {
            awaiting = null;
        }
    }

    // Signature matches the documented image-request callback exactly:
    // (responseCode as Number, data as BitmapResource/BitmapReference/Null).
    // The bitmap is credited to `awaiting`, and only if the store's manifest
    // is still the package it was requested from: a course or version change
    // while the fetch was out means this picture belongs to nothing current.
    function onImageResponse(
            responseCode as Lang.Number,
            data as WatchUi.BitmapResource or Graphics.BitmapReference or Null) as Void {
        var requested = awaiting;
        awaiting = null;
        if (requested == null || responseCode != 200 || data == null) { return; }
        var manifest = store.manifest;
        if (manifest == null
                || !manifest.courseKey.equals(requested["courseKey"])
                || manifest.version != requested["version"]) {
            return;
        }
        store.onImageDecoded(requested["holeNumber"], data);
    }
}
