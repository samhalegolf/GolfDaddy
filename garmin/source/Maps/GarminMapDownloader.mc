using Toybox.Lang;
using Toybox.Communications;
using Toybox.Graphics;
using Toybox.System;
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

    // Failure memory, so a hole whose fetch failed is not asked for again on
    // the very next redraw. The map face redraws every second and used to
    // re-request on each one, with no backoff, no cap and nothing on screen
    // but "Loading map..." - an endless Bluetooth loop (audit GA-007).
    // Keyed by hole number, for the package the failure happened under; a
    // new package starts clean. Retries wait 5 s, then 15 s, then a minute
    // between every attempt after that.
    var failures;    // Dictionary holeNumber => { "attempts", "nextAt", "code", "courseKey", "version" }
    static const RETRY_DELAYS_MS = [5000, 15000, 60000];

    function initialize(store) {
        self.store = store;
        awaiting = null;
        failures = {};
    }

    // The remembered failure for this hole under this package, or null.
    // A failure under another package is stale and forgotten here.
    function failureFor(holeNumber, courseKey, version) {
        if (!failures.hasKey(holeNumber)) { return null; }
        var failure = failures[holeNumber];
        if (!failure["courseKey"].equals(courseKey) || failure["version"] != version) {
            failures.remove(holeNumber);
            return null;
        }
        return failure;
    }

    // The response code of the last failed fetch for this hole, or null
    // while nothing has failed (not asked yet, or still in flight).
    function failureCode(holeNumber, courseKey, version) {
        var failure = failureFor(holeNumber, courseKey, version);
        return (failure != null) ? failure["code"] : null;
    }

    function noteFailure(holeNumber, courseKey, version, code) {
        var previous = failureFor(holeNumber, courseKey, version);
        var attempts = (previous != null) ? previous["attempts"] + 1 : 1;
        var step = attempts - 1;
        if (step >= RETRY_DELAYS_MS.size()) { step = RETRY_DELAYS_MS.size() - 1; }
        failures[holeNumber] = {
            "attempts" => attempts,
            "nextAt" => System.getTimer() + RETRY_DELAYS_MS[step],
            "code" => code,
            "courseKey" => courseKey,
            "version" => version
        };
    }

    function requestHole(hole, courseKey, version) {
        if (hole == null || hole.url == null || courseKey == null || version == null) {
            if (GarminTransmitPolicy.muted()) { System.println("image request skipped: hole=" + hole + " url=" + (hole != null ? hole.url : null)); }
            return;
        }
        if (awaiting != null) {
            if (GarminTransmitPolicy.muted()) { System.println("image request waiting on hole " + awaiting["holeNumber"]); }
            return;
        }
        var failure = failureFor(hole.holeNumber, courseKey, version);
        if (failure != null && System.getTimer() < failure["nextAt"]) { return; }
        awaiting = { "holeNumber" => hole.holeNumber, "courseKey" => courseKey, "version" => version };

        var options = {
            :maxWidth => hole.width.toNumber(),
            :maxHeight => hole.height.toNumber()
        };
        try {
            if (GarminTransmitPolicy.muted()) { System.println("image request: hole " + hole.holeNumber + " " + hole.url); }
            // parameters == null, not {}: these URLs may be signed, and an
            // empty dictionary can still append a bare "?" on some versions.
            Communications.makeImageRequest(
                hole.url, null, options, method(:onImageResponse));
        } catch (e) {
            if (GarminTransmitPolicy.muted()) { System.println("image request threw: " + e.getErrorMessage()); }
            awaiting = null;
            noteFailure(hole.holeNumber, courseKey, version, -1);
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
        // Simulator-only build: the only window into why a hole never
        // draws. Compiled out of every live build.
        if (GarminTransmitPolicy.muted()) {
            System.println("image response: code " + responseCode + " data=" + data
                + (requested != null ? " hole " + requested["holeNumber"] : " (nothing requested)"));
        }
        if (requested == null) { return; }
        if (responseCode != 200 || data == null) {
            noteFailure(requested["holeNumber"], requested["courseKey"], requested["version"], responseCode);
            return;
        }
        var manifest = store.manifest;
        if (manifest == null
                || !manifest.courseKey.equals(requested["courseKey"])
                || manifest.version != requested["version"]) {
            return;
        }
        failures.remove(requested["holeNumber"]);
        store.onImageDecoded(requested["holeNumber"], data);
    }
}
