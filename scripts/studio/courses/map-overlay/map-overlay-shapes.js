/* Clarity Studio — Mapping Overlay shape builders. Studio-only, pure geometry.
 *
 * The overlay is placed by eye, not traced: a person lays a line down the middle of a fairway
 * and gets a fairway-shaped polygon with evenly spaced corners to drag into shape, plus a tee
 * box just behind the start of the line; a pin on a green becomes a green outline (the wand,
 * server-side) or, when the wand has nothing, the round default made here. Everything is in
 * plain {lat, lng} and flat-earth metres about the shape's own position, which is exact
 * enough at the size of a golf hole.
 *
 * Loaded by index.html before map-overlay-page.js (window.GDOverlayShapes) and required by
 * dev/map-overlay-shapes.test.js. */
(function (root) {
  "use strict";

  var M_PER_DEG = 111320;
  /* A fairway is usually 30-45m across; 35m is a middle that reads as a fairway at a glance
     and is quick to pull in or out. */
  var FAIRWAY_WIDTH_M = 35;
  /* The overlay stores at most 64 points a shape (gd-map-overlay-core OVERLAY_MAX_POINTS).
     A corner every ~30m is enough to bend a fairway to what is on the ground without a wall of
     handles, and capping the stations at 20 a side keeps room under the 64 for the corners a
     person adds by hand. */
  var MAX_POINTS = 64;
  var MIN_SPACING_M = 30;
  var MAX_STATIONS = 20;
  /* Where the tee goes: centred this far behind the start of the fairway line. */
  var TEE_BEYOND_M = 20;
  var TEE_LENGTH_M = 16;
  var TEE_WIDTH_M = 10;
  var GREEN_RADIUS_M = 14;
  /* A green further than this from either end of the line is not telling us which way the
     hole plays. */
  var GREEN_HINT_M = 350;

  function frame(origin) {
    var k = Math.cos(origin.lat * Math.PI / 180);
    return {
      toXY: function (p) { return { x: (p.lng - origin.lng) * M_PER_DEG * k, y: (p.lat - origin.lat) * M_PER_DEG }; },
      toLL: function (v) { return { lat: origin.lat + v.y / M_PER_DEG, lng: origin.lng + v.x / (M_PER_DEG * k) }; }
    };
  }
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function scale(a, s) { return { x: a.x * s, y: a.y * s }; }
  function len(a) { return Math.hypot(a.x, a.y); }
  function unit(a) { var l = len(a); return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 1 }; }
  function perp(a) { return { x: -a.y, y: a.x }; }

  function distanceM(a, b) {
    var f = frame(a);
    return len(f.toXY(b));
  }

  function lineLengthM(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) total += distanceM(points[i - 1], points[i]);
    return total;
  }

  /* Evenly spaced stations along a polyline, both ends included. */
  function resample(xy, spacing) {
    var total = 0, segs = [];
    for (var i = 1; i < xy.length; i++) { var l = len(sub(xy[i], xy[i - 1])); segs.push(l); total += l; }
    var n = Math.max(1, Math.round(total / spacing));
    var out = [];
    for (var s = 0; s <= n; s++) {
      var target = total * s / n, run = 0, j = 0;
      while (j < segs.length - 1 && run + segs[j] < target) { run += segs[j]; j++; }
      var t = segs[j] > 1e-9 ? (target - run) / segs[j] : 0;
      out.push(add(xy[j], scale(sub(xy[j + 1], xy[j]), Math.min(1, Math.max(0, t)))));
    }
    return out;
  }

  /* A fairway around a centre line: the line resampled into stations, each pushed out half the
     width either side along the local normal, plus a rounded point beyond each end. The corners
     are the "notches" a person drags to fit the fairway they can see. */
  function fairwayFromLine(points, widthM) {
    var line = (points || []).filter(Boolean);
    if (line.length < 2) return null;
    var width = Number(widthM) > 0 ? Number(widthM) : FAIRWAY_WIDTH_M;
    var f = frame(line[0]);
    var xy = line.map(f.toXY);
    var total = 0;
    for (var i = 1; i < xy.length; i++) total += len(sub(xy[i], xy[i - 1]));
    if (total < 5) return null;
    var spacing = Math.max(MIN_SPACING_M, total / (MAX_STATIONS - 1));
    var st = resample(xy, spacing);
    var half = width / 2;
    var left = [], right = [];
    st.forEach(function (p, k) {
      var prev = st[Math.max(0, k - 1)], next = st[Math.min(st.length - 1, k + 1)];
      var n = perp(unit(sub(next, prev)));
      left.push(add(p, scale(n, half)));
      right.push(add(p, scale(n, -half)));
    });
    var startDir = unit(sub(st[1], st[0]));
    var endDir = unit(sub(st[st.length - 1], st[st.length - 2]));
    var ring = [add(st[0], scale(startDir, -half * 0.5))]
      .concat(right)
      .concat([add(st[st.length - 1], scale(endDir, half * 0.5))])
      .concat(left.reverse());
    return ring.map(f.toLL);
  }

  function centroid(points) {
    var lat = 0, lng = 0;
    points.forEach(function (p) { lat += p.lat; lng += p.lng; });
    return { lat: lat / points.length, lng: lng / points.length };
  }

  /* Which end of a fairway line is the tee end. A line is normally laid tee to green, so the
     start wins unless a known green sits clearly nearer the start than the end - then the line
     was laid green to tee and it is flipped. */
  function teeEnd(points, greens) {
    var a = points[0], b = points[points.length - 1];
    var da = Infinity, db = Infinity;
    (greens || []).forEach(function (g) {
      var ring = g && g.points ? g.points : g;
      if (!ring || !ring.length) return;
      var c = centroid(ring);
      da = Math.min(da, distanceM(a, c));
      db = Math.min(db, distanceM(b, c));
    });
    var flip = da < GREEN_HINT_M && da < db * 0.6;
    return flip ? { end: b, towards: points[points.length - 2] } : { end: a, towards: points[1] };
  }

  /* A tee box rectangle centred on `centre`, its long side pointing at `towards`. */
  function teeAt(centre, towards) {
    var f = frame(centre);
    var dir = towards ? unit(f.toXY(towards)) : { x: 0, y: 1 };
    if (towards && len(f.toXY(towards)) < 1e-6) dir = { x: 0, y: 1 };
    var n = perp(dir);
    var hl = TEE_LENGTH_M / 2, hw = TEE_WIDTH_M / 2;
    return [
      add(scale(dir, -hl), scale(n, -hw)),
      add(scale(dir, -hl), scale(n, hw)),
      add(scale(dir, hl), scale(n, hw)),
      add(scale(dir, hl), scale(n, -hw))
    ].map(f.toLL);
  }

  /* The tee for a fairway line: TEE_BEYOND_M behind its tee end, facing down the line. */
  function teeBeyondLine(points, greens) {
    var line = (points || []).filter(Boolean);
    if (line.length < 2) return null;
    var pick = teeEnd(line, greens);
    var f = frame(pick.end);
    var back = unit(sub({ x: 0, y: 0 }, f.toXY(pick.towards)));
    var centre = f.toLL(scale(back, TEE_BEYOND_M));
    return teeAt(centre, pick.end);
  }

  function circle(centre, radiusM, n) {
    var f = frame(centre);
    var r = Number(radiusM) > 0 ? Number(radiusM) : GREEN_RADIUS_M;
    var count = n || 16, out = [];
    for (var i = 0; i < count; i++) {
      var a = (i / count) * Math.PI * 2;
      out.push(f.toLL({ x: Math.cos(a) * r, y: Math.sin(a) * r }));
    }
    return out;
  }

  var api = {
    FAIRWAY_WIDTH_M: FAIRWAY_WIDTH_M, TEE_BEYOND_M: TEE_BEYOND_M, TEE_LENGTH_M: TEE_LENGTH_M,
    TEE_WIDTH_M: TEE_WIDTH_M, GREEN_RADIUS_M: GREEN_RADIUS_M, MAX_POINTS: MAX_POINTS,
    distanceM: distanceM, lineLengthM: lineLengthM, centroid: centroid,
    fairwayFromLine: fairwayFromLine, teeBeyondLine: teeBeyondLine, teeAt: teeAt, teeEnd: teeEnd, circle: circle
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GDOverlayShapes = api;
})(typeof window !== "undefined" ? window : this);
