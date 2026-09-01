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
    return {
      holeNumber: number,
      asset: name,
      width: Number(reference.imageWidth),
      height: Number(reference.imageHeight),
      path: String(hole.path),
      /* Copied field by field rather than passed through: whatever else the
         report grows, only the projection basis reaches the wrist. */
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
  }

  function base64FromBytes(bytes) {
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(""));
  }

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
    var inFlight = Object.create(null);
    var completed = Object.create(null);
    var retryAfter = Object.create(null);

    async function run(courseKey) {
      if (!plugin || typeof plugin.publishWatchMap !== "function" || typeof plugin.publishWatchMapAsset !== "function") {
        return { delivered: false, reason: "no-native-bridge" };
      }
      var response = await fetchImpl(apiUrl(REPORT_ENDPOINT + "?courseId=" + encodeURIComponent(courseKey)));
      if (!response || !response.ok) return { delivered: false, reason: "report-unavailable" };
      var report = await response.json();
      var version = String((report && report.watchPackageVersion) || "");
      var holes = (report && Array.isArray(report.holes) ? report.holes : []).map(manifestHole).filter(Boolean);
      if (!version || version === "0" || !holes.length) return { delivered: false, reason: "no-package" };

      var have = {};
      if (typeof plugin.watchMapInventory === "function") {
        try { have = alreadyDelivered(await plugin.watchMapInventory(), courseKey, version); } catch (e) { have = {}; }
      }
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
            return { holeNumber: hole.holeNumber, asset: hole.asset, width: hole.width, height: hole.height, spatialReference: hole.spatialReference };
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
          await plugin.publishWatchMapAsset({
            courseKey: courseKey,
            version: version,
            holeNumber: hole.holeNumber,
            asset: hole.asset,
            base64: toBase64(bytes)
          });
          sent += 1;
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
        /* Only a settled, complete delivery is remembered for good. Anything
           else is retried, but not before the cooldown. */
        if (result.delivered && !result.failed) completed[courseKey] = result;
        else retryAfter[courseKey] = now() + RETRY_COOLDOWN_MS;
        return result;
      }, function (error) {
        delete inFlight[courseKey];
        retryAfter[courseKey] = now() + RETRY_COOLDOWN_MS;
        log("watch map delivery failed", courseKey, error);
        return { delivered: false, reason: "error" };
      });
      inFlight[courseKey] = promise;
      return promise;
    }

    return { deliver: deliver };
  }

  var shared = null;
  function nativePlugin() {
    var capacitor = typeof window !== "undefined" ? window.Capacitor : null;
    return (capacitor && capacitor.Plugins && capacitor.Plugins.NativeRoundBridge) || null;
  }

  return {
    createDelivery: createDelivery,
    /* The app-wide instance, bound late so it picks up the Capacitor plugin
       whenever it registers rather than only if it is ready at load. */
    deliver: function (courseKey) {
      var plugin = nativePlugin();
      if (!plugin) return Promise.resolve({ delivered: false, reason: "no-native-bridge" });
      if (!shared) {
        shared = createDelivery({
          plugin: plugin,
          apiUrl: function (url) {
            var origin = (typeof window !== "undefined" && window.GDNative && window.GDNative.apiOrigin) || "";
            return origin && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? origin + url : url;
          }
        });
      }
      return shared.deliver(courseKey);
    },
    __test: { manifestHole: manifestHole, assetName: assetName, alreadyDelivered: alreadyDelivered, usableSpatialReference: usableSpatialReference }
  };
});
