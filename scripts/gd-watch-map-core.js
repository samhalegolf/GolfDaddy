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
    version: 1,
    canvas: {
      /* Ceiling, not a fixed size - see computeCanvasFit. Most holes land under both ceilings;
         a long narrow par 5 is height-limited, a short wide-corridor hole is width-limited. */
      targetWidthPx: 448,
      maxHeightPx: 1536,
      minSpanPx: 96,
      /* Padding around the union of every mapped object, as a fraction of that union's own
         span. teeMarginFraction is extra padding added only below the tee, so a future Watch
         viewport has room to show the player standing behind their ball. */
      marginFraction: 0.14,
      teeMarginFraction: 0.16
    },
    simplify: {
      /* Vertex decimation distance and minimum kept-polygon area, both in OUTPUT pixels (i.e.
         applied after the fit scale, so the thresholds mean the same thing on every hole
         regardless of how much ground one pixel covers). */
      minVertexSpacingPx: 2.5,
      minPolygonAreaPx2: 24
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
    var fairways = [], bunkers = [], water = [];
    Object.keys(objectsJson || {}).forEach(function (key) {
      var object = objectsJson[key];
      if (!object || Number(object.holeNumber) !== hole) return;
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
    return { tee: tee, green: green, greenShape: greenShape, fairways: fairways, bunkers: bunkers, water: water };
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

  /* Projects every polygon through the transform, decimates points, and drops any polygon that
     ends up smaller than the recipe's noise floor - "insignificant isolated objects" in the
     task's words. Returns image-pixel point lists only; nothing here needs lat/lng again. */
  function projectAndSimplifyPolygons(polygons, spatialRef, recipe) {
    var out = [];
    (polygons || []).forEach(function (shape) {
      var projected = shape.map(function (p) { return projectLatLngToImage(spatialRef, p.lat, p.lng); });
      var simplified = simplifyPoints(projected, recipe.simplify.minVertexSpacingPx);
      if (simplified.length >= 3 && polygonAreaPx2(simplified) >= recipe.simplify.minPolygonAreaPx2) out.push(simplified);
    });
    return out;
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

  // ---------------------------------------------------------------- SVG rendering

  function polygonPointsAttr(points) {
    return points.map(function (p) { return (Math.round(p.x * 10) / 10) + "," + (Math.round(p.y * 10) / 10); }).join(" ");
  }

  function buildHoleSvg(recipe, spatialRef, projected) {
    var w = spatialRef.imageWidth, h = spatialRef.imageHeight;
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">');
    parts.push('<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="' + recipe.colors.background + '"/>');
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
    if (projected.teePx) {
      parts.push('<circle cx="' + projected.teePx.x + '" cy="' + projected.teePx.y + '" r="' + recipe.teeMarkerRadiusPx + '" fill="' + recipe.colors.tee + '" stroke="' + recipe.colors.outline + '" stroke-width="' + recipe.strokeWidthPx + '"/>');
    }
    parts.push("</svg>");
    return parts.join("");
  }

  // ---------------------------------------------------------------- orchestration

  /* The one entry point callers need. geometry is objectsForHole()'s return shape (or anything
     with the same {tee, green, greenShape, fairways, bunkers, water} fields). Returns
     {ok:false, reason} when there is no green to build against - a hole with no green cannot
     answer any distance, the same floor functions/lib/gd-course-package-shape.mjs applies to
     the native package. Otherwise returns {ok:true, svg, width, height, spatialReference,
     validation, layers} where `layers` records what was actually drawn, for the generation
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

    var allLatLng = [tee, green].concat(geometry.greenShape || []);
    (geometry.fairways || []).concat(geometry.bunkers || []).concat(geometry.water || []).forEach(function (polygon) {
      allLatLng = allLatLng.concat(polygon);
    });
    var rotated = allLatLng.map(function (p) {
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
    var checkpoints = { tee: tee, green: green };
    if (geometry.greenShape && geometry.greenShape.length) {
      checkpoints.greenFront = nearestShapePoint(geometry.greenShape, tee);
      checkpoints.greenBack = farthestShapePoint(geometry.greenShape, tee);
    }
    var validation = validateSpatialReference(spatialRef, checkpoints);

    return {
      ok: true,
      svg: svg,
      width: fit.imageWidth,
      height: fit.imageHeight,
      spatialReference: spatialRef,
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
        waterMapped: (geometry.water || []).length
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
