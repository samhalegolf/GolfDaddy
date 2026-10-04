/* Clarity Studio — Mapping Overlay shape builders. Studio-only, pure geometry.
 *
 * The overlay is placed by eye, not traced: a person lays a line down the middle of a fairway
 * and gets a fairway-shaped polygon with evenly spaced corners to drag into shape; a pin on a
 * green becomes a green outline (the wand, server-side) or, when the wand has nothing, the
 * round default made here. Bunker outlines that overlap are merged into one. Everything is in
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
  /* A tee is a round marker on where the tee is - which way it faces is the hole's business,
     not the marker's. Same size the overlay core gives a tee pin (PIN_RADIUS_M.tee). */
  var TEE_RADIUS_M = 6;
  var GREEN_RADIUS_M = 14;
  /* A green is edited by a handful of points, not by every corner the wand found: six handles,
     and the outline a smooth curve through them with six corners between each pair. */
  var GREEN_HANDLES = 6;
  var GREEN_STEPS = 6;
  /* The round bunker left when the wand cannot find an edge - a typical greenside bunker. */
  var BUNKER_RADIUS_M = 6;
  /* Merging bunkers: the two outlines are painted onto a grid of cells this fine (coarser for
     a very large pair, so the grid stays at most MERGE_MAX_CELLS a side), and the merged
     outline is simplified to at most MERGE_MAX_POINTS corners - room left under MAX_POINTS
     for corners added by hand. */
  var MERGE_CELL_M = 0.25;
  var MERGE_MAX_CELLS = 400;
  var MERGE_MAX_POINTS = 40;

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

  function teeAt(centre) {
    return circle(centre, TEE_RADIUS_M, 12);
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

  /* Centripetal Catmull-Rom between p1 and p2 - it passes through every handle and, unlike the
     uniform kind, never loops or overshoots where two handles sit close together. */
  function catmullRom(p0, p1, p2, p3, t) {
    function knot(ti, a, b) { return ti + Math.sqrt(Math.max(len(sub(b, a)), 1e-6)); }
    var t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
    var u = t1 + (t2 - t1) * t;
    function mix(a, b, ta, tb) { var w = (u - ta) / (tb - ta); return add(scale(a, 1 - w), scale(b, w)); }
    var a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
    return mix(mix(a1, a2, t0, t2), mix(a2, a3, t1, t3), t1, t2);
  }

  /* A closed smooth outline through `handles`, `steps` corners from each handle to the next,
     starting on the first handle - so handle k is corner k * steps of the result. */
  function smoothRing(handles, steps) {
    var n = handles.length, per = steps || GREEN_STEPS;
    if (n < 3) return handles.slice();
    var f = frame(handles[0]);
    var p = handles.map(f.toXY), out = [];
    for (var i = 0; i < n; i++) {
      var p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
      for (var s = 0; s < per; s++) out.push(catmullRom(p0, p1, p2, p3, s / per));
    }
    return out.map(f.toLL);
  }

  /* The handles a ring is edited by: read straight back off a ring smoothRing made, otherwise
     spaced evenly round its edge from its first corner. */
  function ringHandles(ring, count, steps) {
    var n = count || GREEN_HANDLES, per = steps || GREEN_STEPS;
    if (!ring || ring.length < 3) return (ring || []).slice();
    if (ring.length === n * per) return ring.filter(function (p, i) { return i % per === 0; });
    var f = frame(ring[0]);
    var xy = ring.map(f.toXY).concat([f.toXY(ring[0])]);
    var total = 0;
    for (var i = 1; i < xy.length; i++) total += len(sub(xy[i], xy[i - 1]));
    /* n even steps round the closed edge give n + 1 stations, the last back on the first. */
    return resample(xy, total / n).slice(0, n).map(f.toLL);
  }

  /* A green as it is kept once outlined: the smooth curve through its six handles. */
  function smoothGreen(ring) {
    return smoothRing(ringHandles(ring, GREEN_HANDLES, GREEN_STEPS), GREEN_STEPS);
  }

  function insideRing(pt, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  /* Douglas-Peucker on a closed ring: corners closer than tol to the line they sit on go. */
  function simplifyRing(ring, tol) {
    function dist(p, a, b) {
      var d = sub(b, a), l = len(d);
      if (l < 1e-9) return len(sub(p, a));
      return Math.abs(d.x * (a.y - p.y) - d.y * (a.x - p.x)) / l;
    }
    function run(pts) {
      var best = 0, idx = 0;
      for (var i = 1; i < pts.length - 1; i++) { var d = dist(pts[i], pts[0], pts[pts.length - 1]); if (d > best) { best = d; idx = i; } }
      if (best <= tol) return [pts[0], pts[pts.length - 1]];
      return run(pts.slice(0, idx + 1)).slice(0, -1).concat(run(pts.slice(idx)));
    }
    /* Split at the corner furthest from the first, so both halves are open lines. */
    var far = 0, fd = 0;
    ring.forEach(function (p, i) { var d = len(sub(p, ring[0])); if (d > fd) { fd = d; far = i; } });
    var a = run(ring.slice(0, far + 1)), b = run(ring.slice(far).concat([ring[0]]));
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  function ringArea(ring) {
    var a = 0;
    for (var i = 0; i < ring.length; i++) { var p = ring[i], q = ring[(i + 1) % ring.length]; a += p.x * q.y - q.x * p.y; }
    return a / 2;
  }

  /* Two outlines that overlap, as one: the outer edge of everything either covers. Null when
     they do not overlap, so a caller can try the next one. Done on a fine grid rather than by
     clipping polygons - a wand outline can cross itself, and a grid does not care. */
  function mergeOverlapping(ringA, ringB) {
    if (!ringA || !ringB || ringA.length < 3 || ringB.length < 3) return null;
    var f = frame(ringA[0]);
    var a = ringA.map(f.toXY), b = ringB.map(f.toXY);
    var all = a.concat(b);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    all.forEach(function (p) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    var cell = Math.max(MERGE_CELL_M, Math.max(maxX - minX, maxY - minY) / MERGE_MAX_CELLS);
    /* One empty cell of margin all round, so the traced edge never runs off the grid. */
    var w = Math.ceil((maxX - minX) / cell) + 2, h = Math.ceil((maxY - minY) / cell) + 2;
    var x0 = minX - cell, y0 = minY - cell;
    var filled = new Uint8Array(w * h);
    var overlap = false;
    for (var gy = 0; gy < h; gy++) {
      for (var gx = 0; gx < w; gx++) {
        var c = { x: x0 + (gx + 0.5) * cell, y: y0 + (gy + 0.5) * cell };
        var inA = insideRing(c, a), inB = insideRing(c, b);
        if (inA && inB) overlap = true;
        if (inA || inB) filled[gy * w + gx] = 1;
      }
    }
    if (!overlap) return null;
    function on(gx, gy) { return gx >= 0 && gy >= 0 && gx < w && gy < h && filled[gy * w + gx] === 1; }
    /* Every cell side between filled and empty is an edge, walked with the filled cell on its
       left, so edges chain head to tail into closed loops. Corners are grid points (gx, gy). */
    var next = {};
    function edge(ax, ay, bx, by) { var k = ax + "," + ay; (next[k] = next[k] || []).push([bx, by]); }
    for (gy = 0; gy < h; gy++) {
      for (gx = 0; gx < w; gx++) {
        if (!on(gx, gy)) continue;
        if (!on(gx, gy - 1)) edge(gx, gy, gx + 1, gy);
        if (!on(gx + 1, gy)) edge(gx + 1, gy, gx + 1, gy + 1);
        if (!on(gx, gy + 1)) edge(gx + 1, gy + 1, gx, gy + 1);
        if (!on(gx - 1, gy)) edge(gx, gy + 1, gx, gy);
      }
    }
    var best = null, bestArea = 0;
    Object.keys(next).forEach(function (startKey) {
      while (next[startKey] && next[startKey].length) {
        var loop = [], key = startKey;
        while (next[key] && next[key].length) {
          var to = next[key].pop();
          var xy = key.split(",");
          loop.push({ x: x0 + Number(xy[0]) * cell, y: y0 + Number(xy[1]) * cell });
          key = to[0] + "," + to[1];
        }
        var area = Math.abs(ringArea(loop));
        if (loop.length >= 3 && area > bestArea) { bestArea = area; best = loop; }
      }
    });
    if (!best) return null;
    var tol = cell * 0.75;
    var out = simplifyRing(best, tol);
    while (out.length > MERGE_MAX_POINTS) { tol *= 1.5; out = simplifyRing(best, tol); }
    return out.length >= 3 ? out.map(f.toLL) : null;
  }

  var api = {
    FAIRWAY_WIDTH_M: FAIRWAY_WIDTH_M, TEE_RADIUS_M: TEE_RADIUS_M, GREEN_RADIUS_M: GREEN_RADIUS_M,
    GREEN_HANDLES: GREEN_HANDLES, GREEN_STEPS: GREEN_STEPS, BUNKER_RADIUS_M: BUNKER_RADIUS_M, MAX_POINTS: MAX_POINTS,
    distanceM: distanceM, lineLengthM: lineLengthM, centroid: centroid,
    fairwayFromLine: fairwayFromLine, teeAt: teeAt, circle: circle, mergeOverlapping: mergeOverlapping,
    smoothRing: smoothRing, ringHandles: ringHandles, smoothGreen: smoothGreen
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GDOverlayShapes = api;
})(typeof window !== "undefined" ? window : this);
