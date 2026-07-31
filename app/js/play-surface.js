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

  /* The pre-locked hole frame, ported from the guide contract
     (scripts/inline/gd-hole-frame-guide-contract-v20.js): screen-fraction
     boxes saying where the green and tee sit while a hole is framed — green
     in the upper "hole" box, tee in the strip near the bottom. The lock and
     zoom stages arrive with shot placement; the boxes are kept now so every
     stage frames against one contract. */
  var FRAME_GUIDE = {
    zoom: { x: 0.152, y: 0.203, w: 0.687, h: 0.316 },
    lock: { x: 0.247, y: 0.203, w: 0.497, h: 0.222 },
    hole: { x: 0.308, y: 0.203, w: 0.375, h: 0.160 },
    tee:  { x: 0.308, y: 0.881, w: 0.375, h: 0.037 }
  };

  function frameAnchor(kind, viewDims) {
    var spec = FRAME_GUIDE[kind];
    if (!spec) return null;
    return {
      left: Number(viewDims.width) * (spec.x + spec.w / 2),
      top: Number(viewDims.height) * (spec.y + spec.h / 2)
    };
  }

  /* Similarity transform (rotate + uniform scale + translate, no skew) fixed
     by two point pairs: screenX = a*x - b*y + tx, screenY = b*x + a*y + ty. */
  function similarityFromPairs(p1, q1, p2, q2) {
    var dx = p2.x - p1.x, dy = p2.y - p1.y;
    var det = dx * dx + dy * dy;
    if (!(det > 0)) return null;
    var ux = q2.left - q1.left, uy = q2.top - q1.top;
    var a = (dx * ux + dy * uy) / det;
    var b = (dx * uy - dy * ux) / det;
    return { a: a, b: b, tx: q1.left - (a * p1.x - b * p1.y), ty: q1.top - (b * p1.x + a * p1.y) };
  }

  function transformApply(t, pt) {
    return { left: t.a * pt.x - t.b * pt.y + t.tx, top: t.b * pt.x + t.a * pt.y + t.ty };
  }

  function transformInvert(t, screenPt) {
    var det = t.a * t.a + t.b * t.b;
    if (!(det > 0)) return null;
    var sx = Number(screenPt.left) - t.tx, sy = Number(screenPt.top) - t.ty;
    return { x: (t.a * sx + t.b * sy) / det, y: (t.a * sy - t.b * sx) / det };
  }

  /* Pre-locked play framing: one transform that puts the hole's tee anchor on
     the tee guide box and its green anchor on the hole box — tee at the
     bottom, green up top, whatever the hole's compass bearing. Null (callers
     fall back to the contain fit) when anchors are missing or off-surface. */
  function playFrameTransform(meta, anchors, viewDims) {
    if (!meta || !anchors || !anchors.tee || !anchors.green) return null;
    if (!(Number(viewDims && viewDims.width) > 0 && Number(viewDims && viewDims.height) > 0)) return null;
    var teePx = projectToSurface(meta, anchors.tee.lat, anchors.tee.lng);
    var greenPx = projectToSurface(meta, anchors.green.lat, anchors.green.lng);
    if (!teePx || !greenPx) return null;
    return similarityFromPairs(teePx, frameAnchor("tee", viewDims), greenPx, frameAnchor("hole", viewDims));
  }

  /* One-point anchored variant of the similarity: rotation and scale are
     chosen, not solved — for stages that fit a shape rather than two pins. */
  function anchoredTransform(p, q, angleRad, scale) {
    var a = scale * Math.cos(angleRad), b = scale * Math.sin(angleRad);
    return { a: a, b: b, tx: q.left - (a * p.x - b * p.y), ty: q.top - (b * p.x + a * p.y) };
  }

  /* Stage framing against the guide contract:
       hole — tee on the tee box, green on the hole box (pre-locked)
       lock — the PLAYER on the tee box, the AIM TARGET on the lock box (the
              locked shot view is start→target; the target defaults to the
              green until the bubble moves it). Tilt is CSS on the viewport,
              not part of this matrix.
       zoom — the green filling the zoom box, approach direction up, flat
     pts: {tee, green, position, target, greenShape} in lat/lng.
     Null → contain fit. */
  function stageFrameTransform(meta, stage, pts, viewDims) {
    if (!meta || !pts) return null;
    if (!(Number(viewDims && viewDims.width) > 0 && Number(viewDims && viewDims.height) > 0)) return null;
    function px(pt) { return pt ? projectToSurface(meta, pt.lat, pt.lng) : null; }
    var greenPx = px(pts.green);
    if (!greenPx) return null;
    if (stage === "lock") {
      var posPx = px(pts.position) || px(pts.tee);
      var aimPx = px(pts.target) || greenPx;
      if (!posPx) return null;
      return similarityFromPairs(posPx, frameAnchor("tee", viewDims), aimPx, frameAnchor("lock", viewDims));
    }
    if (stage === "zoom") {
      var fromPx = px(pts.position) || px(pts.tee);
      var dx = fromPx ? greenPx.x - fromPx.x : 0;
      var dy = fromPx ? greenPx.y - fromPx.y : -1;
      /* Rotate the approach direction to screen-up (0,-1). */
      var angle = Math.atan2(-1, 0) - Math.atan2(dy, dx);
      var radius = 0;
      (Array.isArray(pts.greenShape) ? pts.greenShape : []).forEach(function (p) {
        var sp = px(p);
        if (sp) radius = Math.max(radius, Math.hypot(sp.x - greenPx.x, sp.y - greenPx.y));
      });
      if (!(radius > 0)) radius = 25;   // ~15m at the observed z18 when a green has no shape
      var box = FRAME_GUIDE.zoom;
      var boxMin = Math.min(Number(viewDims.width) * box.w, Number(viewDims.height) * box.h);
      return anchoredTransform(greenPx, frameAnchor("zoom", viewDims), angle, (0.55 * boxMin) / (2 * radius));
    }
    var teePx = px(pts.tee);
    if (!teePx) return null;
    return similarityFromPairs(teePx, frameAnchor("tee", viewDims), greenPx, frameAnchor("hole", viewDims));
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
    frameAnchor: frameAnchor,
    similarityFromPairs: similarityFromPairs,
    transformApply: transformApply,
    transformInvert: transformInvert,
    anchoredTransform: anchoredTransform,
    stageFrameTransform: stageFrameTransform,
    playFrameTransform: playFrameTransform,
    latLngFromWorldPx: latLngFromWorldPx,
    projectToSurface: projectToSurface,
    surfaceScreenToLatLng: surfaceScreenToLatLng,
    holeSurfaceAsset: holeSurfaceAsset,
    fitContain: fitContain,
    createStore: createStore,
    assetUrl: function (path) { return "/api/course-visual-assets?path=" + encodeURIComponent(String(path || "")); }
  };
});
