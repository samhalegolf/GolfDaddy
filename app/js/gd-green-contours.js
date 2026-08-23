/* Green contours on the play surface - the phone half of the drawing.

   The maths is NOT here. It lives in scripts/gd-green-contours-core.js, which the export worker
   also loads, so the phone and the published frame cannot disagree about how a green reads.
   This file owns the two things that are genuinely the phone's: getting heights out of a PNG,
   and putting a display list onto a canvas at whatever zoom the player is actually looking at.

   WHY CLIENT-SIDE AT ALL. The same drawing is available baked into the published hole frame,
   and on that frame it is unreadable: a 32m green lands about 77 pixels wide at the export's
   0.42 m/px, where 15cm contours fall ~8px apart, the 5cm fill lands under 3px, and a 1.6m
   arrow is under four pixels. The design needs roughly 400-700px across a green. The hole frame
   cannot give that and a green-scale frame would need a capture role that only three of Jacks
   Point's eighteen holes currently have. Drawing here sidesteps both: vectors re-stroke at the
   live scale, so the green is as legible as the screen is large.

   COST, AND WHY IT IS PAID ONCE. Decoding the elevation PNG and fitting the cubic is the
   expensive part - one getImageData over the hole's DEM, then a 10x10 solve with three robust
   reweighting passes. That happens once per hole and is cached. Every repaint after it is a
   projection and a few hundred canvas strokes, which is the same order as the overlays painter
   already draws each frame. */

(function (root) {
  "use strict";

  var core = root.GDGreenContoursCore;

  /* One entry per hole. Keyed by the elevation artefact's path, which changes when a course is
     re-exported - so a fresh publish invalidates the cache without anyone remembering to. */
  var cache = Object.create(null);
  var inflight = Object.create(null);

  /* Terrain-RGB out of an <img>, via a canvas we throw away.

     The image is already in memory - painter's mesh path loads exactly this file with
     crossOrigin "anonymous" - so this costs a decode into a 2D context, not a download. The
     crossOrigin matters more than it looks: without it the canvas is tainted and getImageData
     throws, which would be indistinguishable from "this course has no elevation". */
  function heightsFromImage(img) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    var data;
    try { data = ctx.getImageData(0, 0, w, h).data; }
    catch (e) { return null; }   /* tainted canvas - treat as no elevation, never as zero height */

    var heights = new Float32Array(w * h);
    for (var i = 0, p = 0; i < heights.length; i++, p += 4) {
      /* Mapbox terrain-RGB, the encoding the worker republishes every source into. */
      heights[i] = -10000 + (data[p] * 65536 + data[p + 1] * 256 + data[p + 2]) * 0.1;
    }
    return { heights: heights, width: w, height: h };
  }

  /* Fit the green behind this hole, once.
     Resolves to a surface, or to null for every failure - no elevation, no polygon, a tainted
     canvas, a fit that will not converge, or a fit the confidence gate refuses. The caller
     treats all of those the same way: draw nothing. A green map is a finish, not the frame. */
  function surfaceFor(meta, greenShape) {
    var elevation = meta && meta.elevation;
    if (!core || !elevation || !elevation.path) return Promise.resolve(null);
    if (!greenShape || greenShape.length < 8) return Promise.resolve(null);
    if (!elevation.bounds || !elevation.metresPerPixel) return Promise.resolve(null);

    var key = elevation.path;
    if (key in cache) return Promise.resolve(cache[key]);
    if (key in inflight) return inflight[key];

    var url = (root.GDGreenContours && root.GDGreenContours.resolveUrl)
      ? root.GDGreenContours.resolveUrl(elevation.path) : elevation.path;

    inflight[key] = new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        var decoded = heightsFromImage(img);
        var surface = null;
        if (decoded) {
          try {
            surface = core.fitGreenSurface(decoded.heights, {
              width: decoded.width, height: decoded.height,
              bounds: elevation.bounds, metresPerPixel: Number(elevation.metresPerPixel)
            }, greenShape);
            /* The gate. A residual far above quantisation means this is not a putting surface;
               far below means the source was coarse DEM upsampled and knows nothing. Either way
               the honest output is no map at all. */
            if (surface && surface.summary && surface.summary.confidence === "low") surface = null;
          } catch (e) { surface = null; }
        }
        cache[key] = surface;
        delete inflight[key];
        resolve(surface);
      };
      img.onerror = function () {
        cache[key] = null;
        delete inflight[key];
        resolve(null);
      };
      img.src = url;
    });
    return inflight[key];
  }

  /* Stroke the display list onto a canvas.

     `project` is painter's projector: lat/lng -> {left, top} in viewport pixels. The canvas is
     positioned over the whole viewport, so screen coordinates ARE canvas coordinates once the
     device pixel ratio is accounted for - no second transform to keep in step with the framing.

     Everything comes back in metres and is projected here, which is why zooming re-reads
     sharply instead of scaling a bitmap: the line work is regenerated at the new scale rather
     than magnified. */
  function draw(canvas, surface, project, options) {
    if (!canvas || !surface || !project || !core) return false;
    var drawing = core.buildGreenDrawing(surface, options || {});
    if (!drawing) return false;

    var dpr = root.devicePixelRatio || 1;
    var cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (!cssW || !cssH) return false;
    var needW = Math.max(1, Math.round(cssW * dpr)), needH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== needW || canvas.height !== needH) { canvas.width = needW; canvas.height = needH; }

    var ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    var frame = surface.frame;
    var rect = canvas.getBoundingClientRect();
    function toPx(m) {
      var ll = frame.toLatLng(m.x, m.y);
      var at = project(ll);
      /* Viewport -> canvas. painter places its overlays in viewport coordinates and the canvas
         may be inset from it, so the rect offset is not always zero. */
      return at ? { x: at.left - rect.left, y: at.top - rect.top } : null;
    }

    var drew = 0;

    function strokeRun(points, colour, width, alpha) {
      if (alpha <= 0.01 || points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (var i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.strokeStyle = colour;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.stroke();
      drew++;
    }

    for (var r = 0; r < drawing.runs.length; r++) {
      var run = drawing.runs[r];
      var px = [];
      for (var i = 0; i < run.points.length; i++) {
        var p = toPx(run.points[i]);
        if (p) px.push(p);
      }
      if (px.length < 2) continue;
      if (run.haloWidthPx > 0) strokeRun(px, run.haloColour, run.haloWidthPx, run.haloAlpha);
      strokeRun(px, run.colour, run.widthPx, run.alpha);
    }

    for (var a = 0; a < drawing.arrows.length; a++) {
      var arrow = drawing.arrows[a];
      var tail = toPx(arrow.tail), head = toPx(arrow.head);
      if (!tail || !head) continue;
      var wings = core.arrowWings(tail, head);
      var shaft = [tail, head];
      var chevron = [wings[0], head, wings[1]];
      strokeRun(shaft, arrow.haloColour, arrow.haloWidthPx, arrow.haloAlpha);
      strokeRun(chevron, arrow.haloColour, arrow.haloWidthPx, arrow.haloAlpha);
      strokeRun(shaft, arrow.colour, arrow.widthPx, arrow.alpha);
      strokeRun(chevron, arrow.colour, arrow.widthPx, arrow.alpha);
    }

    ctx.globalAlpha = 1;
    return drew > 0;
  }

  function clear(canvas) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  root.GDGreenContours = {
    surfaceFor: surfaceFor,
    draw: draw,
    clear: clear,
    /* painter installs the asset-URL resolver it already uses for the mesh, so this file never
       learns anything about how storage paths become URLs. */
    resolveUrl: function (path) { return path; },
    /* Test seam and a way to force a re-fit after a fresh publish. */
    forget: function () { cache = Object.create(null); inflight = Object.create(null); }
  };
})(typeof window !== "undefined" ? window : this);
