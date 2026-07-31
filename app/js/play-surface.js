/* Published playing-surface lookup and the mercator-image projection.

   The server (course_visuals → uploaded_assets) publishes per-hole surfaces
   whose metadata.playSurface carries everything needed to present the image and
   place GPS points on it: an integer captureZoom, originPx in world-mercator
   pixels at that zoom, outputDimensions, anchorPins, and the fallback policy.
   The app reconciles nothing — the asset is self-contained.

   Absence is a state (rule 4): lookup answers are cached per course+hole, and
   "none" is as final an answer as "published". Independent callers asking again
   get the cached answer with no work.

   Pure functions (projection, asset picking) are exported for node tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.playSurface = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var TILE = 256;

  /* World-mercator pixel coordinates at an integer zoom. Rule 6: a fractional
     captureZoom drifts GPS play markers, so it is rejected outright rather than
     rounded — a bad asset must be fixed server-side, not accommodated. */
  function worldPx(lat, lng, zoom) {
    if (!Number.isInteger(zoom)) throw new Error("captureZoom must be an integer, got " + zoom);
    var scale = TILE * Math.pow(2, zoom);
    var latRad = (Math.max(-85.05112878, Math.min(85.05112878, Number(lat))) * Math.PI) / 180;
    return {
      x: ((Number(lng) + 180) / 360) * scale,
      y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale
    };
  }

  /* lat/lng → pixel position on the surface image. Null when the point falls
     outside the image (caller decides what an off-surface marker means). */
  function projectToSurface(meta, lat, lng) {
    if (!meta || !meta.originPx || !meta.outputDimensions) return null;
    var world = worldPx(lat, lng, Number(meta.captureZoom));
    var x = world.x - Number(meta.originPx.x);
    var y = world.y - Number(meta.originPx.y);
    var w = Number(meta.outputDimensions.width), h = Number(meta.outputDimensions.height);
    if (!(x >= 0 && y >= 0 && x <= w && y <= h)) return null;
    return { x: x, y: y };
  }

  /* Pick the published asset for a hole out of a course-visual record.
     Returns {path, playSurface} or null — null is normal, not an error. */
  function holeSurfaceAsset(record, holeNumber) {
    if (!record || String(record.status || "") !== "published") return null;
    var assets = Array.isArray(record.uploaded_assets) ? record.uploaded_assets
      : Array.isArray(record.uploadedAssets) ? record.uploadedAssets : [];
    var hole = Number(holeNumber);
    for (var i = 0; i < assets.length; i++) {
      var asset = assets[i] || {};
      var meta = asset.metadata && asset.metadata.playSurface;
      if (meta && Number(asset.holeNumber) === hole && asset.path) {
        return { path: String(asset.path), playSurface: meta };
      }
    }
    return null;
  }

  /* Browser-side store. Wired in boot.js; inert under node. */
  function createStore(deps) {
    var fetchRecord = deps.fetchRecord;   // async courseKey → course-visual record | null
    var answers = new Map();              // "<courseKey>:h<hole>" → {state, asset}

    function keyFor(courseKey, hole) { return courseKey + ":h" + (Number(hole) || 1); }

    /* → {state: "published"|"none", asset} — idempotent per hole. */
    async function surfaceFor(courseKey, hole) {
      var key = keyFor(courseKey, hole);
      if (answers.has(key)) return answers.get(key);
      var record = null;
      try { record = await fetchRecord(courseKey); } catch (e) { record = null; }
      var asset = holeSurfaceAsset(record, hole);
      var answer = asset ? { state: "published", asset: asset } : { state: "none", asset: null };
      /* A failed fetch and a genuine "none" both land here — cache it either
         way so nothing retries in a loop; forget() is the explicit refresh. */
      answers.set(key, answer);
      return answer;
    }

    function forget(courseKey) {
      Array.from(answers.keys()).forEach(function (k) {
        if (k.indexOf(courseKey + ":") === 0) answers.delete(k);
      });
    }

    return { surfaceFor: surfaceFor, forget: forget };
  }

  /* Where an image pixel lands on screen when the image is displayed with
     object-fit: contain — scale to fit, letterbox centred. Pure, for tests. */
  function fitContain(imagePx, imageDims, viewDims) {
    var iw = Number(imageDims.width), ih = Number(imageDims.height);
    var vw = Number(viewDims.width), vh = Number(viewDims.height);
    if (!(iw > 0 && ih > 0 && vw > 0 && vh > 0)) return null;
    var scale = Math.min(vw / iw, vh / ih);
    return {
      left: (vw - iw * scale) / 2 + Number(imagePx.x) * scale,
      top: (vh - ih * scale) / 2 + Number(imagePx.y) * scale
    };
  }

  /* Inverse of worldPx: world-mercator pixels at an integer zoom → lat/lng. */
  function latLngFromWorldPx(px, zoom) {
    if (!Number.isInteger(zoom)) throw new Error("captureZoom must be an integer, got " + zoom);
    var scale = TILE * Math.pow(2, zoom);
    var n = Math.PI * (1 - (2 * Number(px.y)) / scale);
    return {
      lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
      lng: (Number(px.x) / scale) * 360 - 180
    };
  }

  /* Inverse of projectToSurface + fitContain: a tap on the displayed surface
     → lat/lng. Null when the tap lands in the letterbox — not on the course. */
  function surfaceScreenToLatLng(meta, screenPx, viewDims) {
    if (!meta || !meta.originPx || !meta.outputDimensions) return null;
    var iw = Number(meta.outputDimensions.width), ih = Number(meta.outputDimensions.height);
    var vw = Number(viewDims.width), vh = Number(viewDims.height);
    if (!(iw > 0 && ih > 0 && vw > 0 && vh > 0)) return null;
    var scale = Math.min(vw / iw, vh / ih);
    var x = (Number(screenPx.left) - (vw - iw * scale) / 2) / scale;
    var y = (Number(screenPx.top) - (vh - ih * scale) / 2) / scale;
    if (!(x >= 0 && y >= 0 && x <= iw && y <= ih)) return null;
    return latLngFromWorldPx(
      { x: Number(meta.originPx.x) + x, y: Number(meta.originPx.y) + y },
      Number(meta.captureZoom)
    );
  }

  /* One-line provenance label for the readout chip. Pure, for tests.
     e.g. "pkg · r1alw6nz/h1.jpg · z18 · 1341×1889 · 412ms" */
  function provenanceLabel(prov) {
    if (!prov) return "";
    var frame = String(prov.url || "").split("path=").pop();
    try { frame = decodeURIComponent(frame); } catch (e) {}
    var parts = frame.split("/");
    var short = parts.slice(-2).join("/");
    var meta = prov.playSurface || {};
    var dims = meta.outputDimensions || {};
    return [
      prov.origin === "package" ? "pkg" : "visuals",
      short,
      "z" + meta.captureZoom,
      (dims.width || "?") + "×" + (dims.height || "?"),
      Number.isFinite(prov.loadMs) ? Math.round(prov.loadMs) + "ms" : null
    ].filter(Boolean).join(" · ");
  }

  return {
    worldPx: worldPx,
    provenanceLabel: provenanceLabel,
    latLngFromWorldPx: latLngFromWorldPx,
    projectToSurface: projectToSurface,
    surfaceScreenToLatLng: surfaceScreenToLatLng,
    holeSurfaceAsset: holeSurfaceAsset,
    fitContain: fitContain,
    createStore: createStore,
    assetUrl: function (path) { return "/api/course-visual-assets?path=" + encodeURIComponent(String(path || "")); }
  };
});
