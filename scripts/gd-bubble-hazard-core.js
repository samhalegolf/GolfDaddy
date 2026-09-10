/* Bubble hazard reveal core - pure lat/lng geometry, no DOM, no Leaflet.
   Loaded two ways, same policy as scripts/gd-watch-map-core.js:
     - browser, via <script> in index.html ahead of gd-app-core.js, as window.GDBubbleHazardCore
     - node, via require() from dev/bubble-hazard-core.test.js

   What it answers, for one bubble ring over one course's mapped objects:
     1. Which bunker / water surfaces does the bubble touch at all? (bbox + overlap test)
        GPS Play then draws those surfaces clipped to the bubble - the surface is "hidden
        under the map" and the bubble reveals the part it is over.
     2. Is the bubble entirely off the fairway? True only when the course HAS fairway
        surfaces and the ring overlaps none of them and no green. The green counts as safe
        because an approach bubble sits on the green, not the fairway, and warning on every
        approach shot would be noise rather than information.

   Surface records come from course_maps.objects_json as the client stores them
   (scripts/gd-course-library-pin-lock.js loadUserCourseData): type "fairway_area" /
   "bunker" / "water" with a `shape` ring, type "green" with `greenShape` (or `shape`).
   The /app/ shell has no such record - it plays straight off the course package - so
   collectPackageSurfaces() turns a package's per-hole surfaces into the same buckets.
   Bunker PINS (type "bunker", no shape) are not surfaces and are ignored here. Hole numbers
   are deliberately not consulted: functions/lib/gd-automapper-core.mjs dedupes a surface
   shared by two holes onto whichever hole claimed it first, so a per-hole filter would hide
   real hazards. A hazard is a hazard whichever hole it belongs to. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.ClarityApp = root.ClarityApp || {}; root.ClarityApp.bubbleHazardCore = api; root.GDBubbleHazardCore = api; }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var SURFACE_BUCKETS = { fairway_area: "fairways", bunker: "bunkers", water: "water", green: "greens" };

  function finitePoint(value) {
    if (!value) return null;
    var lat = Number(value.lat), lng = Number(value.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      if (Array.isArray(value) && value.length >= 2) { lat = Number(value[0]); lng = Number(value[1]); }
    }
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  /* A usable ring: 3+ finite points, closing duplicate dropped. */
  function cleanRing(shape) {
    if (!Array.isArray(shape)) return null;
    var out = [];
    for (var i = 0; i < shape.length; i++) {
      var p = finitePoint(shape[i]);
      if (p) out.push(p);
    }
    if (out.length > 3) {
      var first = out[0], last = out[out.length - 1];
      if (first.lat === last.lat && first.lng === last.lng) out.pop();
    }
    return out.length >= 3 ? out : null;
  }

  function ringBounds(ring) {
    var b = { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity };
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i];
      if (p.lat < b.minLat) b.minLat = p.lat;
      if (p.lat > b.maxLat) b.maxLat = p.lat;
      if (p.lng < b.minLng) b.minLng = p.lng;
      if (p.lng > b.maxLng) b.maxLng = p.lng;
    }
    return b;
  }

  function boundsIntersect(a, b) {
    return !(a.maxLat < b.minLat || b.maxLat < a.minLat || a.maxLng < b.minLng || b.maxLng < a.minLng);
  }

  /* Ray casting, lat/lng treated as plane coordinates. Fine at hole scale. */
  function pointInRing(pt, ring) {
    var x = pt.lng, y = pt.lat, inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i].lng, yi = ring[i].lat, xj = ring[j].lng, yj = ring[j].lat;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function orient(a, b, c) {
    return (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  }

  function segmentsIntersect(a, b, c, d) {
    var o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0) && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
  }

  /* True when two rings share any area: a vertex of either inside the other, or any pair of
     edges crossing (catches the plus-sign case where neither ring holds a vertex of the
     other). Bounding boxes first, because a course has hundreds of surfaces and a bubble
     touches a handful. */
  function ringsOverlap(a, b, boundsA, boundsB) {
    if (!a || !b || a.length < 3 || b.length < 3) return false;
    boundsA = boundsA || ringBounds(a);
    boundsB = boundsB || ringBounds(b);
    if (!boundsIntersect(boundsA, boundsB)) return false;
    var i, j;
    for (i = 0; i < a.length; i++) if (pointInRing(a[i], b)) return true;
    for (i = 0; i < b.length; i++) if (pointInRing(b[i], a)) return true;
    for (i = 0; i < a.length; i++) {
      var a1 = a[i], a2 = a[(i + 1) % a.length];
      for (j = 0; j < b.length; j++) {
        if (segmentsIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true;
      }
    }
    return false;
  }

  function surfaceRecord(object, ring) {
    return {
      id: object && object.id != null ? String(object.id) : null,
      type: object ? object.type : null,
      hazardClass: object && object.hazardClass ? String(object.hazardClass) : null,
      holeNumber: object && Number.isFinite(Number(object.holeNumber)) ? Number(object.holeNumber) : null,
      ring: ring,
      bounds: ringBounds(ring)
    };
  }

  /* objects: an array or an id->object map, as stored on a course record.
     Returns {fairways, greens, bunkers, water}, each a list of surface records. */
  function collectSurfaces(objects) {
    var list = Array.isArray(objects) ? objects : Object.keys(objects || {}).map(function (k) { return objects[k]; });
    var out = { fairways: [], greens: [], bunkers: [], water: [] };
    for (var i = 0; i < list.length; i++) {
      var object = list[i];
      if (!object || !object.type) continue;
      var bucket = SURFACE_BUCKETS[object.type];
      if (!bucket) continue;
      var ring = cleanRing(object.type === "green" ? (object.greenShape || object.shape) : object.shape);
      if (!ring) continue;
      out[bucket].push(surfaceRecord(object, ring));
    }
    return out;
  }

  /* The /app/ shell's source: GET /api/course-package, whose holes carry surfaces per
     hole (lite: hole.surfaces, full: hole.geometry.surfaces - see
     functions/lib/gd-course-package-shape.mjs). Whole course, not the hole in play, for
     the reason in the header: a bunker straddling two holes is stored under both, and
     which hole "owns" it is not the bubble's concern. Greens ride along as the safe
     surface for the off-fairway rule. */
  function collectPackageSurfaces(pkg) {
    var holes = pkg && Array.isArray(pkg.holes) ? pkg.holes : [];
    var objects = [];
    for (var i = 0; i < holes.length; i++) {
      var hole = holes[i];
      var g = pkg.status === "full-map-ready" ? (hole && hole.geometry) : hole;
      if (!g) continue;
      var s = g.surfaces || {};
      var h = hole && hole.holeNumber;
      (Array.isArray(s.fairways) ? s.fairways : []).forEach(function (f) { objects.push({ type: "fairway_area", shape: f && f.shape, holeNumber: h }); });
      (Array.isArray(s.bunkers) ? s.bunkers : []).forEach(function (b) { objects.push({ type: "bunker", shape: b && b.shape, holeNumber: h }); });
      (Array.isArray(s.water) ? s.water : []).forEach(function (w) { objects.push({ type: "water", shape: w && w.shape, hazardClass: w && w.hazardClass, holeNumber: h }); });
      if (Array.isArray(g.greenShape) && g.greenShape.length >= 3) objects.push({ type: "green", greenShape: g.greenShape, holeNumber: h });
    }
    return collectSurfaces(objects);
  }

  /* Sutherland-Hodgman against a lat/lng box. The /app/ painter projects through the
     published photo, and that projection answers null for any point off the picture -
     a lake whose far shore is off-frame would lose those vertices and draw a different
     shape. Clipping the surface to the bubble's own box (plus a margin) first keeps
     every vertex handed to the projector near the bubble, and the bubble is on the
     picture whenever it is drawn. The visible result is identical: everything outside
     the bubble is clipped away again on screen. */
  function clipRingToBounds(ring, bounds, pad) {
    var clean = cleanRing(ring);
    if (!clean || !bounds) return null;
    var p = Number(pad) || 0;
    var box = { minLat: bounds.minLat - p, maxLat: bounds.maxLat + p, minLng: bounds.minLng - p, maxLng: bounds.maxLng + p };
    var edges = [
      function (pt) { return pt.lat >= box.minLat; }, function (pt) { return pt.lat <= box.maxLat; },
      function (pt) { return pt.lng >= box.minLng; }, function (pt) { return pt.lng <= box.maxLng; }
    ];
    var axis = ["lat", "lat", "lng", "lng"], at = [box.minLat, box.maxLat, box.minLng, box.maxLng];
    var out = clean;
    for (var e = 0; e < 4 && out.length; e++) {
      var input = out, inside = edges[e], key = axis[e], value = at[e];
      out = [];
      for (var i = 0; i < input.length; i++) {
        var cur = input[i], prev = input[(i + input.length - 1) % input.length];
        var curIn = inside(cur), prevIn = inside(prev);
        if (curIn !== prevIn) {
          var t = (value - prev[key]) / (cur[key] - prev[key]);
          out.push({ lat: prev.lat + (cur.lat - prev.lat) * t, lng: prev.lng + (cur.lng - prev.lng) * t });
        }
        if (curIn) out.push(cur);
      }
    }
    return out.length >= 3 ? out : null;
  }

  function hasAnySurface(surfaces) {
    return !!(surfaces && ((surfaces.fairways && surfaces.fairways.length) || (surfaces.greens && surfaces.greens.length) ||
      (surfaces.bunkers && surfaces.bunkers.length) || (surfaces.water && surfaces.water.length)));
  }

  function touching(ring, bounds, surfaces) {
    var hits = [];
    for (var i = 0; i < (surfaces || []).length; i++) {
      var s = surfaces[i];
      if (s && s.ring && ringsOverlap(ring, s.ring, bounds, s.bounds)) hits.push(s);
    }
    return hits;
  }

  /* ring: the bubble outline as lat/lng points. surfaces: collectSurfaces() output.
     extraSafe: optional additional "safe" rings (e.g. the live green polygon GPS Play has
     for the hole in play, which can be fresher than the stored one).
     Returns:
       bunkers / water : the surfaces the bubble is over, for the caller to draw clipped
       hasFairways     : whether the course has any fairway surface at all
       onFairway       : bubble overlaps at least one fairway surface
       onGreen         : bubble overlaps a green (stored or extraSafe)
       offFairway      : the warning - fairways exist and the bubble overlaps none, nor a green */
  function bubbleSurfaceState(ring, surfaces, extraSafe) {
    var clean = cleanRing(ring);
    var empty = { bunkers: [], water: [], hasFairways: false, onFairway: false, onGreen: false, offFairway: false };
    if (!clean || !surfaces) return empty;
    var bounds = ringBounds(clean);
    var fairwayHits = touching(clean, bounds, surfaces.fairways);
    var greenHits = touching(clean, bounds, surfaces.greens);
    var onGreen = greenHits.length > 0;
    if (!onGreen && Array.isArray(extraSafe)) {
      for (var i = 0; i < extraSafe.length && !onGreen; i++) {
        var safeRing = cleanRing(extraSafe[i]);
        if (safeRing && ringsOverlap(clean, safeRing, bounds)) onGreen = true;
      }
    }
    var hasFairways = !!(surfaces.fairways && surfaces.fairways.length);
    return {
      bunkers: touching(clean, bounds, surfaces.bunkers),
      water: touching(clean, bounds, surfaces.water),
      hasFairways: hasFairways,
      onFairway: fairwayHits.length > 0,
      onGreen: onGreen,
      offFairway: hasFairways && fairwayHits.length === 0 && !onGreen
    };
  }

  return {
    cleanRing: cleanRing,
    ringBounds: ringBounds,
    boundsIntersect: boundsIntersect,
    pointInRing: pointInRing,
    segmentsIntersect: segmentsIntersect,
    ringsOverlap: ringsOverlap,
    collectSurfaces: collectSurfaces,
    collectPackageSurfaces: collectPackageSurfaces,
    clipRingToBounds: clipRingToBounds,
    hasAnySurface: hasAnySurface,
    bubbleSurfaceState: bubbleSurfaceState
  };
});
