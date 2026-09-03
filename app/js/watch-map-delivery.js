/* Puts a course's baked Watch lite maps on the wrist.

   The Watch has no network and no Supabase credentials by design, so the phone
   is the only thing that can read a package out of course_watch_maps. This
   module is that errand and nothing else: it reads the package report, turns it
   into the small manifest the Watch stores, and hands the manifest plus each
   hole image to NativeRoundBridge, which owns the durable WatchConnectivity
   transfer. It never draws, never projects, and never touches Marshal.

   Deliberately separate from the Scene path in caddy-watch.js. A Scene is a few
   hundred bytes republished many times a minute; a package is ~100KB of imagery
   that changes only when a course is regenerated. Putting the second on the
   first's transport would make every distance update drag a course behind it.

   It does keep score, though: how many holes the package has and how many the
   wrist holds is what the phone's handover card and the Watch's Receiving face
   both count down, so the errand reports its progress (`onProgress`) and keeps
   the images it fetched around as thumbnails (`holeImage`).

   Pure and inert off-native: with no NativeRoundBridge plugin present (any
   browser, including the Studio surfaces) `deliver` resolves with a reason and
   makes no network call at all. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.watchMapDelivery = factory();
    root.GDWatchMapDelivery = root.ClarityApp.watchMapDelivery;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var REPORT_ENDPOINT = "/api/course-watch-maps";
  var ASSET_ENDPOINT = "/api/course-watch-map-assets";
  /* Asset names the generator actually produces. The Watch checks this again
     before the name becomes a path component; checking here too means a
     malformed package never even reaches the radio. */
  var ASSET_NAME = /^h([1-9]|[1-9][0-9])\.(png|webp)$/;

  function finite(n) { return Number.isFinite(Number(n)); }

  function usableSpatialReference(reference) {
    if (!reference || Number(reference.version) !== 1) return false;
    if (!Number.isInteger(Number(reference.refZoom))) return false;
    if (!(Number(reference.imageWidth) > 0) || !(Number(reference.imageHeight) > 0)) return false;
    var t = reference.transform;
    if (!t || !finite(t.a) || !finite(t.b) || !finite(t.tx) || !finite(t.ty)) return false;
    return Number(t.a) * Number(t.a) + Number(t.b) * Number(t.b) > 0;
  }

  function referencePoint(p) {
    return p && finite(p.lat) && finite(p.lng) ? { lat: Number(p.lat), lng: Number(p.lng) } : null;
  }

  function referencePath(points, minimum) {
    if (!Array.isArray(points)) return null;
    var out = [];
    for (var i = 0; i < points.length; i++) {
      var p = referencePoint(points[i]);
      if (!p) return null;   // a partial play line is worse than none
      out.push(p);
    }
    return out.length >= minimum ? out : null;
  }

  /* The hole's golf geometry, copied field by field like the spatial reference
     above and for the same reason - only what the wrist is meant to have.

     Optional throughout, at two levels. A package baked before the generator
     emitted a reference simply has none, and must still deliver: it is a
     perfectly good picture of a hole. And within one reference, a hole with no
     mapped tee has no play line, so tee/route/bearingDeg/lengthM are absent
     while the green and its shape are not. The wrist's rule for a missing
     input is to defer to the phone, so an absent field costs it the local
     calculation and nothing else - whereas a half-copied route would have it
     confidently aim down a line that stops early. */
  function manifestReference(reference) {
    if (!reference || Number(reference.version) !== 1) return null;
    var green = referencePoint(reference.green);
    if (!green) return null;
    var out = { version: 1, green: green };
    var tee = referencePoint(reference.tee);
    var route = referencePath(reference.route, 2);
    var greenShape = referencePath(reference.greenShape, 3);
    if (greenShape) out.greenShape = greenShape;
    /* tee, route, bearing and length are one fact - the hole's play line -
       and travel together or not at all. */
    if (tee && route && finite(reference.bearingDeg) && finite(reference.lengthM)) {
      out.tee = tee;
      out.route = route;
      out.bearingDeg = Number(reference.bearingDeg);
      out.lengthM = Number(reference.lengthM);
    }
    return out;
  }

  /* A package path is "<courseKey>/v<version>/h<n>.webp". Only the file name
     crosses to the Watch; the course key and version travel as their own
     fields, so a mismatched path cannot quietly file a hole under the wrong
     course. */
  function assetName(path) {
    var parts = String(path || "").split("/");
    var name = parts[parts.length - 1] || "";
    return ASSET_NAME.test(name) ? name : null;
  }

  function manifestHole(hole) {
    var number = Number(hole && hole.holeNumber);
    var name = assetName(hole && hole.path);
    var reference = hole && hole.spatialReference;
    if (!Number.isInteger(number) || number <= 0 || !name || !usableSpatialReference(reference)) return null;
    var out = {
      holeNumber: number,
      asset: name,
      width: Number(reference.imageWidth),
      height: Number(reference.imageHeight),
      path: String(hole.path),
      /* Copied field by field rather than passed through: whatever else the
         report grows, only the projection basis and the hole reference reach
         the wrist. */
      spatialReference: {
        version: Number(reference.version),
        refZoom: Number(reference.refZoom),
        transform: {
          a: Number(reference.transform.a), b: Number(reference.transform.b),
          tx: Number(reference.transform.tx), ty: Number(reference.transform.ty)
        },
        imageWidth: Number(reference.imageWidth),
        imageHeight: Number(reference.imageHeight),
        rotationDegrees: finite(reference.rotationDegrees) ? Number(reference.rotationDegrees) : null,
        metresPerPixel: finite(reference.metresPerPixel) ? Number(reference.metresPerPixel) : null
      }
    };
    /* Assigned only when there is one, never set to null: a null anywhere in a
       WatchConnectivity payload arrives as NSNull and makes the whole send
       throw WCErrorCodePayloadUnsupportedTypes. The Watch reads a missing key
       as nil, so omitting it is lossless. */
    var golf = manifestReference(hole && hole.reference);
    if (golf) out.reference = golf;
    return out;
  }

  function base64FromBytes(bytes) {
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(""));
  }

  function mimeFor(name) { return /\.png$/i.test(String(name || "")) ? "image/png" : "image/webp"; }

  /* Holes the Watch says it already has, but only when it is talking about this
     exact course and package version. Anything else is treated as "has
     nothing", because re-sending under 100KB is always cheaper than reasoning
     about a partial match across versions. */
  function alreadyDelivered(inventory, courseKey, version) {
    var have = inventory && inventory.inventory ? inventory.inventory : inventory;
    if (!have || String(have.courseKey || "") !== courseKey) return {};
    if (String(have.version || "") !== version) return {};
    var seen = {};
    (Array.isArray(have.holes) ? have.holes : []).forEach(function (n) { seen[Number(n)] = true; });
    return seen;
  }

  function createDelivery(options) {
    options = options || {};
    var plugin = options.plugin || null;
    var fetchImpl = options.fetch || (typeof fetch === "function" ? fetch : null);
    var apiUrl = options.apiUrl || function (url) { return url; };
    var toBase64 = options.toBase64 || base64FromBytes;
    var log = options.log || function () {};
    var now = options.now || function () { return Date.now(); };
    /* One in-flight errand per course, and no repeat once a course is on the
       wrist: this is called from the Scene stream, which fires constantly.
       A partial delivery must still be retryable — a hole whose image did not
       download is a gap worth filling — but retrying it on the next Scene would
       turn one flaky asset into a request every few seconds for the whole
       round. So a failed attempt waits out a cooldown first. */
    var RETRY_COOLDOWN_MS = 60 * 1000;
    /* Doubling, to a quarter of an hour. A gap the wrist cannot close - a
       course whose package is genuinely unreachable - must not become a
       fetch a minute for the rest of the round. */
    var RETRY_COOLDOWN_MAX_MS = 15 * 60 * 1000;
    var inFlight = Object.create(null);
    var completed = Object.create(null);
    var retryAfter = Object.create(null);
    var attempts = Object.create(null);

    function cooldownFor(courseKey) {
      var n = attempts[courseKey] = (attempts[courseKey] || 0) + 1;
      return Math.min(RETRY_COOLDOWN_MS * Math.pow(2, n - 1), RETRY_COOLDOWN_MAX_MS);
    }

    /* Per course: how many holes the package has, how many the wrist holds,
       which ones, and where each image lives (for a late thumbnail fetch). */
    var progress = Object.create(null);
    var images = Object.create(null);
    var paths = Object.create(null);
    var thumbFetches = Object.create(null);
    var listeners = [];

    function progressFor(courseKey) {
      var p = progress[courseKey];
      if (!p) return { courseKey: courseKey, known: false, none: false, total: 0, have: 0, complete: false };
      return { courseKey: courseKey, known: true, none: p.none, total: p.total, have: p.have, complete: p.total > 0 && p.have >= p.total };
    }
    function emit(courseKey) {
      var snapshot = progressFor(courseKey);
      listeners.forEach(function (fn) { try { fn(snapshot); } catch (e) {} });
    }
    /* Both counters write the same tally, and only one of them is evidence.
       `setHave` relays what the WRIST says it holds; `markHave` is the phone
       noting a hole as it leaves. The card is happy to show either - an
       optimistic count that the wrist corrects a moment later is the point of
       `onProgress` - but `confirmed` is what decides whether this errand is
       over, so a hole nobody has ever confirmed can never end it. */
    function setHave(courseKey, holes) {
      var p = progress[courseKey];
      if (!p) return;
      var seen = Object.create(null);
      holes.forEach(function (n) { seen[Number(n)] = true; });
      p.holes = seen;
      p.have = Object.keys(seen).length;
      p.confirmed = true;
      emit(courseKey);
    }
    function markHave(courseKey, holeNumber) {
      var p = progress[courseKey];
      if (!p || p.holes[holeNumber]) return;
      p.holes[holeNumber] = true;
      p.have = Object.keys(p.holes).length;
      p.confirmed = false;
      emit(courseKey);
    }

    /* The one place that decides a course is done with. It reads the wrist's
       own count, never the phone's: see the note in deliver(). */
    function settle(courseKey, result) {
      var p = progress[courseKey];
      if (!p || !p.confirmed || !(p.total > 0) || p.have < p.total) return false;
      completed[courseKey] = result || completed[courseKey] || { delivered: true, sent: 0, version: p.version };
      delete attempts[courseKey];
      delete retryAfter[courseKey];
      return true;
    }
    function rememberImage(courseKey, holeNumber, name, bytes) {
      images[courseKey] = images[courseKey] || Object.create(null);
      images[courseKey][holeNumber] = "data:" + mimeFor(name) + ";base64," + toBase64(bytes);
    }

    async function run(courseKey) {
      if (!plugin || typeof plugin.publishWatchMap !== "function" || typeof plugin.publishWatchMapAsset !== "function") {
        return { delivered: false, reason: "no-native-bridge" };
      }
      var response = await fetchImpl(apiUrl(REPORT_ENDPOINT + "?courseId=" + encodeURIComponent(courseKey)));
      if (!response || !response.ok) return { delivered: false, reason: "report-unavailable" };
      var report = await response.json();
      var version = String((report && report.watchPackageVersion) || "");
      var holes = (report && Array.isArray(report.holes) ? report.holes : []).map(manifestHole).filter(Boolean);
      if (!version || version === "0" || !holes.length) {
        /* Known to have nothing is its own answer: the handover need not wait
           for maps that will never come. */
        progress[courseKey] = { none: true, total: 0, have: 0, holes: Object.create(null), version: version };
        emit(courseKey);
        return { delivered: false, reason: "no-package" };
      }
      paths[courseKey] = Object.create(null);
      holes.forEach(function (hole) { paths[courseKey][hole.holeNumber] = hole.path; });

      var have = {};
      if (typeof plugin.watchMapInventory === "function") {
        try { have = alreadyDelivered(await plugin.watchMapInventory(), courseKey, version); } catch (e) { have = {}; }
      }
      progress[courseKey] = { none: false, total: holes.length, have: 0, holes: Object.create(null), version: version };
      setHave(courseKey, Object.keys(have));
      var missing = holes.filter(function (hole) { return !have[hole.holeNumber]; });
      if (!missing.length) return { delivered: true, sent: 0, skipped: holes.length, version: version };

      /* Manifest first: it is what makes an image that lands mean something,
         and it lets the Watch show honest "3 of 18" progress while the rest
         arrive. */
      await plugin.publishWatchMap({
        manifest: {
          courseKey: courseKey,
          version: Number(version),
          holes: holes.map(function (hole) {
            var out = { holeNumber: hole.holeNumber, asset: hole.asset, width: hole.width, height: hole.height, spatialReference: hole.spatialReference };
            /* `path` stays behind - it is how THIS surface fetches the image
               and means nothing on the wrist. `reference` is omitted rather
               than nulled for the NSNull reason in manifestHole. */
            if (hole.reference) out.reference = hole.reference;
            return out;
          })
        }
      });

      var sent = 0;
      var failed = 0;
      for (var i = 0; i < missing.length; i++) {
        var hole = missing[i];
        try {
          var asset = await fetchImpl(apiUrl(ASSET_ENDPOINT + "?path=" + encodeURIComponent(hole.path)));
          if (!asset || !asset.ok) { failed += 1; continue; }
          var bytes = new Uint8Array(await asset.arrayBuffer());
          if (!bytes.length) { failed += 1; continue; }
          var base64 = toBase64(bytes);
          rememberImage(courseKey, hole.holeNumber, hole.asset, bytes);
          await plugin.publishWatchMapAsset({
            courseKey: courseKey,
            version: version,
            holeNumber: hole.holeNumber,
            asset: hole.asset,
            base64: base64
          });
          sent += 1;
          /* Counted as it leaves. The wrist's own inventory report, when it
             comes, is the truth and overwrites this. */
          markHave(courseKey, hole.holeNumber);
        } catch (error) {
          /* One unreachable hole is not a failed round. The Watch shows the
             holes it does have and the next delivery attempt fills the gap. */
          failed += 1;
          log("watch map asset failed", hole.holeNumber, error);
        }
      }
      return { delivered: sent > 0, sent: sent, failed: failed, skipped: holes.length - missing.length, version: version };
    }

    function deliver(courseKey) {
      courseKey = String(courseKey || "").trim();
      if (!courseKey) return Promise.resolve({ delivered: false, reason: "no-course" });
      if (completed[courseKey]) return Promise.resolve(completed[courseKey]);
      if (inFlight[courseKey]) return inFlight[courseKey];
      if (retryAfter[courseKey] > now()) return Promise.resolve({ delivered: false, reason: "cooling-down" });
      var promise = run(courseKey).then(function (result) {
        delete inFlight[courseKey];
        /* Only a package the WRIST says it holds is remembered for good.
           Deliberately not `result.delivered && !result.failed`: that counted
           holes as they left the phone, and a hole handed to the radio is not
           a hole on the wrist. A live message the counterpart refuses (an
           image over the sendMessage byte cap) and a queued transfer that
           never lands both look like success from here, so latching on them
           is what left Millbrook stuck at 10 of 18 with no path back - the
           errand was finished for good and the eight gaps could never be
           filled. Anything short is retried, but not before the cooldown. */
        if (settle(courseKey, result)) return result;
        retryAfter[courseKey] = now() + cooldownFor(courseKey);
        return result;
      }, function (error) {
        delete inFlight[courseKey];
        retryAfter[courseKey] = now() + cooldownFor(courseKey);
        log("watch map delivery failed", courseKey, error);
        return { delivered: false, reason: "error" };
      });
      inFlight[courseKey] = promise;
      return promise;
    }

    /* The Watch's own count of what it holds, relayed by the native bridge.
       Authoritative over anything counted here on the way out. */
    function noteInventory(inventory) {
      var have = inventory && inventory.inventory ? inventory.inventory : inventory;
      var courseKey = have && String(have.courseKey || "");
      var p = courseKey && progress[courseKey];
      if (!p || p.none) return false;
      if (String(have.version || "") !== String(p.version)) return false;
      setHave(courseKey, Array.isArray(have.holes) ? have.holes : []);
      /* A report that comes back SHORT is the repair signal. The phone had
         nothing else to learn this from - it had already watched every hole
         leave - so without this a wrist that quietly lost eight of them stayed
         short for the whole round. Re-opening the errand is enough; the next
         Scene runs it once the cooldown is out, and it re-sends only the gaps. */
      if (!settle(courseKey, null) && completed[courseKey]) {
        delete completed[courseKey];
        retryAfter[courseKey] = now() + cooldownFor(courseKey);
      }
      return true;
    }

    /* A thumbnail for the phone's card. Whatever was fetched on the way to the
       wrist is already here; a hole that was skipped (the wrist had it) is
       fetched once in the background and announced through onProgress so the
       card redraws. */
    function holeImage(courseKey, holeNumber) {
      var cached = images[courseKey] && images[courseKey][holeNumber];
      if (cached) return cached;
      var path = paths[courseKey] && paths[courseKey][holeNumber];
      var key = courseKey + "#" + holeNumber;
      if (!path || thumbFetches[key] || !fetchImpl) return null;
      thumbFetches[key] = true;
      Promise.resolve().then(function () { return fetchImpl(apiUrl(ASSET_ENDPOINT + "?path=" + encodeURIComponent(path))); })
        .then(function (asset) { return asset && asset.ok ? asset.arrayBuffer() : null; })
        .then(function (buffer) {
          if (!buffer) return;
          rememberImage(courseKey, holeNumber, assetName(path), new Uint8Array(buffer));
          emit(courseKey);
        })
        .catch(function () { delete thumbFetches[key]; });
      return null;
    }

    function onProgress(fn) { if (typeof fn === "function") listeners.push(fn); }

    return { deliver: deliver, progress: progressFor, onProgress: onProgress, noteInventory: noteInventory, holeImage: holeImage };
  }

  var shared = null;
  function nativePlugin() {
    var capacitor = typeof window !== "undefined" ? window.Capacitor : null;
    return (capacitor && capacitor.Plugins && capacitor.Plugins.NativeRoundBridge) || null;
  }
  /* The app-wide instance, bound late so it picks up the Capacitor plugin
     whenever it registers rather than only if it is ready at load. */
  function ensureShared() {
    if (shared) return shared;
    var plugin = nativePlugin();
    if (!plugin) return null;
    shared = createDelivery({
      plugin: plugin,
      apiUrl: function (url) {
        var origin = (typeof window !== "undefined" && window.GDNative && window.GDNative.apiOrigin) || "";
        return origin && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? origin + url : url;
      }
    });
    pendingListeners.forEach(function (fn) { shared.onProgress(fn); });
    pendingListeners = [];
    return shared;
  }
  var pendingListeners = [];

  return {
    createDelivery: createDelivery,
    deliver: function (courseKey) {
      var instance = ensureShared();
      if (!instance) return Promise.resolve({ delivered: false, reason: "no-native-bridge" });
      return instance.deliver(courseKey);
    },
    progress: function (courseKey) {
      var instance = ensureShared();
      return instance ? instance.progress(courseKey) : { courseKey: courseKey, known: false, none: false, total: 0, have: 0, complete: false };
    },
    /* Listeners may register before the native plugin exists; they are
       attached the moment the shared errand is created. */
    onProgress: function (fn) {
      var instance = ensureShared();
      if (instance) instance.onProgress(fn); else if (typeof fn === "function") pendingListeners.push(fn);
    },
    noteInventory: function (inventory) {
      var instance = ensureShared();
      return instance ? instance.noteInventory(inventory) : false;
    },
    holeImage: function (courseKey, holeNumber) {
      var instance = ensureShared();
      return instance ? instance.holeImage(courseKey, holeNumber) : null;
    },
    __test: { manifestHole: manifestHole, assetName: assetName, alreadyDelivered: alreadyDelivered, usableSpatialReference: usableSpatialReference }
  };
});
