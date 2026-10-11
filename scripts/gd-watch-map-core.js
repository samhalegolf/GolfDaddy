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
       reads correctly and only needs a re-bake to pick up the new look.

       v4 trimmed the vertical surplus. v3 padded the frame by a fraction of its
       own span, above and below whatever surface vertex reached furthest, so a
       500m hole carried 100-160m of ground behind the tee and 75-95m past the
       green - 38% of Millbrook's rows lay outside tee..green, and on a device
       that draws 1:1 (Approach S62) that surplus is what set the scale and left
       the hole 200px wide on a 260px face. Now the frame's height is the hole
       itself (tee to the back of the green) plus fixed metres either end, and
       a surface vertex beyond that no longer stretches it - it is still drawn,
       and simply runs off the edge, exactly as the corridor rule already treats
       ground to the side. The freed rows go to scale: the same 1536-row cap now
       covers ~560m instead of ~760m on a long hole, so it bakes wider and
       sharper for the same pixels, and short holes just get shorter.

       v5 centred the frame on the tee->green axis. v4 set the width from the
       union of corridor points, so a hole with bunkers on one side and nothing
       on the other framed off-centre - Millbrook's 1st put the play line at
       column 89 of 267, and on a wrist that centres on the image (the S62,
       drawing 1:1) the Bubble sat left of the face. Now the frame is
       symmetric about the axis: one corridor either side, widened only as far
       as a route bend needs. The play line IS the centre column.

       v6 swapped v3's corner-smoothing for Chaikin corner-cutting on a coarser
       decimation. v3's neighbour-averaging only moved points, so every shape was
       still straight edges meeting at softened corners, and more passes just
       shrank it. Cosmetic like v3: framing and buildHoleReference are untouched.

       v7 drew each course in its own palette. `colors` below is now the BASE palette with
       even lightness steps; the bake swaps in the course's tinted copy from
       scripts/gd-watch-palette-core.js (hue and chroma move towards the course's measured
       turf, sand and water; lightness never does). Cosmetic again.

       v8 drew the hand-drawn Studio overlay surfaces: trees (a dark wood) and hazards (gorse,
       scrub - brown-olive) under the fairways, and waste areas (dull sand) under bunkers and
       water. Water was already drawn. They are drawn only - like every surface since v4 they
       never decide the frame - and they ship in the outlines too (k trees, h hazard, z waste),
       so a Garmin draws them as well.

       v9 stopped painting trees into the picture. The bake places individual trees instead
       (buildHoleTrees - specimens, copses and woods, with a ragged edge) and ships them as a
       list; each watch stamps its own tree sprites from it. Textured trees in the JPEG cost
       25-60 KB a hole against a 60 KB wrist budget most tree-heavy holes already squeeze to
       fit, where a tree costs one number in the list. The outlines still carry `k`, so a watch
       without tree sprites draws the flat wood as before. */
    version: 9,
    canvas: {
      /* Ceiling, not a fixed size - see computeCanvasFit. Most holes land under both ceilings;
         a long narrow par 5 is height-limited, a short wide-corridor hole is width-limited. */
      targetWidthPx: 448,
      maxHeightPx: 1536,
      minSpanPx: 96,
      /* Side padding, as a fraction of the framed width. */
      marginFraction: 0.14,
      /* Vertical padding, in metres of ground, measured from the hole itself:
         behind the tee, room to show the player standing behind their ball; past
         the back of the green, room for the longest putt's overshoot. Fixed rather
         than a fraction because the need does not grow with the hole's length. */
      behindTeeM: 20,
      beyondGreenM: 30
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
      minVertexSpacingPx: 4,
      minPolygonAreaPx2: 24,
      /* Spacing for the green outline shipped in the hole reference, which the wrist measures
         front/back distances against. Kept separate from minVertexSpacingPx so how the map is
         drawn never changes what the wrist measures. */
      referenceVertexSpacingPx: 2.5,
      /* Chaikin corner-cutting passes run on every decimated ring (see smoothClosedPolygon).
         Each pass doubles the points, so 3 passes turns every corner into ~8 short segments -
         a real curve at watch scale. The 4px decimation above runs first so the curves follow
         the shape, not the wobble in hand-drawn/OSM outlines. */
      smoothPasses: 3
    },
    /* The base palette - must match gd-watch-palette-core.js's basePalette() (a test holds
       them together). Kept literal here so this file stays dependency-free. */
    colors: {
      background: "#315833",
      fairway: "#4e9a52",
      green: "#8bd28d",
      bunker: "#e9daae",
      water: "#2d69a2",
      trees: "#18361a",
      waste: "#b1a47e",
      hazard: "#756533",
      tee: "#f4f4f2",
      outline: "rgba(8,18,8,0.35)"
    },
    /* The OUTLINES shipped beside the picture (buildHoleOutlines) - what a watch draws for
       itself when it cannot fetch the image. Separate from `simplify` for the same reason as
       referenceVertexSpacingPx: how the picture is drawn must never change what is sent. */
    outlines: {
      /* ROUNDED first - Chaikin corner cutting, as the picture's own outlines are - then
         Douglas-Peucker at this tolerance in GROUND metres. Raw OSM outlines simplified at 1.5 m
         drew as jagged straight-sided shapes on the watch (Sam, 2026-10-06); smoothing then
         simplifying finely keeps the curves and still lands well under the point cap.
         0.4 m was still too coarse once the Garmin map zooms ~3x round the Bubble: a green
         shipped as 17 points and a bunker as a pentagon, each side 50-130 screen px of
         straight line (Sam, 2026-10-08). The small curved surfaces - greens, bunkers, water -
         now keep their curve (curveToleranceM: ~48 points a green, ~30 a bunker); everything
         else is long and nearly straight and stays at toleranceM. The smoothing is done here
         and not on the watch: interpolating at draw time tripped the Forerunner 255's
         watchdog. */
      smoothPasses: 3,
      toleranceM: 0.2,
      curveToleranceM: 0.05,
      /* Connect IQ's fillPolygon is not promised beyond 64 vertices on every device; a ring
         still above this after simplifying is simplified harder until it fits. */
      maxPoints: 64,
      /* Clip window beyond the canvas edge, in px: a shape running off the image is cut just
         past it, so the cut never shows on screen and a cross-course ribbon of fairway does
         not ship its far end. */
      clipMarginPx: 8
    },
    /* Individual trees placed in every hand-drawn `trees` area (buildHoleTrees). Sizes are
       crown RADII in ground metres. An area under specimenMaxM2 is one tree sized to it; any
       larger area gets a ragged edge of trees plus a packed interior. The edge steps each tree
       between edgeInFraction (in) and edgeOutFraction (out) of its radius across the drawn
       line, skips gapChance of its spots and turns strayChance of them into a smaller tree
       standing out on its own, so a large area never ends in a straight line. */
    trees: {
      specimenMaxM2: 250,
      specimenRadiusM: [3, 8],
      radiusM: [3.5, 6.5],
      edgeSpacingM: [4.5, 8.5],
      edgeInFraction: 0.3,
      edgeOutFraction: 0.8,
      gapChance: 0.1,
      strayChance: 0.15,
      /* Fraction of trees of each type: pine and broadleaf, the rest round; yellowGreen is
         applied on top, to any type. */
      pineFraction: 0.12,
      broadleafFraction: 0.43,
      yellowGreenFraction: 0.1,
      /* Clearance from fairways, greens, bunkers and water, as a fraction of a tree's radius:
         a crown may overhang played ground slightly, never sit on it. */
      playedClearance: 0.55,
      /* A hole holding more than this keeps the trees nearest the play line. Every tree is one
         number on the wire; this caps a hole of solid forest at a few KB. */
      maxTrees: 1500
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

  /* trees come from OSM woods and the Studio overlay; hazards and waste from the overlay only
     (functions/lib/gd-automapper-core.mjs parseOsmSurfaces). */
  var POLYGON_TYPES = { fairway_area: "fairways", bunker: "bunkers", water: "water", trees: "trees", hazard: "hazards", waste: "waste" };

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
    var fairways = [], bunkers = [], water = [], trees = [], hazards = [], waste = [], route = [];
    var buckets = { fairways: fairways, bunkers: bunkers, water: water, trees: trees, hazards: hazards, waste: waste };
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
        if (poly) buckets[POLYGON_TYPES[object.type]].push(poly);
      }
    });
    return { tee: tee, green: green, greenShape: greenShape, route: route, fairways: fairways, bunkers: bunkers, water: water, trees: trees, hazards: hazards, waste: waste };
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
    var spacingM = Number(spatialRef.metresPerPixel) * recipe.simplify.referenceVertexSpacingPx;
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

  /* Rounds the corners left by decimation with Chaikin corner-cutting: every edge is replaced
     by two points at 1/4 and 3/4 along it, so each pass cuts every corner in two and doubles
     the point count. Converges on a smooth curve and, unlike averaging each point with its
     neighbours, barely shrinks the shape. Closed ring - wraps around, since every polygon this
     recipe draws is one.

     Runs AFTER simplifyPoints, deliberately: cutting the corners of hundreds of near-duplicate
     points would round off noise instead of the real shape. */
  function smoothClosedPolygon(points, passes) {
    if (points.length < 3 || !(passes > 0)) return points;
    var out = points;
    for (var pass = 0; pass < passes; pass++) {
      var next = [];
      for (var i = 0; i < out.length; i++) {
        var a = out[i], b = out[(i + 1) % out.length];
        next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      out = next;
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

  /* The hole's surfaces as the WATCH draws them when it has no picture: fairways, bunkers,
     water and the green as closed rings of whole IMAGE pixels in this package's own spatial
     reference, so a watch places them with the camera it already has and no projection.
     Each ring is clipped to the canvas (plus clipMarginPx), Douglas-Peucker simplified to
     outlines.toleranceM of ground, and held to outlines.maxPoints. Raw shapes, not the
     picture's smoothed ones: smoothing multiplies points, and a watch at this size cannot see
     the difference. {version, f, b, w, k, h, z, g} - f/b/w/k/h/z (fairways, bunkers, water,
     trees, hazards, waste) lists of flat [x0,y0,x1,y1,...] rings, g one ring or null. k, h and
     z were added inside version 1: a reader that does not know them simply never draws them. */
  function buildHoleOutlines(recipe, spatialRef, geometry) {
    var cfg = recipe.outlines;
    var mpp = Number(spatialRef.metresPerPixel) || 0.5;
    var margin = cfg.clipMarginPx;
    var box = { minX: -margin, minY: -margin, maxX: spatialRef.imageWidth + margin, maxY: spatialRef.imageHeight + margin };
    function ring(shape, curved) {
      var projected = shape.map(function (p) { return projectLatLngToImage(spatialRef, p.lat, p.lng); });
      var clipped = clipRingToBox(projected, box);
      if (clipped.length < 3) return null;
      var rounded = smoothClosedPolygon(clipped, cfg.smoothPasses);
      var tolerance = ((curved && cfg.curveToleranceM) || cfg.toleranceM) / mpp;
      var simple = douglasPeuckerRing(rounded, tolerance);
      while (simple.length > cfg.maxPoints) { tolerance *= 1.3; simple = douglasPeuckerRing(rounded, tolerance); }
      if (simple.length < 3 || polygonAreaPx2(simple) < recipe.simplify.minPolygonAreaPx2) return null;
      var flat = [];
      simple.forEach(function (p) { flat.push(Math.round(p.x), Math.round(p.y)); });
      return flat;
    }
    function rings(list, curved) { return (list || []).map(function (shape) { return ring(shape, curved); }).filter(Boolean); }
    return {
      version: 1,
      f: rings(geometry.fairways),
      b: rings(geometry.bunkers, true),
      w: rings(geometry.water, true),
      k: rings(geometry.trees),
      h: rings(geometry.hazards),
      z: rings(geometry.waste),
      g: geometry.greenShape ? ring(geometry.greenShape, true) : null
    };
  }

  // ---------------------------------------------------------------- trees

  /* Tree types, as the watches' sprite sets name them. */
  var TREE_TYPES = ["round", "broadleaf", "pine", "yellow_green"];

  /* One tree as one non-negative integer below 2^31, so a hole of forest stays a short list of
     numbers on the wire and on a watch: x (11 bits) + y (11 bits) + crown radius in image px
     (7 bits, 1..127) + type (2 bits, TREE_TYPES). Arithmetic, not bit shifts - the top field
     reaches bit 30 and JavaScript shifts are signed. */
  function packTree(x, y, r, type) {
    return Math.round(x) + Math.round(y) * 2048 + Math.max(1, Math.min(127, Math.round(r))) * 4194304 + type * 536870912;
  }
  function unpackTree(v) {
    return { x: v % 2048, y: Math.floor(v / 2048) % 2048, r: Math.floor(v / 4194304) % 128, type: Math.floor(v / 536870912) % 4 };
  }

  function treeRandom(seed) {
    var x = seed >>> 0 || 1;
    return function () { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  }
  function pointInRing(ring, x, y) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  function distanceToRing(ring, x, y) {
    var best = Infinity;
    for (var i = 0; i < ring.length; i++) {
      var a = ring[i], b = ring[(i + 1) % ring.length], dx = b.x - a.x, dy = b.y - a.y;
      var t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(a.x + t * dx - x, a.y + t * dy - y));
    }
    return best;
  }
  function ringBox(ring) {
    var box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    ring.forEach(function (p) {
      if (p.x < box.minX) box.minX = p.x; if (p.y < box.minY) box.minY = p.y;
      if (p.x > box.maxX) box.maxX = p.x; if (p.y > box.maxY) box.maxY = p.y;
    });
    return box;
  }

  /* The hole's trees: every hand-drawn `trees` area turned into individual trees the watch
     stamps as sprites. {version: 1, c: [packTree...]} sorted back to front (by y), every
     centre inside the canvas. Deterministic: an area's trees are seeded from its own outline,
     so a rebake of an unchanged course places the same trees.

     - Under cfg.specimenMaxM2: one tree, sized to the area.
     - Larger (a copse, a tree line, a wood): a ragged edge - uneven spacing, each tree stepping
       in or out of the drawn line, the odd gap, the odd straggler - then the inside packed with
       trees of mixed size that do not quite touch, so grass shows between them.
     No tree sits on a fairway, green, bunker or water (cfg.playedClearance). */
  function buildHoleTrees(recipe, spatialRef, geometry) {
    var cfg = recipe.trees;
    var mpp = Number(spatialRef.metresPerPixel) || 0.5;
    var W = spatialRef.imageWidth, H = spatialRef.imageHeight;
    var px = function (m) { return m / mpp; };
    var project = function (shape) { return shape.map(function (p) { return projectLatLngToImage(spatialRef, p.lat, p.lng); }); };
    var played = [].concat(geometry.fairways || [], geometry.bunkers || [], geometry.water || [], geometry.greenShape ? [geometry.greenShape] : [])
      .map(project).map(function (ring) { return { ring: ring, box: ringBox(ring) }; });
    var trees = [];
    /* Placed trees, bucketed on a grid for the spacing check. */
    var cell = Math.max(8, px(cfg.radiusM[1] * 2)), grid = Object.create(null);
    function crowded(x, y, r, fraction) {
      var gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var list = grid[(gx + dx) + "," + (gy + dy)];
        if (!list) continue;
        for (var i = 0; i < list.length; i++) if (Math.hypot(list[i].x - x, list[i].y - y) < (list[i].r + r) * fraction) return true;
      }
      return false;
    }
    function onPlayed(x, y, r) {
      var clear = r * cfg.playedClearance;
      return played.some(function (p) {
        if (x < p.box.minX - clear || x > p.box.maxX + clear || y < p.box.minY - clear || y > p.box.maxY + clear) return false;
        return pointInRing(p.ring, x, y) || distanceToRing(p.ring, x, y) < clear;
      });
    }
    function add(x, y, r, rand, spacing) {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      if (onPlayed(x, y, r) || crowded(x, y, r, spacing)) return false;
      var u = rand(), type = u < cfg.pineFraction ? 2 : u < cfg.pineFraction + cfg.broadleafFraction ? 1 : 0;
      if (rand() < cfg.yellowGreenFraction) type = 3;
      var tree = { x: x, y: y, r: r, type: type };
      trees.push(tree);
      var key = Math.floor(x / cell) + "," + Math.floor(y / cell);
      (grid[key] = grid[key] || []).push(tree);
      return true;
    }
    var between = function (rand, range) { return range[0] + (range[1] - range[0]) * rand(); };

    (geometry.trees || []).forEach(function (shape) {
      var ring = project(shape);
      if (ring.length < 3) return;
      var box = ringBox(ring);
      if (box.maxX < 0 || box.maxY < 0 || box.minX >= W || box.minY >= H) return;
      var seed = 2166136261;
      shape.slice(0, 4).forEach(function (p) {
        seed = Math.imul(seed ^ Math.round(p.lat * 1e6), 16777619);
        seed = Math.imul(seed ^ Math.round(p.lng * 1e6), 16777619);
      });
      var rand = treeRandom(seed);
      var areaM2 = polygonAreaPx2(ring) * mpp * mpp;

      if (areaM2 < cfg.specimenMaxM2) {
        var c = ring.reduce(function (s, p) { return { x: s.x + p.x / ring.length, y: s.y + p.y / ring.length }; }, { x: 0, y: 0 });
        var r = Math.max(px(cfg.specimenRadiusM[0]), Math.min(px(cfg.specimenRadiusM[1]), Math.sqrt(areaM2 / Math.PI) / mpp));
        add(c.x, c.y, r, rand, 0.7);
        return;
      }
      /* The edge first, so the silhouette is never crowded out by the interior. */
      for (var i = 0; i < ring.length; i++) {
        var a = ring[i], b = ring[(i + 1) % ring.length], len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!(len > 0)) continue;
        var nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
        var inward = pointInRing(ring, (a.x + b.x) / 2 + nx * 2, (a.y + b.y) / 2 + ny * 2) ? 1 : -1;
        for (var d = rand() * px(cfg.edgeSpacingM[0]); d < len; d += px(between(rand, cfg.edgeSpacingM))) {
          if (rand() < cfg.gapChance) continue;
          var er = px(between(rand, cfg.radiusM));
          var out = er * (rand() * (cfg.edgeInFraction + cfg.edgeOutFraction) - cfg.edgeInFraction);
          if (rand() < cfg.strayChance) { out = er * (1.1 + rand()); er *= 0.75; }
          var t = d / len;
          add(a.x + (b.x - a.x) * t - nx * inward * out, a.y + (b.y - a.y) * t - ny * inward * out, er, rand, 0.6);
        }
      }
      /* Then the inside: dart-throwing over the part of the area on the canvas, enough tries
         to fill it. */
      var minX = Math.max(0, box.minX), minY = Math.max(0, box.minY), maxX = Math.min(W, box.maxX), maxY = Math.min(H, box.maxY);
      if (maxX <= minX || maxY <= minY) return;
      var meanR = px((cfg.radiusM[0] + cfg.radiusM[1]) / 2);
      var tries = Math.min(40000, Math.ceil(((maxX - minX) * (maxY - minY)) / (meanR * meanR) * 6));
      for (var k = 0; k < tries; k++) {
        var ir = px(between(rand, cfg.radiusM)), x = minX + (maxX - minX) * rand(), y = minY + (maxY - minY) * rand();
        if (!pointInRing(ring, x, y) || distanceToRing(ring, x, y) < ir * 0.8) continue;
        add(x, y, ir, rand, 0.8);
      }
    });

    if (trees.length > cfg.maxTrees) {
      var axis = W / 2;
      trees.sort(function (p, q) { return Math.abs(p.x - axis) - Math.abs(q.x - axis); });
      trees.length = cfg.maxTrees;
    }
    trees.sort(function (p, q) { return p.y - q.y || p.x - q.x; });
    return {
      version: 1,
      c: trees.map(function (tree) { return packTree(Math.min(W - 1, tree.x), Math.min(H - 1, tree.y), tree.r, tree.type); })
    };
  }

  /* Sutherland-Hodgman against an axis-aligned box. */
  function clipRingToBox(points, box) {
    var edges = [
      function (p) { return p.x >= box.minX; }, function (p) { return p.x <= box.maxX; },
      function (p) { return p.y >= box.minY; }, function (p) { return p.y <= box.maxY; }
    ];
    var cuts = [
      function (a, b) { var t = (box.minX - a.x) / (b.x - a.x); return { x: box.minX, y: a.y + t * (b.y - a.y) }; },
      function (a, b) { var t = (box.maxX - a.x) / (b.x - a.x); return { x: box.maxX, y: a.y + t * (b.y - a.y) }; },
      function (a, b) { var t = (box.minY - a.y) / (b.y - a.y); return { x: a.x + t * (b.x - a.x), y: box.minY }; },
      function (a, b) { var t = (box.maxY - a.y) / (b.y - a.y); return { x: a.x + t * (b.x - a.x), y: box.maxY }; }
    ];
    var out = points.slice();
    for (var e = 0; e < 4 && out.length; e++) {
      var input = out; out = [];
      for (var i = 0; i < input.length; i++) {
        var cur = input[i], prev = input[(i + input.length - 1) % input.length];
        var curIn = edges[e](cur), prevIn = edges[e](prev);
        if (curIn) { if (!prevIn) out.push(cuts[e](prev, cur)); out.push(cur); }
        else if (prevIn) out.push(cuts[e](prev, cur));
      }
    }
    return out;
  }

  /* Douglas-Peucker on a CLOSED ring: split at the vertex farthest from the first, simplify
     both halves as open lines, rejoin. */
  function douglasPeuckerRing(points, tolerance) {
    if (points.length <= 4) return points.slice();
    var far = 0, farD = -1;
    for (var i = 1; i < points.length; i++) {
      var d = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
      if (d > farD) { farD = d; far = i; }
    }
    var a = douglasPeuckerLine(points.slice(0, far + 1), tolerance);
    var b = douglasPeuckerLine(points.slice(far).concat([points[0]]), tolerance);
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  function douglasPeuckerLine(points, tolerance) {
    if (points.length < 3) return points.slice();
    var keep = new Array(points.length);
    keep[0] = keep[points.length - 1] = true;
    var stack = [[0, points.length - 1]];
    while (stack.length) {
      var span = stack.pop(), i0 = span[0], i1 = span[1];
      var a = points[i0], b = points[i1], dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      var worst = -1, worstD = tolerance;
      for (var i = i0 + 1; i < i1; i++) {
        var p = points[i], t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
        var d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
        if (d > worstD) { worstD = d; worst = i; }
      }
      if (worst > 0) { keep[worst] = true; stack.push([i0, worst], [worst, i1]); }
    }
    return points.filter(function (_, i) { return keep[i]; });
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
  /* `vertical`, when given, is the frame's own top-to-bottom extent in rotated
     units - {top, bottom} - and wins over the points: the points still set the
     width, but a vertex above `top` or below `bottom` no longer stretches the
     frame (recipe v4). Without it (v3 and earlier recipes, which carry
     teeMarginFraction instead), the points set both axes and the padding is a
     fraction of the span. */
  /* `lateral`, when given, is {halfWidth} in rotated units: the frame is then
     centred on the tee->green axis and that wide either side of it, whatever
     the points span (recipe v5). Without it the points set the width. */
  function computeCanvasFit(rotatedPoints, canvas, vertical, lateral) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rotatedPoints.forEach(function (p) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    });
    var boundsMinX, boundsWidth;
    if (lateral && Number.isFinite(lateral.halfWidth) && lateral.halfWidth > 0) {
      /* Recipe v5: symmetric about `lateral.centre` (the tee->green axis, x = 0
         in rotated space, on a straight hole; the route's lateral midpoint on a
         dogleg), so the play line is the image's centre column whatever lies
         to either side of it. */
      var half = lateral.halfWidth * (1 + canvas.marginFraction);
      boundsMinX = (Number.isFinite(lateral.centre) ? lateral.centre : 0) - half;
      boundsWidth = half * 2;
    } else {
      var spanX = Math.max(1, maxX - minX);
      var marginX = spanX * canvas.marginFraction;
      boundsMinX = minX - marginX;
      boundsWidth = spanX + marginX * 2;
    }
    var boundsMinY, boundsHeight;
    if (vertical && Number.isFinite(vertical.top) && Number.isFinite(vertical.bottom)) {
      boundsMinY = vertical.top;
      boundsHeight = Math.max(1, vertical.bottom - vertical.top);
    } else {
      var spanY = Math.max(1, maxY - minY);
      var marginTop = spanY * canvas.marginFraction;
      var marginBottom = spanY * (canvas.marginFraction + (canvas.teeMarginFraction || 0));
      boundsMinY = minY - marginTop;
      boundsHeight = spanY + marginTop + marginBottom;
    }
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
    /* Hazards under everything played on, so a fairway cut through the gorse stays clean;
       waste under the bunkers and water it usually holds. */
    /* Trees are not painted: the watch stamps them from buildHoleTrees (recipe v9). */
    layer(projected.hazards || [], recipe.colors.hazard);
    layer(projected.fairways, recipe.colors.fairway);
    layer(projected.waste || [], recipe.colors.waste);
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
    var toRotated = function (p) {
      var world = worldPx(p.lat, p.lng, refZoom);
      return rotate({ x: world.x - teeWorld.x, y: world.y - teeWorld.y }, bearing);
    };
    var rotated = framePoints.map(toRotated);

    /* Recipe v4: the frame's height is the hole itself plus fixed metres. In
       rotated space the tee sits at the origin and the green is "up" (negative
       y), so the top is the furthest-up point of the green - its back edge when
       the outline is mapped, its centre otherwise - and the bottom is the tee.
       A fairway or bunker vertex beyond either end is still drawn; it simply no
       longer decides the frame. Metres become rotated units through the same
       ground resolution the rest of this projection uses. */
    var vertical = null;
    if (Number.isFinite(recipe.canvas.behindTeeM) && Number.isFinite(recipe.canvas.beyondGreenM)) {
      var unitsPerMetre = 1 / groundResolutionMPerPx(tee.lat, refZoom);
      var holeTop = Infinity, holeBottom = -Infinity;
      [green].concat(geometry.greenShape || []).map(toRotated).forEach(function (p) { if (p.y < holeTop) holeTop = p.y; });
      [tee].map(toRotated).forEach(function (p) { if (p.y > holeBottom) holeBottom = p.y; });
      if (holeTop > holeBottom) { var swap = holeTop; holeTop = holeBottom; holeBottom = swap; }
      vertical = {
        top: holeTop - recipe.canvas.beyondGreenM * unitsPerMetre,
        bottom: holeBottom + recipe.canvas.behindTeeM * unitsPerMetre
      };
    }
    /* Recipe v5: the frame is symmetric about the tee->green axis, so the
       axis is the image's centre column and a target on the play line sits
       at the centre of any wrist that centres on the image (the Approach S62
       draws 1:1 and cannot pan to it otherwise). Half the width is the
       corridor's half width, pushed out only as far as a route bend needs it
       - a dogleg keeps its bend, a straight hole gets exactly one corridor
       either side. Surfaces beyond that still draw and run off the edge. */
    var lateral = null;
    if (Number.isFinite(recipe.canvas.behindTeeM) && Number.isFinite(recipe.canvas.beyondGreenM)) {
      /* The route's lateral extent: tee and green are at x = 0, a dogleg's
         bend is wherever it is. Centring on the midpoint of that extent keeps
         a straight hole centred on its axis and a dogleg centred on its own
         band, one corridor either side, at no more width than the bend needs
         (centring a dogleg on the axis instead would spend half the canvas on
         ground the hole never visits). */
      var minX = 0, maxX = 0;
      routeLatLng.map(toRotated).forEach(function (p) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; });
      lateral = { centre: (minX + maxX) / 2, halfWidth: (maxX - minX) / 2 + corridorPx };
    }
    var fit = computeCanvasFit(rotated, recipe.canvas, vertical, lateral);
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
      trees: projectAndSimplifyPolygons(geometry.trees, spatialRef, recipe),
      hazards: projectAndSimplifyPolygons(geometry.hazards, spatialRef, recipe),
      waste: projectAndSimplifyPolygons(geometry.waste, spatialRef, recipe),
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
      outlines: buildHoleOutlines(recipe, spatialRef, geometry),
      trees: buildHoleTrees(recipe, spatialRef, geometry),
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
        trees: projected.trees.length,
        treesMapped: (geometry.trees || []).length,
        hazards: projected.hazards.length,
        hazardsMapped: (geometry.hazards || []).length,
        waste: projected.waste.length,
        wasteMapped: (geometry.waste || []).length,
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
    buildHoleOutlines: buildHoleOutlines,
    buildHoleTrees: buildHoleTrees,
    TREE_TYPES: TREE_TYPES,
    packTree: packTree,
    unpackTree: unpackTree,
    buildWatchHoleFrame: buildWatchHoleFrame
  };
});
