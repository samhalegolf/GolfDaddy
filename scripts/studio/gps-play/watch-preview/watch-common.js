/* What both watches share, in one place. STUDIO ONLY.
 *
 * The Apple Watch and the Garmin are each a port of the phone's maths - the Web Mercator
 * projection the bake was cut with, the haversine and flat-earth steps the Bubble Engine lays
 * a shot down with, the wind rule, the layup rule, the course skeleton the phone cuts from the
 * package - and the two ports agree by construction (the parity fixtures pin both to the same
 * JavaScript). So the previews' ports of those pieces live here once, under the names the
 * watches give them, and garmin-watch-render.js / apple-watch-render.js draw with them.
 *
 * Sources mirrored: GarminBubbleMath.mc GarminGeo / BubbleMath.swift Geo;
 * GarminMapProjection.mc / WatchMap.swift WatchMapSpatialReference; GarminConditions.mc /
 * WatchConditions.swift; GarminPlayState.clampedToBag / WatchPlayState.clampedToBag;
 * GarminBubbleEngine.defaultTarget / BubbleEngine.defaultTarget; GarminCourseSkeleton.mc and
 * watch-map-delivery.js courseSkeleton; GarminCourseOutlines.mc. No DOM, no fetch. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GDWatchCommon = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var CALM_KMH = 5.0, LEVEL2_KMH = 13.0, LEVEL3_KMH = 24.0;
  function toNumber(v) { return Math.trunc(v); }

  // ------------------------------------------------------------------ geometry (GarminBubbleMath GarminGeo)

  var METRES_PER_DEGREE = 111320.0, EARTH_RADIUS_M = 6371008.8;
  function degToRad(d) { return d * Math.PI / 180.0; }
  function radToDeg(r) { return r * 180.0 / Math.PI; }
  var Geo = {
    distance: function (a, b) {
      var dLat = degToRad(b.lat - a.lat), dLng = degToRad(b.lng - a.lng);
      var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(degToRad(a.lat)) * Math.cos(degToRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      var root = h > 0 ? Math.sqrt(h) : 0;
      if (root > 1) root = 1;
      return 2 * EARTH_RADIUS_M * Math.asin(root);
    },
    project: function (origin, angle, metres) {
      return { lat: origin.lat + (Math.cos(angle) * metres) / METRES_PER_DEGREE,
        lng: origin.lng + (Math.sin(angle) * metres) / (METRES_PER_DEGREE * Math.cos(degToRad(origin.lat))) };
    },
    /* GarminConditions.trueBearing: compass bearing, cosine-corrected. */
    trueBearing: function (a, b) {
      var dLat = b.lat - a.lat, dLng = (b.lng - a.lng) * Math.cos(degToRad(a.lat));
      return Math.atan2(dLng, dLat);
    }
  };

  // ------------------------------------------------------------------ GarminMapSpatialReference

  var TILE_SIZE = 256.0, MAX_MERCATOR_LATITUDE = 85.05112878;
  function SpatialReference(raw) {
    var t = raw && raw.transform || {};
    this.version = Number(raw && raw.version); this.refZoom = Number(raw && raw.refZoom);
    this.a = Number(t.a); this.b = Number(t.b); this.tx = Number(t.tx); this.ty = Number(t.ty);
    this.imageWidth = Number(raw && raw.imageWidth); this.imageHeight = Number(raw && raw.imageHeight);
    this.rotationDegrees = raw && Number.isFinite(Number(raw.rotationDegrees)) ? Number(raw.rotationDegrees) : null;
    this.metresPerPixel = raw && Number.isFinite(Number(raw.metresPerPixel)) ? Number(raw.metresPerPixel) : null;
  }
  SpatialReference.prototype.isUsable = function () {
    if (this.version !== 1) return false;
    if (!(this.imageWidth > 0) || !(this.imageHeight > 0)) return false;
    if (![this.a, this.b, this.tx, this.ty].every(Number.isFinite)) return false;
    return this.a * this.a + this.b * this.b > 0;
  };
  SpatialReference.prototype.worldPixel = function (lat, lng) {
    var scale = TILE_SIZE * Math.pow(2, this.refZoom);
    var clamped = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, lat));
    var latRad = degToRad(clamped);
    return { x: ((lng + 180.0) / 360.0) * scale, y: ((1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0) * scale };
  };
  SpatialReference.prototype.imagePoint = function (lat, lng) {
    if (!this.isUsable() || lat == null || lng == null) return null;
    var w = this.worldPixel(lat, lng);
    return { x: this.a * w.x - this.b * w.y + this.tx, y: this.b * w.x + this.a * w.y + this.ty };
  };
  SpatialReference.prototype.coordinate = function (x, y) {
    if (!this.isUsable()) return null;
    var det = this.a * this.a + this.b * this.b, sx = x - this.tx, sy = y - this.ty;
    var worldX = (this.a * sx + this.b * sy) / det, worldY = (this.a * sy - this.b * sx) / det;
    var scale = TILE_SIZE * Math.pow(2, this.refZoom);
    var n = Math.PI * (1.0 - (2.0 * worldY) / scale);
    return { lat: radToDeg(Math.atan(Math.sinh(n))), lng: (worldX / scale) * 360.0 - 180.0 };
  };

  // ------------------------------------------------------------------ DistanceFormat

  function formatDistance(metres, yards) {
    if (metres == null) return "-" + (yards ? "y" : "m");
    var shown = yards ? metres * 1.0936133 : metres;
    return toNumber(shown + 0.5) + (yards ? "y" : "m");
  }

  // ------------------------------------------------------------------ GarminConditions.windEffect

  function windLevel(kmh) { if (kmh < CALM_KMH) return 0; if (kmh >= LEVEL3_KMH) return 3; if (kmh >= LEVEL2_KMH) return 2; return 1; }
  /* wind: { fromDeg, kmh } or null (no weather). Returns the watch's own dictionary. */
  function windEffect(wind, player, target, flatM) {
    if (wind == null || player == null || target == null) return null;
    var lvl = windLevel(wind.kmh);
    if (lvl === 0) return { level: 0, alongM: 0.0, relRad: 0.0, ghost: null, kmh: wind.kmh };
    var carry = flatM != null ? flatM : 140.0;
    carry = Math.max(40.0, Math.min(260.0, carry));
    var base = Math.max(4.0, Math.min(12.0, carry * 0.045));
    var effect = base * lvl;
    var toRad = degToRad(wind.fromDeg) + Math.PI;
    var rel = toRad - Geo.trueBearing(player, target);
    return { level: lvl, kmh: wind.kmh, alongM: -effect * Math.cos(rel), relRad: rel, ghost: Geo.project(target, toRad, effect) };
  }
  /* GarminConditions.playsLikeM: flat + slope, + wind when applied; null with nothing to add. */
  function playsLikeM(flatM, slopeM, effect, windApplied) {
    if (flatM == null) return null;
    var withWind = windApplied && effect != null && effect.level > 0;
    if (slopeM == null && !withWind) return null;
    var out = flatM;
    if (slopeM != null) out += slopeM;
    if (withWind) out += effect.alongM;
    return out > 0 ? out : 0;
  }

  // ------------------------------------------------------------------ GarminPlayState.clampedToBag / GarminBubbleEngine.defaultTarget

  function clampedToBag(target, player, roofM) {
    if (roofM == null || roofM <= 0) return target;
    var metres = Geo.distance(player, target);
    if (!Number.isFinite(metres) || metres <= roofM) return target;
    var fraction = roofM / metres;
    return { lat: player.lat + (target.lat - player.lat) * fraction, lng: player.lng + (target.lng - player.lng) * fraction };
  }
  function sampleRoute(route, stepM) {
    if (!route.length) return [];
    var samples = [{ point: route[0], progress: 0.0 }], progress = 0.0;
    for (var i = 1; i < route.length; i++) {
      var a = route[i - 1], b = route[i], segment = Geo.distance(a, b);
      if (!Number.isFinite(segment) || segment <= 0) continue;
      var steps = Math.max(1, Math.ceil(segment / Math.max(stepM, 3.0)));
      for (var s = 1; s <= steps; s++) {
        var t = s / steps;
        samples.push({ point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }, progress: progress + segment * t });
      }
      progress += segment;
    }
    return samples;
  }
  function layupAlong(route, player, maxM) {
    var samples = sampleRoute(route, 7.0);
    if (samples.length < 2) return null;
    var nearestIndex = 0, nearestScore = Geo.distance(player, samples[0].point);
    for (var i = 0; i < samples.length; i++) { var score = Geo.distance(player, samples[i].point); if (score < nearestScore) { nearestIndex = i; nearestScore = score; } }
    var minProgress = Math.max(0, samples[nearestIndex].progress);
    var best = null;
    samples.forEach(function (s) {
      if (s.progress < minProgress + 6.0) return;
      var direct = Geo.distance(player, s.point);
      if (!Number.isFinite(direct) || direct > maxM + 3.0) return;
      var sc = Math.abs(maxM - direct);
      var take = !best || sc < best.score - 0.75 || (Math.abs(sc - best.score) <= 0.75 && s.progress > best.progress);
      if (take) best = { point: s.point, progress: s.progress, direct: direct, score: sc };
    });
    if (!best) return null;
    if (best.direct < Math.max(45.0, maxM * 0.58)) return null;
    return best.point;
  }
  /* The green when the bag reaches it (plus 3 m grace), else the layup down the hole's route;
     null when there is no honest answer (the caller keeps the phone's target). */
  function defaultTarget(player, green, route, maxM) {
    if (maxM == null || maxM <= 0 || player == null || green == null) return null;
    var toGreen = Geo.distance(player, green);
    if (!Number.isFinite(toGreen)) return null;
    if (toGreen <= maxM + 3.0) return green;
    return layupAlong(route || [], player, maxM);
  }

  // ------------------------------------------------------------------ the package, as the watch holds it

  /* GarminCourseOutlines.hole(n): rings boxed and ready to place. The report's rings are
     absolute image pixels (delta-encoding is for the wire only). Trees stay packed. */
  function boxRing(flat, start) {
    var n = flat.length - start;
    if (n < 6) return null;
    var out = new Array(n), minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i + 1 < n; i += 2) {
      var x = Math.trunc(Number(flat[start + i])), y = Math.trunc(Number(flat[start + i + 1]));
      out[i] = x; out[i + 1] = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { p: out, box: [minX, minY, maxX, maxY] };
  }
  function decodeShapes(hole) {
    var o = hole && hole.outlines;
    if (!o) return null;
    var rings = function (list) { return (Array.isArray(list) ? list : []).map(function (r) { return boxRing(r, 0); }).filter(Boolean); };
    var terrain = hole.terrain && Array.isArray(hole.terrain.p) ? hole.terrain.p : (Array.isArray(hole.terrain) ? hole.terrain : []);
    var pieces = terrain.map(function (piece) { var r = boxRing(piece, 1); if (r) r.label = Math.trunc(Number(piece[0])); return r; }).filter(Boolean);
    var trees = hole.trees && Array.isArray(hole.trees.c) ? hole.trees.c : (Array.isArray(hole.trees) ? hole.trees : []);
    return { f: rings(o.f), b: rings(o.b), w: rings(o.w), k: rings(o.k), h: rings(o.h), z: rings(o.z), g: o.g ? boxRing(o.g, 0) : null, t: pieces,
      c: trees.filter(function (v) { return Number.isInteger(v) && v >= 0; }) };
  }

  /* The course skeleton, cut as the phone cuts it (watch-map-delivery.js courseSkeleton) and read
     as the watch reads it (GarminCourseSkeleton): per hole the green centre, the tee, up to 16
     points of the green outline, the route between, and the hole length. */
  var SKELETON_SHAPE_POINTS = 16;
  function skeletonHole(hole) {
    var ref = hole && hole.reference;
    if (!ref || !ref.green) return null;
    var g = { lat: Number(ref.green.lat), lng: Number(ref.green.lng) };
    var shape = Array.isArray(ref.greenShape) ? ref.greenShape : [];
    if (shape.length > SKELETON_SHAPE_POINTS) {
      var step = shape.length / SKELETON_SHAPE_POINTS, picked = [];
      for (var i = 0; i < SKELETON_SHAPE_POINTS; i++) picked.push(shape[Math.floor(i * step)]);
      shape = picked;
    }
    var out = { n: Number(hole.holeNumber), g: g, t: null, s: shape.map(function (p) { return { lat: Number(p.lat), lng: Number(p.lng) }; }), r: [], len: null };
    if (ref.tee && Array.isArray(ref.route) && ref.route.length >= 2 && Number.isFinite(Number(ref.lengthM))) {
      out.t = { lat: Number(ref.tee.lat), lng: Number(ref.tee.lng) };
      out.len = Math.round(Number(ref.lengthM));
      out.r = ref.route.filter(function (p) {
        return !(Math.abs(p.lat - out.t.lat) < 1e-7 && Math.abs(p.lng - out.t.lng) < 1e-7) && !(Math.abs(p.lat - g.lat) < 1e-7 && Math.abs(p.lng - g.lng) < 1e-7);
      }).map(function (p) { return { lat: Number(p.lat), lng: Number(p.lng) }; });
    }
    return out;
  }
  function skeletonDistances(sk, from) {
    if (!sk || !from) return null;
    var centre = Geo.distance(from, sk.g), front = centre, back = centre;
    sk.s.forEach(function (p) { var d = Geo.distance(from, p); if (d < front) front = d; if (d > back) back = d; });
    return { front: front, centre: centre, back: back };
  }
  function skeletonLine(sk) {
    if (!sk || !sk.t) return [];
    return [sk.t].concat(sk.r, [sk.g]);
  }

  return {
    Geo: Geo,
    SpatialReference: SpatialReference,
    degToRad: degToRad,
    radToDeg: radToDeg,
    formatDistance: formatDistance,
    windLevel: windLevel,
    windEffect: windEffect,
    playsLikeM: playsLikeM,
    clampedToBag: clampedToBag,
    defaultTarget: defaultTarget,
    decodeShapes: decodeShapes,
    skeletonHole: skeletonHole,
    skeletonDistances: skeletonDistances,
    skeletonLine: skeletonLine
  };
});
