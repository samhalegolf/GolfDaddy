/* Watch Map generation core - pure geometry/transform/SVG-string logic, no DOM, no canvas,
   no sharp, no fetch. Loaded two ways, same policy as scripts/gd-green-contours-core.js:
     - browser, via <script data-gd-surface="studio"> in index.html, as window.GDWatchMapCore
     - Netlify function, via import from functions/course-watch-maps.mjs
   (pinned in netlify.toml [functions].included_files, same convention as the other scripts/
   files functions/ code imports).

   This is a DELIBERATELY SEPARATE pipeline from scripts/gd-course-visual-engine.js. The native
   engine bakes satellite/aerial tile CAPTURES with a recipe of image filters (tone, saturation,
   terrain shading); it never draws the mapped tee/green/bunker/fairway/water OBJECTS as shapes.
   The Watch map is the opposite: a small, flat, vector rendering of those objects themselves -
   no imagery, no filters - built straight from course_maps.objects_json. Nothing here reads or
   writes course_visuals, course_visual_jobs, or the native recipe/preset system, and generating
   a Watch map must never be able to change what GPS Play or the native visual shows.

   Geo<->pixel projection reuses the exact Web Mercator basis and similarity-transform formulas
   already proven in app/js/play-surface.js (worldPx/latLngFromWorldPx, transformApply/Invert,
   anchoredTransform - see that file's header). They are re-implemented here rather than required
   from app/js/, because app/js/ is the "app" build surface and scripts/ is what both build
   surfaces (and Netlify functions, via included_files) can share without pulling GPS Play's own
   module into a server cold start - the same boundary dev/generate-visual-engine-client.js draws
   for the visual engine. The maths is intentionally identical, not just similar. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.ClarityApp = root.ClarityApp || {}; root.ClarityApp.watchMapCore = api; root.GDWatchMapCore = api; }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var TILE = 256;
  var EARTH_RADIUS_M = 6378137;
  /* Integer zoom used as the projection basis for every generated Watch map. Matches
     app/js/painter.js's REF_ZOOM - not load-bearing that it match, just no reason to invent a
     second reference zoom when hole-scale precision is identical at either. */
  var REF_ZOOM = 20;

  var WATCH_MAP_RECIPE_V1 = {
    id: "watch-map-v1",
    /* v2 added the play corridor. v1 framed on the union of every mapped object,
       which on this codebase's cloning model means every surface inside the
       hole's axis-aligned capture box - 19.3ha for a 507m diagonal par 5. The
       result was a canvas framed on the neighbourhood: Millbrook's 1st drew six
       fairway corridors, five of them 104-233m off the play line, and spent
       under 9% of its width on the hole being played.

       v3 added corner-smoothing on every decimated polygon (simplify.smoothPasses)
       and, when a satellite bake's per-hole elevation crop is available, terrain
       shading + thin green slope contours baked into the shipped image itself -
       see buildGroundSvg/buildMarkersSvg and functions/course-watch-maps.mjs's
       terrain step. Both are purely cosmetic: they change no framing, no
       projection, and nothing buildHoleReference measures, so a v2 package still
       reads correctly and only needs a re-bake to pick up the new look. */
    version: 3,
    canvas: {
      /* Ceiling, not a fixed size - see computeCanvasFit. Most holes land under both ceilings;
         a long narrow par 5 is height-limited, a short wide-corridor hole is width-limited. */
      targetWidthPx: 448,
      maxHeightPx: 1536,
      minSpanPx: 96,
      /* Padding around the framed corridor, as a fraction of its own span.
         teeMarginFraction is extra padding added only below the tee, so the Watch
         viewport has room to show the player standing behind their ball. */
      marginFraction: 0.14,
      teeMarginFraction: 0.16
    },
    /* The play corridor: how far either side of the hole's own route this map is
       about. It decides FRAMING ONLY - which ground the canvas is fitted to -
       and never which objects are drawn. A surface outside it is still rendered
       and simply falls off the edge of the viewBox, exactly as ground outside
       an aerial capture's frame does. That split is deliberate: filtering whole
       polygons instead was tried and does not work, because 15 of Millbrook's
       24 OSM fairway ways are multi-hole ribbons (median bounding diagonal
       193m, largest 403m across seven holes) - keeping one because a single
       vertex is near the route drags 300m of a neighbouring hole back into the
       frame, and dropping it deletes the near part the player can actually see.

       55m is measured, not guessed: a mapped fairway sits within ~25m of the
       route, and greenside bunkers within ~40m, so this keeps a hole's own
       surrounds while excluding the next fairway over. */
    corridor: {
      halfWidthM: 55
    },
    simplify: {
      /* Vertex decimation distance and minimum kept-polygon area, both in OUTPUT pixels (i.e.
         applied after the fit scale, so the thresholds mean the same thing on every hole
         regardless of how much ground one pixel covers). */
      minVertexSpacingPx: 2.5,
      minPolygonAreaPx2: 24,
      /* Corner-rounding passes run on every decimated ring (see smoothClosedPolygon), so the
         jagged, hand-drawn/OSM-derived turns left by simplifyPoints don't bake straight into a
         watch-scale image. Same technique functions/lib/gd-green-shape-core.mjs's smoothPoints
         uses for detected green outlines; 2 passes is enough to round a saw-tooth corner without
         eating a real point (a fairway dogleg, a bunker's own shape). */
      smoothPasses: 2
    },
    colors: {
      background: "#3c6b45",
      fairway: "#6fbf5e",
      green: "#a3e08f",
      bunker: "#e9d9a8",
      water: "#4f8fd1",
      tee: "#f4f4f2",
      outline: "rgba(8,18,8,0.35)"
    },
    strokeWidthPx: 1.25,
    teeMarkerRadiusPx: 5,
    fallbackGreenRadiusPx: 10
  };

  // ---------------------------------------------------------------- mercator projection

  function worldPx(lat, lng, zoom) {
    if (!Number.isInteger(zoom)) throw new Error("zoom must be an integer, got " + zoom);
    var scale = TILE * Math.pow(2, zoom);
    var latRad = (Math.max(-85.05112878, Math.min(85.05112878, Number(lat))) * Math.PI) / 180;
    return {
      x: ((Number(lng) + 180) / 360) * scale,
      y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale
    };
  }

  function latLngFromWorldPx(px, zoom) {
    if (!Number.isInteger(zoom)) throw new Error("zoom must be an integer, got " + zoom);
    var scale = TILE * Math.pow(2, zoom);
    var n = Math.PI * (1 - (2 * Number(px.y)) / scale);
    return {
      lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
      lng: (Number(px.x) / scale) * 360 - 180
    };
  }

  /* Metres per world-mercator pixel at a given latitude/zoom - the standard "ground
     resolution" formula. Used only to report metresPerPixel in the stored spatial
     reference; the transform itself never needs it. */
  function groundResolutionMPerPx(lat, zoom) {
    var latRad = (Number(lat) * Math.PI) / 180;
    return (Math.cos(latRad) * 2 * Math.PI * EARTH_RADIUS_M) / (TILE * Math.pow(2, zoom));
  }

  // ---------------------------------------------------------------- similarity transform
  // Identical formulas to app/js/play-surface.js's transformApply/transformInvert/anchoredTransform.

  function applyTransform(t, pt) {
    return { x: t.a * pt.x - t.b * pt.y + t.tx, y: t.b * pt.x + t.a * pt.y + t.ty };
  }

  function invertTransform(t, pt) {
    var det = t.a * t.a + t.b * t.b;
    if (!(det > 0)) return null;
    var sx = Number(pt.x) - t.tx, sy = Number(pt.y) - t.ty;
    return { x: (t.a * sx + t.b * sy) / det, y: (t.a * sy - t.b * sx) / det };
  }

  /* One point pair fixes rotation+scale+translate: p (world px) must map to q (image px). */
  function anchoredTransform(p, q, angleRad, scale) {
    var a = scale * Math.cos(angleRad), b = scale * Math.sin(angleRad);
    return { a: a, b: b, tx: q.x - (a * p.x - b * p.y), ty: q.y - (b * p.x + a * p.y) };
  }

  function rotate(pt, angleRad) {
    var c = Math.cos(angleRad), s = Math.sin(angleRad);
    return { x: c * pt.x - s * pt.y, y: s * pt.x + c * pt.y };
  }

  /* Rotation that puts the tee->green vector straight up (0,-1) on the canvas, whatever the
     hole's real-world compass bearing. Same formula as app/js/play-surface.js's stageFrame
     "zoom" stage (`Math.atan2(-1, 0) - Math.atan2(dy, dx)`), which already solves exactly this
     problem for the live GPS camera - reused rather than re-derived. */
  function holeBearingRadians(teeWorldPx, greenWorldPx) {
    var dx = greenWorldPx.x - teeWorldPx.x, dy = greenWorldPx.y - teeWorldPx.y;
    return Math.atan2(-1, 0) - Math.atan2(dy, dx);
  }

  // ---------------------------------------------------------------- geometry extraction

  var POLYGON_TYPES = { fairway_area: "fairways", bunker: "bunkers", water: "water" };

  function finitePoint(value) {
    var lat = Number(value && value.lat), lng = Number(value && value.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  function finiteShape(shape) {
    if (!Array.isArray(shape)) return null;
    var out = [];
    for (var i = 0; i < shape.length; i++) {
      var p = finitePoint(shape[i]);
      if (p) out.push(p);
    }
    return out.length >= 3 ? out : null;
  }

  /* Pulls one hole's mapped objects out of course_maps.objects_json, in the shape this module
     draws from. Mirrors the grouping in functions/lib/gd-course-package-shape.mjs
     (objectsByHole/surfacesFor) - not imported from it, because that file is ESM-only and lives
     under functions/lib (Node-only), while this module must also run in the browser; the
     grouping itself is a handful of lines, not the kind of logic worth a cross-surface import
     for. Any object type this codebase does not currently collect (rough, out-of-bounds) is
     simply absent from the result - callers must treat every layer but green as optional. */
  function objectsForHole(objectsJson, holeNumber) {
    var hole = Number(holeNumber);
    var tee = null, green = null, greenShape = null;
    var fairways = [], bunkers = [], water = [], route = [];
    Object.keys(objectsJson || {}).forEach(function (key) {
      var object = objectsJson[key];
      if (!object || Number(object.holeNumber) !== hole) return;
      /* Type "fairway" is a route BEND POINT, not a surface - the guide points a
         hole is drawn through. Type "fairway_area" below is the polygon. */
      if (object.type === "fairway") {
        var bend = finitePoint(object.position);
        if (bend) route.push(bend);
        return;
      }
      if (object.type === "tee" && !tee) tee = finitePoint(object.position);
      else if (object.type === "green") {
        if (!green) green = finitePoint(object.position);
        var shape = finiteShape(object.greenShape || object.shape);
        if (shape && !greenShape) greenShape = shape;
      } else if (POLYGON_TYPES[object.type]) {
        var poly = finiteShape(object.shape);
        if (poly) {
          var bucket = POLYGON_TYPES[object.type] === "fairways" ? fairways : POLYGON_TYPES[object.type] === "bunkers" ? bunkers : water;
          bucket.push(poly);
        }
      }
    });
    return { tee: tee, green: green, greenShape: greenShape, route: route, fairways: fairways, bunkers: bunkers, water: water };
  }

  /* tee -> bends -> green, with the bends ordered by how far down the hole they
     sit rather than by their key order in objects_json.

     packageHoleData (gd-visual-plan-core.mjs) takes them in object-key order,
     which happens to be chronological for courses whose ids embed a creation
     timestamp. That is fine there, because a capture frame only needs the
     bounding box of the route and a shuffled route has the same box. Here the
     order is load-bearing - a corridor measured along a zig-zagged route is not
     the corridor of the hole - so it is derived from the geometry instead of
     inherited from a key order nothing guarantees. */
  function orderedRoute(tee, bends, green) {
    var start = worldPx(tee.lat, tee.lng, REF_ZOOM);
    var end = worldPx(green.lat, green.lng, REF_ZOOM);
    var ax = end.x - start.x, ay = end.y - start.y;
    var len2 = ax * ax + ay * ay;
    var ordered = (bends || []).map(function (bend) {
      var px = worldPx(bend.lat, bend.lng, REF_ZOOM);
      var along = len2 > 0 ? ((px.x - start.x) * ax + (px.y - start.y) * ay) / len2 : 0;
      return { point: bend, along: along };
    }).sort(function (a, b) { return a.along - b.along; });
    return [tee].concat(ordered.map(function (entry) { return entry.point; })).concat([green]);
  }

  function pointToSegmentDistance(p, a, b) {
    var vx = b.x - a.x, vy = b.y - a.y;
    var wx = p.x - a.x, wy = p.y - a.y;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
    return Math.hypot(wx - vx * t, wy - vy * t);
  }

  /* Web Mercator is conformal, so at one hole's scale a circle of N metres is a
     circle of N/groundResolution pixels - which is what lets the corridor test
     run in world pixels rather than converting every vertex to metres. */
  function distanceToPolyline(p, polyline) {
    if (polyline.length === 1) return Math.hypot(p.x - polyline[0].x, p.y - polyline[0].y);
    var best = Infinity;
    for (var i = 0; i < polyline.length - 1; i++) {
      var d = pointToSegmentDistance(p, polyline[i], polyline[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  // ---------------------------------------------------------------- hole reference

  /* Metres between two coordinates at hole scale.

     Equirectangular against the SAME 111320 m/degree the rest of the Watch
     pipeline uses - app/js/caddy-watch.js's localPoint and the wrist's own
     WristDistances in ShotView.swift. It is 2*pi*EARTH_RADIUS_M/360 rounded,
     so it is not a different earth; but writing the unrounded constant here
     would make the bake and the wrist disagree about a hole's length by a
     metre or two for no reason anybody could later explain. */
  function metresBetween(a, b) {
    var north = (b.lat - a.lat) * 111320;
    var east = (b.lng - a.lng) * 111320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    return Math.hypot(north, east);
  }

  function polylineLengthM(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) total += metresBetween(points[i - 1], points[i]);
    return total;
  }

  /* Decimates a lat/lng ring to the coarseness the DRAWN outline already has,
     by converting the recipe's output-pixel spacing back into metres through
     this hole's own metresPerPixel. Same policy as simplifyPoints (plain
     distance decimation, last point always kept), and the emitted coordinates
     are the source ones - never a coordinate round-tripped out through the
     transform, which would bake the projection's rounding into the geometry
     the wrist measures distances against. */
  function decimateLatLng(points, minSpacingM) {
    if (points.length <= 4 || !(minSpacingM > 0)) return points.slice();
    var out = [points[0]];
    for (var i = 1; i < points.length; i++) {
      if (metresBetween(points[i], out[out.length - 1]) >= minSpacingM || i === points.length - 1) out.push(points[i]);
    }
    return out;
  }

  /* ~0.11m of latitude. Finer than any distance the Watch displays, and it
     keeps a route plus a green ring under a few hundred bytes. */
  function referencePoint(p) {
    return { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 };
  }

  /* The hole's golf geometry, travelling with the image that was drawn from it.

     WHY IT IS HERE. Everything below was already computed to draw the hole and
     was then discarded: objectsForHole reads the tee, green, green shape and
     bend points; buildWatchHoleFrame orders them into the play line. Only
     `layers` - a set of COUNTS - used to survive, so the wrist received a
     picture of a hole it could not measure anything against, and every Bubble
     it drew had to be computed on the phone and sent over.

     WHAT IS NOT HERE. `checkpoints.greenFront/greenBack` stay behind as
     spatial-reference validation only. They are the nearest and farthest green
     vertex FROM THE TEE, ranked in raw degree space, so they are neither the
     player's front and back once they have left the tee nor a true metric
     ranking. The wrist already answers that question properly from the polygon
     against its own fix (WristDistances), so shipping a fixed pair beside the
     shape it is derived from would only invite something to use the wrong one.

     A hole with no mapped tee has no play line: `tee`, `route`, `bearingDeg`
     and `lengthM` are all null rather than measured from the green standing in
     for the tee. Per objectsForHole's contract every layer but the green is
     optional, and the wrist's rule for a missing input is to defer to the
     phone, never to approximate. */
  function buildHoleReference(recipe, spatialRef, geometry, routeLatLng) {
    var hasTee = !!geometry.tee;
    var spacingM = Number(spatialRef.metresPerPixel) * recipe.simplify.minVertexSpacingPx;
    return {
      version: 1,
      tee: hasTee ? referencePoint(geometry.tee) : null,
      green: referencePoint(geometry.green),
      greenShape: geometry.greenShape ? decimateLatLng(geometry.greenShape, spacingM).map(referencePoint) : null,
      route: hasTee ? routeLatLng.map(referencePoint) : null,
      /* The hole's compass bearing, tee to green, derived from the transform
         rather than measured a second time. rotationDegrees is the rotation
         applied to stand the hole up on the canvas, which is the NEGATIVE of
         the bearing it was standing at: holeBearingRadians is
         `atan2(-1,0) - atan2(dy,dx)` in world pixels, and the compass bearing
         of the same vector is `atan2(dx,-dy)`, which works out to exactly its
         negation. Mercator is conformal, so that angle is the map's and the
         ground's alike at one hole's scale. Taking it from the transform means
         it cannot drift from the picture: any framing change moves both. */
      bearingDeg: hasTee ? Math.round(((360 - Number(spatialRef.rotationDegrees)) % 360) * 100) / 100 : null,
      lengthM: hasTee ? Math.round(polylineLengthM(routeLatLng)) : null
    };
  }

  // ---------------------------------------------------------------- framing

  function polygonAreaPx2(points) {
    var area = 0;
    for (var i = 0; i < points.length; i++) {
      var a = points[i], b = points[(i + 1) % points.length];
      area += a.x * b.y - b.x * a.y;
    }
    return Math.abs(area) / 2;
  }

  /* Drops points closer than minSpacing to the last kept point. Not Douglas-Peucker - a plain
     distance decimation - but it does what the recipe asks: fewer vertices, smaller encoded
     SVG/paths, no visible loss at Watch scale. The polygon's own closing point is always kept
     so the shape does not gape. */
  function simplifyPoints(points, minSpacing) {
    if (points.length <= 4 || !(minSpacing > 0)) return points;
    var out = [points[0]];
    for (var i = 1; i < points.length; i++) {
      var last = out[out.length - 1];
      var d = Math.hypot(points[i].x - last.x, points[i].y - last.y);
      if (d >= minSpacing || i === points.length - 1) out.push(points[i]);
    }
    return out;
  }

  /* Rounds off jagged corners left by decimation - the raw shapes are hand-drawn or cloned from
     OSM ways and often carry sharp saw-tooth turns that read as noise at Watch scale, where a
     handful of pixels is the whole width of a bunker. Weighted-neighbour blending against each
     point's own ring neighbours, the same technique functions/lib/gd-green-shape-core.mjs's
     smoothPoints uses for detected green outlines - closed here (wraps around, since every
     polygon this recipe draws is a closed ring) rather than that module's open contour case.

     Runs AFTER simplifyPoints, deliberately: smoothing hundreds of near-duplicate points would
     spend its passes averaging noise instead of rounding real corners, and decimation's own job
     is to remove exactly those points first. Left alone below 5 points - a triangle or the
     recipe's own minimum has no "corner" to round, only a shape smoothing would collapse. */
  function smoothClosedPolygon(points, passes) {
    if (points.length < 5 || !(passes > 0)) return points;
    var out = points.map(function (p) { return { x: p.x, y: p.y }; });
    for (var pass = 0; pass < passes; pass++) {
      out = out.map(function (p, i) {
        var prev = out[(i - 1 + out.length) % out.length];
        var next = out[(i + 1) % out.length];
        return { x: p.x * 0.5 + prev.x * 0.25 + next.x * 0.25, y: p.y * 0.5 + prev.y * 0.25 + next.y * 0.25 };
      });
    }
    return out;
  }

  /* Projects every polygon through the transform, decimates points, smooths the surviving
     corners, and drops any polygon that ends up smaller than the recipe's noise floor -
     "insignificant isolated objects" in the task's words. Returns image-pixel point lists only;
     nothing here needs lat/lng again. */
  function projectAndSimplifyPolygons(polygons, spatialRef, recipe) {
    var out = [];
    (polygons || []).forEach(function (shape) {
      var projected = shape.map(function (p) { return projectLatLngToImage(spatialRef, p.lat, p.lng); });
      var simplified = simplifyPoints(projected, recipe.simplify.minVertexSpacingPx);
      var smoothed = smoothClosedPolygon(simplified, recipe.simplify.smoothPasses);
      if (smoothed.length < 3 || polygonAreaPx2(smoothed) < recipe.simplify.minPolygonAreaPx2) return;
      if (!touchesCanvas(smoothed, spatialRef)) return;
      out.push(smoothed);
    });
    return out;
  }

  /* Anything wholly outside the canvas is bytes nobody can see, so it is dropped
     here. A polygon that only PARTLY overlaps is kept whole and cropped by the
     SVG viewBox - not clipped to the canvas rectangle. Clipping would draw this
     recipe's outline stroke along the cut, putting a dark line down the edge of
     the image wherever a fairway ran off it; letting the viewport crop leaves
     the same clean edge an aerial capture has. */
  function touchesCanvas(points, spatialRef) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return maxX >= 0 && minX <= spatialRef.imageWidth && maxY >= 0 && minY <= spatialRef.imageHeight;
  }

  /* Fits the union of every mapped point into a canvas no wider than canvas.targetWidthPx and
     no taller than canvas.maxHeightPx - a "contain" fit (same idea as play-surface.js's
     fitContain), computed in the hole-oriented rotated space so the fit respects the
     tee-up/green-up framing rather than the raw unrotated bounding box. */
  function computeCanvasFit(rotatedPoints, canvas) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rotatedPoints.forEach(function (p) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    });
    var spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    var marginX = spanX * canvas.marginFraction;
    var marginTop = spanY * canvas.marginFraction;
    var marginBottom = spanY * (canvas.marginFraction + canvas.teeMarginFraction);
    var boundsMinX = minX - marginX, boundsMinY = minY - marginTop;
    var boundsWidth = spanX + marginX * 2;
    var boundsHeight = spanY + marginTop + marginBottom;
    var scale = Math.min(canvas.targetWidthPx / boundsWidth, canvas.maxHeightPx / boundsHeight);
    if (!(scale > 0) || !Number.isFinite(scale)) scale = 1;
    var imageWidth = Math.max(canvas.minSpanPx, Math.round(boundsWidth * scale));
    var imageHeight = Math.max(canvas.minSpanPx, Math.round(boundsHeight * scale));
    return { originRotated: { x: boundsMinX, y: boundsMinY }, scale: scale, imageWidth: imageWidth, imageHeight: imageHeight };
  }

  // ---------------------------------------------------------------- public projection API

  function projectLatLngToImage(spatialRef, lat, lng) {
    return applyTransform(spatialRef.transform, worldPx(lat, lng, spatialRef.refZoom));
  }

  function projectImageToLatLng(spatialRef, imagePx) {
    var world = invertTransform(spatialRef.transform, imagePx);
    return world ? latLngFromWorldPx(world, spatialRef.refZoom) : null;
  }

  /* Sanity-checks the transform the way the task asks: known geo coordinates should land
     inside the image and in the expected relative position, not just anywhere. Catches a
     flipped axis, a wrong rotation sign, a wrong origin or a wrong scale - the obvious
     transform bugs - without attempting real computer-vision verification. */
  function validateSpatialReference(spatialRef, checkpoints) {
    var issues = [];
    function project(name, latLng) {
      if (!latLng) return null;
      var px = projectLatLngToImage(spatialRef, latLng.lat, latLng.lng);
      var margin = Math.max(spatialRef.imageWidth, spatialRef.imageHeight) * 0.25;
      if (px.x < -margin || px.y < -margin || px.x > spatialRef.imageWidth + margin || px.y > spatialRef.imageHeight + margin) {
        issues.push(name + " projects outside the image (" + Math.round(px.x) + "," + Math.round(px.y) + ")");
      }
      return px;
    }
    var teePx = project("tee", checkpoints.tee);
    var greenPx = project("green", checkpoints.green);
    project("greenFront", checkpoints.greenFront);
    project("greenBack", checkpoints.greenBack);
    if (teePx && greenPx && !(teePx.y > greenPx.y - 1)) {
      issues.push("tee does not sit below green in image space - rotation or axis looks flipped");
    }
    return { ok: issues.length === 0, issues: issues };
  }

  // ---------------------------------------------------------------- wearable delivery

  /* What the wrist's radio will actually accept, which is not the same question
     as what this pipeline can draw.

     The bake ships WebP; the phone re-encodes every hole to JPEG on the way to
     the watch, because watchOS ImageIO has no WebP decoder. That re-encode is
     where a package meets a limit nothing else here can see. WCSession's
     sendMessage refuses a payload over 65,536 bytes outright, and on this
     two-target Watch app the queued transferFile fallback is not dependable, so
     a refused hole is simply a hole the player never gets.

     It has already happened once. Recipe v3 draws far more than the recipe the
     phone's fixed quality 0.8 was measured against, and it pushed 8 of
     Millbrook's 18 holes to 66-88KB - every one refused, in silence, leaving
     the wrist at 10 of 18. The phone now steps quality down per hole to fit
     (AppleWatchTransport.watchDecodableBytes), so this ladder is a copy of a
     decision made in Swift. It is copied here rather than left there because
     the GENERATOR is the only thing that can notice the trend early: it can
     measure what it just baked and say, in the package report, which holes only
     arrive squeezed and which would not arrive at all.

     A BUDGET, not the cap: the descriptor (course key, package version, asset
     name) and WatchConnectivity's own framing ride in the same payload. */
  var WEARABLE_DELIVERY = {
    liveMessageCapBytes: 65536,
    assetBudgetBytes: 60000,
    /* 0.8 is the hole as baked. Below it the wrist is looking at a softer
       picture than the one on file - which on a map drawn about 190pt wide
       costs nothing anybody can see, where being refused costs the hole. */
    transcodeQuality: [0.8, 0.6, 0.45, 0.3, 0.2]
  };

  /* The verdict for one hole, given what it weighs as JPEG at each quality in
     `transcodeQuality`. The sizes are measured by whoever can actually encode -
     the generator has sharp, and this file deliberately has neither sharp nor a
     canvas - so this is only the rule, applied to their numbers.

     Those numbers must be in the PHONE's bytes, not the measurer's. The two are
     not the same: sharp writes 1.75-1.84x smaller than iOS's ImageIO at the
     same quality (measured across all 18 Millbrook holes), so a caller handing
     over its own raw byte counts would have this call an 88KB hole a
     comfortable fit. Converting is the caller's job because only the caller
     knows which encoder it used - see measureDelivery.

     `squeezed` is the interesting one: the hole fits, but only because the
     phone dropped it below the baked quality. One squeezed hole is a hole; a
     package full of them is a recipe drawing more than the wrist can carry, and
     the report is where that should become visible. */
  function wearableDeliveryVerdict(sizesByQuality) {
    var ladder = WEARABLE_DELIVERY.transcodeQuality;
    var sizes = sizesByQuality || {};
    for (var i = 0; i < ladder.length; i++) {
      var quality = ladder[i];
      var bytes = Number(sizes[quality]);
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      if (bytes <= WEARABLE_DELIVERY.assetBudgetBytes) {
        return {
          ok: true,
          quality: quality,
          bytes: bytes,
          squeezed: i > 0,
          budgetBytes: WEARABLE_DELIVERY.assetBudgetBytes,
          capBytes: WEARABLE_DELIVERY.liveMessageCapBytes
        };
      }
    }
    /* Nothing on the ladder fits. The phone has a halved-pixel fallback below
       this, so the hole is not necessarily lost - but a hole that has to be
       thrown away at half resolution to travel is a bake this pipeline should
       be reporting, not quietly relying on the phone to rescue. */
    var floor = ladder[ladder.length - 1];
    return {
      ok: false,
      quality: floor,
      bytes: Number(sizes[floor]) || null,
      squeezed: true,
      budgetBytes: WEARABLE_DELIVERY.assetBudgetBytes,
      capBytes: WEARABLE_DELIVERY.liveMessageCapBytes
    };
  }

  // ---------------------------------------------------------------- SVG rendering

  function polygonPointsAttr(points) {
    return points.map(function (p) { return (Math.round(p.x * 10) / 10) + "," + (Math.round(p.y * 10) / 10); }).join(" ");
  }

  function svgOpen(w, h) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">';
  }

  function drawGroundLayers(parts, recipe, projected) {
    function layer(polys, fill) {
      polys.forEach(function (points) {
        parts.push('<polygon points="' + polygonPointsAttr(points) + '" fill="' + fill + '" stroke="' + recipe.colors.outline + '" stroke-width="' + recipe.strokeWidthPx + '"/>');
      });
    }
    layer(projected.fairways, recipe.colors.fairway);
    layer(projected.bunkers, recipe.colors.bunker);
    layer(projected.water, recipe.colors.water);
    if (projected.greenPolygon) layer([projected.greenPolygon], recipe.colors.green);
    else if (projected.greenPx) {
      parts.push('<circle cx="' + projected.greenPx.x + '" cy="' + projected.greenPx.y + '" r="' + recipe.fallbackGreenRadiusPx + '" fill="' + recipe.colors.green + '" stroke="' + recipe.colors.outline + '" stroke-width="' + recipe.strokeWidthPx + '"/>');
    }
  }

  function drawMarkerLayers(parts, recipe, projected) {
    if (projected.teePx) {
      parts.push('<circle cx="' + projected.teePx.x + '" cy="' + projected.teePx.y + '" r="' + recipe.teeMarkerRadiusPx + '" fill="' + recipe.colors.tee + '" stroke="' + recipe.colors.outline + '" stroke-width="' + recipe.strokeWidthPx + '"/>');
    }
  }

  /* The ground alone: background fill plus every mapped surface. Rendered and rasterized on its
     own by the caller when a terrain shading pass is available, so relief can be laid over real
     ground pixels and BEFORE the crisp un-shaded markers go on top - shading a tee marker would
     be shading a piece of UI, not ground. Opaque (carries its own background rect), unlike
     buildMarkersSvg. */
  function buildGroundSvg(recipe, spatialRef, projected) {
    var w = spatialRef.imageWidth, h = spatialRef.imageHeight;
    var parts = [svgOpen(w, h)];
    parts.push('<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="' + recipe.colors.background + '"/>');
    drawGroundLayers(parts, recipe, projected);
    parts.push("</svg>");
    return parts.join("");
  }

  /* Just the tee marker, over a transparent background - a compositing layer meant to sit above
     ground + relief + green contours, never rendered standalone. */
  function buildMarkersSvg(recipe, spatialRef, projected) {
    var w = spatialRef.imageWidth, h = spatialRef.imageHeight;
    var parts = [svgOpen(w, h)];
    drawMarkerLayers(parts, recipe, projected);
    parts.push("</svg>");
    return parts.join("");
  }

  /* Ground + markers in one document - the whole picture with no terrain pass, and the fast
     path every existing caller/test still gets by reading frame.svg. */
  function buildHoleSvg(recipe, spatialRef, projected) {
    var w = spatialRef.imageWidth, h = spatialRef.imageHeight;
    var parts = [svgOpen(w, h)];
    parts.push('<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="' + recipe.colors.background + '"/>');
    drawGroundLayers(parts, recipe, projected);
    drawMarkerLayers(parts, recipe, projected);
    parts.push("</svg>");
    return parts.join("");
  }

  // ---------------------------------------------------------------- orchestration

  /* The one entry point callers need. geometry is objectsForHole()'s return shape (or anything
     with the same {tee, green, greenShape, fairways, bunkers, water} fields). Returns
     {ok:false, reason} when there is no green to build against - a hole with no green cannot
     answer any distance, the same floor functions/lib/gd-course-package-shape.mjs applies to
     the native package. Otherwise returns {ok:true, svg, width, height, spatialReference,
     reference, validation, layers} where `reference` is the hole's golf geometry for the wrist
     (see buildHoleReference) and `layers` records what was actually drawn, for the generation
     report (omitted/simplified geometry). */
  function buildWatchHoleFrame(recipe, geometry, opts) {
    recipe = recipe || WATCH_MAP_RECIPE_V1;
    opts = opts || {};
    var refZoom = Number.isInteger(opts.refZoom) ? opts.refZoom : REF_ZOOM;
    if (!geometry || !geometry.green) return { ok: false, reason: "no green geometry for this hole" };
    var green = geometry.green;
    var tee = geometry.tee || green; // no tee mapped: fall back to framing on the green alone
    var teeWorld = worldPx(tee.lat, tee.lng, refZoom);
    var greenWorld = worldPx(green.lat, green.lng, refZoom);
    var bearing = teeWorld.x === greenWorld.x && teeWorld.y === greenWorld.y ? 0 : holeBearingRadians(teeWorld, greenWorld);

    /* What the canvas is fitted to: the hole itself, plus only those surface
       vertices that fall inside the play corridor. Taking corridor VERTICES
       rather than whole polygons is the point - a 403m ribbon that clips the
       corridor contributes the few metres of itself that are actually beside
       this hole, and the frame no longer stretches to contain the rest of it.
       Every polygon is still drawn; see projectAndSimplifyPolygons. */
    var routeLatLng = orderedRoute(tee, geometry.route, green);
    var routeWorld = routeLatLng.map(function (p) { return worldPx(p.lat, p.lng, refZoom); });
    var corridorPx = recipe.corridor.halfWidthM / groundResolutionMPerPx(tee.lat, refZoom);
    var framePoints = [tee, green].concat(geometry.greenShape || []).concat(routeLatLng);
    (geometry.fairways || []).concat(geometry.bunkers || []).concat(geometry.water || []).forEach(function (polygon) {
      polygon.forEach(function (p) {
        if (distanceToPolyline(worldPx(p.lat, p.lng, refZoom), routeWorld) <= corridorPx) framePoints.push(p);
      });
    });
    var rotated = framePoints.map(function (p) {
      var world = worldPx(p.lat, p.lng, refZoom);
      return rotate({ x: world.x - teeWorld.x, y: world.y - teeWorld.y }, bearing);
    });
    var fit = computeCanvasFit(rotated, recipe.canvas);
    var teeImagePx = { x: -fit.originRotated.x * fit.scale, y: -fit.originRotated.y * fit.scale };
    var transform = anchoredTransform(teeWorld, teeImagePx, bearing, fit.scale);

    var spatialRef = {
      version: 1,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      refZoom: refZoom,
      transform: transform,
      imageWidth: fit.imageWidth,
      imageHeight: fit.imageHeight,
      rotationDegrees: ((bearing * 180) / Math.PI + 360) % 360,
      metresPerPixel: groundResolutionMPerPx(tee.lat, refZoom) / fit.scale
    };
    var originLatLng = projectImageToLatLng(spatialRef, { x: 0, y: 0 });
    spatialRef.originLat = originLatLng ? originLatLng.lat : null;
    spatialRef.originLon = originLatLng ? originLatLng.lng : null;

    var projected = {
      fairways: projectAndSimplifyPolygons(geometry.fairways, spatialRef, recipe),
      bunkers: projectAndSimplifyPolygons(geometry.bunkers, spatialRef, recipe),
      water: projectAndSimplifyPolygons(geometry.water, spatialRef, recipe),
      greenPolygon: null,
      greenPx: projectLatLngToImage(spatialRef, green.lat, green.lng),
      teePx: geometry.tee ? projectLatLngToImage(spatialRef, tee.lat, tee.lng) : null
    };
    if (geometry.greenShape) {
      var greenProjected = projectAndSimplifyPolygons([geometry.greenShape], spatialRef, recipe);
      projected.greenPolygon = greenProjected[0] || null;
    }

    var svg = buildHoleSvg(recipe, spatialRef, projected);
    var groundSvg = buildGroundSvg(recipe, spatialRef, projected);
    var markersSvg = buildMarkersSvg(recipe, spatialRef, projected);
    var checkpoints = { tee: tee, green: green };
    if (geometry.greenShape && geometry.greenShape.length) {
      checkpoints.greenFront = nearestShapePoint(geometry.greenShape, tee);
      checkpoints.greenBack = farthestShapePoint(geometry.greenShape, tee);
    }
    var validation = validateSpatialReference(spatialRef, checkpoints);

    return {
      ok: true,
      svg: svg,
      groundSvg: groundSvg,
      markersSvg: markersSvg,
      width: fit.imageWidth,
      height: fit.imageHeight,
      spatialReference: spatialRef,
      reference: buildHoleReference(recipe, spatialRef, geometry, routeLatLng),
      checkpoints: checkpoints,
      validation: validation,
      layers: {
        tee: !!geometry.tee,
        green: true,
        greenShape: !!geometry.greenShape,
        fairways: projected.fairways.length,
        fairwaysMapped: (geometry.fairways || []).length,
        bunkers: projected.bunkers.length,
        bunkersMapped: (geometry.bunkers || []).length,
        water: projected.water.length,
        waterMapped: (geometry.water || []).length,
        /* `*Mapped` is what the mapper cloned onto this hole; the plain counts
           are what survived simplification and the off-canvas cull. A large gap
           is normal and expected under cloning, not a fault to chase. */
        routePoints: routeLatLng.length,
        corridorHalfWidthM: recipe.corridor.halfWidthM
      }
    };
  }

  function nearestShapePoint(shape, from) {
    var best = null, bestD = Infinity;
    shape.forEach(function (p) {
      var d = Math.hypot(p.lat - from.lat, p.lng - from.lng);
      if (d < bestD) { bestD = d; best = p; }
    });
    return best;
  }
  function farthestShapePoint(shape, from) {
    var best = null, bestD = -Infinity;
    shape.forEach(function (p) {
      var d = Math.hypot(p.lat - from.lat, p.lng - from.lng);
      if (d > bestD) { bestD = d; best = p; }
    });
    return best;
  }

  return {
    WATCH_MAP_RECIPE_V1: WATCH_MAP_RECIPE_V1,
    WEARABLE_DELIVERY: WEARABLE_DELIVERY,
    wearableDeliveryVerdict: wearableDeliveryVerdict,
    worldPx: worldPx,
    latLngFromWorldPx: latLngFromWorldPx,
    applyTransform: applyTransform,
    invertTransform: invertTransform,
    anchoredTransform: anchoredTransform,
    holeBearingRadians: holeBearingRadians,
    objectsForHole: objectsForHole,
    projectLatLngToImage: projectLatLngToImage,
    projectImageToLatLng: projectImageToLatLng,
    validateSpatialReference: validateSpatialReference,
    buildWatchHoleFrame: buildWatchHoleFrame
  };
});
