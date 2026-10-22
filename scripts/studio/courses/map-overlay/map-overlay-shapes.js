/* Clarity Studio — Mapping Overlay shape builders. Studio-only, pure geometry.
 *
 * The overlay is placed by eye, not traced: a person lays a line down the middle of a fairway
 * and gets a fairway-shaped polygon with evenly spaced corners to drag into shape; a pin on a
 * green becomes a green outline (the wand, server-side) or, when the wand has nothing, the
 * round default made here. Greens and bunkers are kept as smooth curves through a few handles.
 * Bunker outlines that overlap are merged into one. A water hazard drawn round by hand is
 * thinned to the corners that matter. A single tree is a small ring, a cluster an oval
 * stretched over it; the tree finder looks for more trees like the ones placed by hand (or,
 * along the fairways and greens, for ground darker, greener and rougher than their turf), the
 * area wand outlines a waste area, and the colour wand outlines anything picked by its colour.
 * A wand outline keeps many corners so it follows the ground, and is reshaped by a few key
 * corners and by bending its edge where it is grabbed (keyCorners, bendRing). Everything is in
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
  /* The overlay stores at most 256 points a shape (gd-map-overlay-core OVERLAY_MAX_POINTS) -
     room for a wand outline that follows the ground closely. A corner every ~30m is enough to
     bend a fairway to what is on the ground, so a fairway's stations stay capped at 20 a side. */
  var MAX_POINTS = 256;
  /* A wand outline (colour wand, Draw + grow, line wand) keeps at most this many corners: close
     to the edge it found, with room left under MAX_POINTS for reshaping. Only a few of them
     are shown as handles (keyCorners); the rest bend with the edge when it is dragged. */
  var DETAIL_MAX_POINTS = 220;
  var MIN_SPACING_M = 30;
  var MAX_STATIONS = 20;
  /* A tee is a round marker on where the tee is - which way it faces is the hole's business,
     not the marker's. Same size the overlay core gives a tee pin (PIN_RADIUS_M.tee). */
  var TEE_RADIUS_M = 6;
  /* A single tree is a small ring round its crown - a typical parkland tree's crown is 6-10m
     across. Few corners: a course can hold hundreds of them. */
  var TREE_RADIUS_M = 4;
  var TREE_POINTS = 10;
  /* A cluster of trees stretched out as an oval. */
  var OVAL_POINTS = 24;
  var GREEN_RADIUS_M = 14;
  /* Greens and bunkers are edited by a handful of points, not by every corner the wand found:
     the outline is a smooth curve through the handles, `steps` corners between each pair -
     nowhere near the wand's raw corners. The counts are fixed per kind so the handles read
     straight back off a saved outline (ringHandles). */
  var SMOOTH = { green: { handles: 8, steps: 6 }, bunker: { handles: 8, steps: 4 } };
  /* Fairways, water and waste follow the edge the wand traced, softened (softenOutline): walked
     every SOFT_STEP_M metres (at most SOFT_MAX_STATIONS stations), eased over SOFT_REACH_M
     either way, and thinned to corners SOFT_TOLERANCE_M off the curve. */
  var SOFT_KINDS = ["fairway", "water", "waste"];
  var SOFT_STEP_M = 1;
  var SOFT_MAX_STATIONS = 800;
  var SOFT_REACH_M = 3;
  var SOFT_TOLERANCE_M = 0.2;
  /* The round bunker left when the wand cannot find an edge - a typical greenside bunker. */
  var BUNKER_RADIUS_M = 6;
  /* The round pond left when the wand cannot find an edge. */
  var WATER_RADIUS_M = 15;
  /* A water hazard drawn round by hand keeps at most this many corners - enough for a creek's
     bends, few enough to drag. */
  var WATER_MAX_POINTS = 32;
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

  function treeAt(centre, radiusM) {
    return circle(centre, Number(radiusM) > 0 ? Number(radiusM) : TREE_RADIUS_M, TREE_POINTS);
  }

  /* The oval that fills the box between two corners, as dragged from one to the other - or a
     circle as wide as the box's longer side, when `round`. */
  function ellipseInBox(a, b, round) {
    var mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    var f = frame(mid);
    var p = f.toXY(a), q = f.toXY(b);
    var rx = Math.abs(q.x - p.x) / 2, ry = Math.abs(q.y - p.y) / 2;
    if (round) rx = ry = Math.max(rx, ry);
    var out = [];
    for (var i = 0; i < OVAL_POINTS; i++) {
      var t = (i / OVAL_POINTS) * Math.PI * 2;
      out.push(f.toLL({ x: Math.cos(t) * rx, y: Math.sin(t) * ry }));
    }
    return out;
  }

  /* How far a ring's corners sit from its middle, on average - a tree's crown radius. */
  function ringRadiusM(points) {
    if (!points || !points.length) return 0;
    var c = centroid(points);
    return points.reduce(function (sum, p) { return sum + distanceM(c, p); }, 0) / points.length;
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
    var n = handles.length, per = steps || SMOOTH.green.steps;
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
    var n = count || SMOOTH.green.handles, per = steps || SMOOTH.green.steps;
    if (!ring || ring.length < 3) return (ring || []).slice();
    if (ring.length === n * per) return ring.filter(function (p, i) { return i % per === 0; });
    var f = frame(ring[0]);
    var xy = ring.map(f.toXY).concat([f.toXY(ring[0])]);
    var total = 0;
    for (var i = 1; i < xy.length; i++) total += len(sub(xy[i], xy[i - 1]));
    /* n even steps round the closed edge give n + 1 stations, the last back on the first. */
    return resample(xy, total / n).slice(0, n).map(f.toLL);
  }

  /* A wand outline as it is kept: a green or bunker is the smooth curve through its handles,
     a fairway, water or waste area its traced edge softened (softenOutline). Any other kind
     comes back as it is. */
  function smoothOutline(ring, kind) {
    var s = SMOOTH[kind];
    if (s) return smoothRing(ringHandles(ring, s.handles, s.steps), s.steps);
    return SOFT_KINDS.indexOf(kind) >= 0 ? softenOutline(ring) : ring;
  }

  /* A wand's edge is traced a pixel at a time, so it comes out in stair-steps and little
     spurs. Softened: the edge is walked at even steps, each point eased towards its
     neighbours a few metres either way (a gentle bell, so a real bend stays a bend), then
     thinned back to the corners that still carry the curve. A small shape is eased less. */
  function softenOutline(ring, maxPoints) {
    if (!ring || ring.length < 4) return ring;
    var f = frame(ring[0]);
    var xy = ring.map(f.toXY);
    xy.push(xy[0]);
    var total = 0;
    for (var i = 1; i < xy.length; i++) total += len(sub(xy[i], xy[i - 1]));
    if (total < 8) return ring;
    var step = Math.max(SOFT_STEP_M, total / SOFT_MAX_STATIONS);
    var pts = resample(xy, step);
    pts.pop();
    var n = pts.length;
    var reach = Math.min(SOFT_REACH_M, total / 30);
    var k = Math.min(Math.floor((n - 1) / 6), Math.round(reach / step));
    if (k < 1) return ring;
    var sigma = k / 2, weights = [], sum = 0;
    for (var d = -k; d <= k; d++) { var wgt = Math.exp(-(d * d) / (2 * sigma * sigma)); weights.push(wgt); sum += wgt; }
    var eased = pts.map(function (p, idx) {
      var x = 0, y = 0;
      for (var d2 = -k; d2 <= k; d2++) { var q = pts[(idx + d2 + n) % n], wq = weights[d2 + k]; x += q.x * wq; y += q.y * wq; }
      return { x: x / sum, y: y / sum };
    });
    var cap = maxPoints || DETAIL_MAX_POINTS;
    var tol = SOFT_TOLERANCE_M, out = simplifyRing(eased, tol);
    while (out.length > cap) { tol *= 1.5; out = simplifyRing(eased, tol); }
    return out.length >= 3 ? out.map(f.toLL) : ring;
  }

  /* The same outline grown or shrunk about its middle - "bigger" and "smaller" on a tee or a
     hand-drawn water hazard. */
  function scaleAbout(points, factor) {
    if (!points || !points.length) return [];
    var f = frame(centroid(points));
    return points.map(function (p) { return f.toLL(scale(f.toXY(p), factor)); });
  }

  /* A freehand line drawn round something, as a closed outline with at most maxPoints corners:
     the wobble of a hand dragging a mouse goes, the shape stays. */
  function simplifyOutline(points, maxPoints) {
    var pts = (points || []).filter(Boolean);
    if (pts.length < 3) return null;
    var f = frame(pts[0]);
    var xy = pts.map(f.toXY);
    var last = xy[xy.length - 1];
    if (xy.length > 3 && len(sub(last, xy[0])) < 0.05) xy.pop();
    if (Math.abs(ringArea(xy)) < 1) return null;
    var cap = maxPoints || WATER_MAX_POINTS;
    var tol = 0.5, out = simplifyRing(xy, tol);
    while (out.length > cap) { tol *= 1.5; out = simplifyRing(xy, tol); }
    return out.length >= 3 ? out.map(f.toLL) : null;
  }

  function insideRing(pt, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  /* Douglas-Peucker on an open line: its two ends stay, corners closer than tol to the line
     they sit on go. The corners kept are the very objects passed in. */
  function simplifyLine(pts, tol) {
    function dist(p, a, b) {
      var d = sub(b, a), l = len(d);
      if (l < 1e-9) return len(sub(p, a));
      return Math.abs(d.x * (a.y - p.y) - d.y * (a.x - p.x)) / l;
    }
    function run(pts) {
      if (pts.length < 3) return pts.slice();
      var best = 0, idx = 0;
      for (var i = 1; i < pts.length - 1; i++) { var d = dist(pts[i], pts[0], pts[pts.length - 1]); if (d > best) { best = d; idx = i; } }
      if (best <= tol) return [pts[0], pts[pts.length - 1]];
      return run(pts.slice(0, idx + 1)).slice(0, -1).concat(run(pts.slice(idx)));
    }
    return run(pts);
  }

  /* Douglas-Peucker on a closed ring: corners closer than tol to the line they sit on go. */
  function simplifyRing(ring, tol) {
    /* Split at the corner furthest from the first, so both halves are open lines. */
    var far = 0, fd = 0;
    ring.forEach(function (p, i) { var d = len(sub(p, ring[0])); if (d > fd) { fd = d; far = i; } });
    var a = simplifyLine(ring.slice(0, far + 1), tol), b = simplifyLine(ring.slice(far).concat([ring[0]]), tol);
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  function ringArea(ring) {
    var a = 0;
    for (var i = 0; i < ring.length; i++) { var p = ring[i], q = ring[(i + 1) % ring.length]; a += p.x * q.y - q.x * p.y; }
    return a / 2;
  }

  /* Two outlines that overlap, as one: the outer edge of everything either covers, at most
     maxPoints corners (MERGE_MAX_POINTS by default). Null when
     they do not overlap, so a caller can try the next one. Done on a fine grid rather than by
     clipping polygons - a wand outline can cross itself, and a grid does not care. */
  function mergeOverlapping(ringA, ringB, maxPoints) {
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
    var best = traceLargestLoop(filled, w, h);
    if (!best) return null;
    best = best.map(function (g) { return { x: x0 + g.x * cell, y: y0 + g.y * cell }; });
    if (!best) return null;
    var tol = cell * 0.75;
    var out = simplifyRing(best, tol);
    var cap = maxPoints || MERGE_MAX_POINTS;
    while (out.length > cap) { tol *= 1.5; out = simplifyRing(best, tol); }
    return out.length >= 3 ? out.map(f.toLL) : null;
  }

  /* ---- reshaping by distance ----
     "Bigger" and "smaller" on a green or a fairway grow or shrink the outline evenly - every
     part of its edge moves the same distance, so a long thin green stays long and thin rather
     than swelling about its middle or being re-wanded rounder. Done on a fine grid, like
     merging: the outlines are painted on, the paint is grown or eaten back by a true distance,
     and the edge is traced again.

     closeM bridges cut-ins first: the paint is grown by closeM and eaten back by the same, so
     a notch narrower than about twice closeM - an overhanging tree, a shadow - fills in, while
     the general shape and its outward bends stay as they were. The fairway's ↑ ↓ use it; a
     straight edge is never forced on it. */
  var RESHAPE_MIN_CELL_M = 0.2;
  var RESHAPE_MAX_CELLS = 500;

  function paintRing(mask, w, h, xy, x0, y0, cell) {
    for (var gy = 0; gy < h; gy++) {
      var y = y0 + (gy + 0.5) * cell, xs = [];
      for (var i = 0, j = xy.length - 1; i < xy.length; j = i++) {
        var a = xy[i], b = xy[j];
        if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      xs.sort(function (p, q) { return p - q; });
      for (var k = 0; k + 1 < xs.length; k += 2) {
        var c0 = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5)), c1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5));
        for (var gx = c0; gx <= c1; gx++) mask[gy * w + gx] = 1;
      }
    }
  }

  /* rings (lat/lng outlines, painted together - so two rings come back as one) grown by growM
     metres (negative shrinks), after cut-ins up to about 2 x closeM wide are bridged. Null when
     nothing is left. */
  function reshapeOutline(rings, opts) {
    var o = opts || {};
    var list = (rings || []).filter(function (r) { return r && r.length >= 3; });
    if (!list.length) return null;
    var grow = Number(o.growM) || 0, close = Math.max(0, Number(o.closeM) || 0);
    var f = frame(centroid(list[0]));
    var xys = list.map(function (r) { return r.map(f.toXY); });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    xys.forEach(function (xy) { xy.forEach(function (p) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }); });
    var pad = Math.max(0, grow) + close + 2;
    var cell = Math.max(RESHAPE_MIN_CELL_M, (Math.max(maxX - minX, maxY - minY) + 2 * pad) / RESHAPE_MAX_CELLS);
    var x0 = minX - pad, y0 = minY - pad;
    var w = Math.ceil((maxX - minX + 2 * pad) / cell), h = Math.ceil((maxY - minY + 2 * pad) / cell);
    var mask = new Uint8Array(w * h), i;
    xys.forEach(function (xy) { paintRing(mask, w, h, xy, x0, y0, cell); });
    function grown(m, r) { var d = distanceTo(m, w, h), out = new Uint8Array(w * h); for (var k = 0; k < out.length; k++) out[k] = d[k] <= r ? 1 : 0; return out; }
    function eaten(m, r) {
      var outside = new Uint8Array(w * h);
      for (var k = 0; k < outside.length; k++) outside[k] = m[k] ? 0 : 1;
      var d = distanceTo(outside, w, h), out = new Uint8Array(w * h);
      for (k = 0; k < out.length; k++) out[k] = d[k] > r ? 1 : 0;
      return out;
    }
    if (close > 0) mask = eaten(grown(mask, close / cell), close / cell);
    if (grow > 0) mask = grown(mask, grow / cell);
    else if (grow < 0) mask = eaten(mask, -grow / cell);
    for (i = 0; i < mask.length && !mask[i]; i++);
    if (i === mask.length) return null;
    var loop = maskOutline(mask, w, h, o.maxPoints || DETAIL_MAX_POINTS);
    if (!loop) return null;
    return loop.map(function (g) { return f.toLL({ x: x0 + g.x * cell, y: y0 + g.y * cell }); });
  }

  /* Is a lat/lng point inside a lat/lng outline. */
  function insideLatLngRing(pt, ring) {
    if (!pt || !ring || ring.length < 3) return false;
    var f = frame(pt);
    return insideRing({ x: 0, y: 0 }, ring.map(f.toXY));
  }

  /* A green's collar: the fringe round it, and a neck out to its fairway.

     ring is the collar already found round the green (its outline grown by a few metres, or
     the wand's answer from there). With a fairway point `to`, a neck runs from the collar to
     it: as wide as most of the green where it leaves, pinched to neckM where it meets the
     fairway, and a couple of metres into the fairway so the two touch. Painted together and
     lightly bridged, so the neck flows out of the collar rather than standing on it. */
  function collarOutline(green, ring, to, opts) {
    var o = opts || {};
    var rings = [ring];
    if (to) {
      var f = frame(centroid(green));
      var gxy = green.map(f.toXY), t = f.toXY(to);
      var dir = unit(t), across = perp(dir);
      /* Where the green ends towards the fairway, and how wide it is across that way. */
      var reach = 0, lo = Infinity, hi = -Infinity;
      gxy.forEach(function (p) {
        reach = Math.max(reach, p.x * dir.x + p.y * dir.y);
        var s = p.x * across.x + p.y * across.y; lo = Math.min(lo, s); hi = Math.max(hi, s);
      });
      var span = len(t);
      if (span > reach + 1) {
        var half = Math.max((o.neckM || 8) / 2, ((hi - lo) * 0.6) / 2), pinch = (o.neckM || 8) / 2;
        var from = scale(dir, reach * 0.5), end = scale(dir, span + 2);
        var neck = [add(from, scale(across, half)), add(end, scale(across, pinch)), add(end, scale(across, -pinch)), add(from, scale(across, -half))];
        rings.push(neck.map(f.toLL));
      }
    }
    return reshapeOutline(rings, { closeM: o.closeM != null ? o.closeM : 3 });
  }

  /* The outer edge of the biggest filled region on a w x h grid of 0/1 cells, as grid corners
     ({x, y} in cell units, corner (0,0) at the grid's top-left). Every cell side between filled
     and empty is an edge, walked with the filled cell on its left, so edges chain head to tail
     into closed loops; the loop of largest area is the outer edge. */
  function traceLargestLoop(filled, w, h) {
    function on(gx, gy) { return gx >= 0 && gy >= 0 && gx < w && gy < h && filled[gy * w + gx] === 1; }
    var next = {};
    function edge(ax, ay, bx, by) { var k = ax + "," + ay; (next[k] = next[k] || []).push([bx, by]); }
    for (var gy = 0; gy < h; gy++) {
      for (var gx = 0; gx < w; gx++) {
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
          loop.push({ x: Number(xy[0]), y: Number(xy[1]) });
          key = to[0] + "," + to[1];
        }
        var area = Math.abs(ringArea(loop));
        if (loop.length >= 3 && area > bestArea) { bestArea = area; best = loop; }
      }
    });
    return best;
  }

  /* ---- the line wand ----
     A line laid down the middle of a fairway, a creek or a long bunker, grown outward to the
     surface's edge. The point wand (server-side) is a bubble round one centre, so it can only
     find a roughly round shape; this grows from every pixel under the line instead, so it
     follows whatever the line runs through.

     It reads the colour UNDER the line as the surface (median, with its spread), and takes in
     every connected pixel close enough to that colour, out to `reachPx` from the line. Each
     tolerance in LINE_WAND_LEVELS is one candidate edge, weakest reach first - what left and
     right step through, exactly like the point wand's candidates. The picture is blurred first
     so mowing stripes, a sprinkler head or a pitch mark do not read as edges; a thin leak (a
     path, a run-off) is pinched off by an opening; holes inside (a tree shadow) are filled.

     Like the point wand, this is a first draft for a person to drag into shape: it trusts the
     line to be on the surface, and a fairway running into rough of the same colour will run
     out to the reach. */
  var LINE_WAND_LEVELS = [1.6, 2.2, 2.9, 3.7, 4.6, 5.8];
  /* Share of a region's edge lying on the reach limit past which it counts as leaked. */
  var LINE_WAND_LEAK_SHARE = 0.12;

  function boxBlur(src, w, h, r) {
    if (r < 1) return src;
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    var x, y, acc, n;
    for (y = 0; y < h; y++) {
      var row = y * w; acc = 0; n = 0;
      for (x = -r; x <= r; x++) if (x >= 0 && x < w) { acc += src[row + x]; n++; }
      for (x = 0; x < w; x++) {
        tmp[row + x] = acc / n;
        var add = x + r + 1, drop = x - r;
        if (add < w) { acc += src[row + add]; n++; }
        if (drop >= 0) { acc -= src[row + drop]; n--; }
      }
    }
    for (x = 0; x < w; x++) {
      acc = 0; n = 0;
      for (y = -r; y <= r; y++) if (y >= 0 && y < h) { acc += tmp[y * w + x]; n++; }
      for (y = 0; y < h; y++) {
        out[y * w + x] = acc / n;
        var addY = y + r + 1, dropY = y - r;
        if (addY < h) { acc += tmp[addY * w + x]; n++; }
        if (dropY >= 0) { acc -= tmp[dropY * w + x]; n--; }
      }
    }
    return out;
  }

  /* A binary mask grown (dilate) or shrunk (erode) by a square of radius r, via a running count. */
  function morph(mask, w, h, r, dilate) {
    if (r < 1) return mask;
    var src = new Float32Array(w * h);
    for (var i = 0; i < mask.length; i++) src[i] = mask[i];
    var avg = boxBlur(src, w, h, r);
    var out = new Uint8Array(w * h);
    for (i = 0; i < out.length; i++) out[i] = dilate ? (avg[i] > 1e-6 ? 1 : 0) : (avg[i] > 1 - 1e-6 ? 1 : 0);
    return out;
  }

  /* Pixels connected to any seed, through cells `ok` allows. */
  function connected(ok, w, h, seeds) {
    var out = new Uint8Array(w * h), queue = new Int32Array(w * h), head = 0, tail = 0;
    seeds.forEach(function (i) { if (ok[i] && !out[i]) { out[i] = 1; queue[tail++] = i; } });
    while (head < tail) {
      var i = queue[head++], x = i % w, y = (i - x) / w;
      if (x > 0 && ok[i - 1] && !out[i - 1]) { out[i - 1] = 1; queue[tail++] = i - 1; }
      if (x < w - 1 && ok[i + 1] && !out[i + 1]) { out[i + 1] = 1; queue[tail++] = i + 1; }
      if (y > 0 && ok[i - w] && !out[i - w]) { out[i - w] = 1; queue[tail++] = i - w; }
      if (y < h - 1 && ok[i + w] && !out[i + w]) { out[i + w] = 1; queue[tail++] = i + w; }
    }
    return out;
  }

  function fillHoles(mask, w, h) {
    var empty = new Uint8Array(w * h), border = [];
    for (var i = 0; i < mask.length; i++) empty[i] = mask[i] ? 0 : 1;
    for (var x = 0; x < w; x++) { border.push(x, (h - 1) * w + x); }
    for (var y = 0; y < h; y++) { border.push(y * w, y * w + w - 1); }
    var outside = connected(empty, w, h, border);
    var out = new Uint8Array(w * h);
    for (i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
    return out;
  }

  function median(values) {
    var v = values.slice().sort(function (a, b) { return a - b; });
    return v.length ? v[v.length >> 1] : 0;
  }

  function segDistSq(px, py, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    var t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
    var ex = a.x + t * dx - px, ey = a.y + t * dy - py;
    return ex * ex + ey * ey;
  }

  /* The picture as the wands read it, blurred by blurPx. Brightness counts for less than
     colour: mowing stripes and cloud shadow move brightness, and the edge of a fairway, a
     bunker, water or a tree's crown is mostly a change of colour. */
  function colourField(image, blurPx) {
    var w = image.width, h = image.height, data = image.data, n = w * h;
    var L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      L[i] = (0.299 * r + 0.587 * g + 0.114 * b) * 0.6;
      A[i] = r - g;
      B[i] = (r + g) / 2 - b;
    }
    var blur = Math.max(0, Math.round(Number(blurPx) || 0));
    return { w: w, h: h, L: boxBlur(L, w, h, blur), A: boxBlur(A, w, h, blur), B: boxBlur(B, w, h, blur) };
  }

  /* A colour as a middle and a spread per channel: median, and median absolute deviation
     floored so a perfectly flat sample (open water) still has a tolerance to scale. samples:
     {L: [], A: [], B: []}. */
  function colourModel(samples) {
    var ls = samples.L, as = samples.A, bs = samples.B;
    if (!ls || !ls.length) return null;
    var mL = median(ls), mA = median(as), mB = median(bs);
    return {
      mL: mL, mA: mA, mB: mB,
      dL: Math.max(3, 1.4826 * median(ls.map(function (v) { return Math.abs(v - mL); }))),
      dA: Math.max(3, 1.4826 * median(as.map(function (v) { return Math.abs(v - mA); }))),
      dB: Math.max(3, 1.4826 * median(bs.map(function (v) { return Math.abs(v - mB); })))
    };
  }

  function fieldSamples(field, indices) {
    var out = { L: [], A: [], B: [] };
    indices.forEach(function (i) { out.L.push(field.L[i]); out.A.push(field.A[i]); out.B.push(field.B[i]); });
    return out;
  }

  /* The colour inside a circle on a picture (pixels), as samples colourModel reads - what a tree
     placed by hand looks like, for the tree finder. */
  function circleSamples(image, centre, radiusPx, blurPx) {
    var field = colourField(image, blurPx);
    var r = Math.max(1, radiusPx), out = [];
    for (var y = Math.max(0, Math.floor(centre.y - r)); y <= Math.min(field.h - 1, Math.ceil(centre.y + r)); y++) {
      for (var x = Math.max(0, Math.floor(centre.x - r)); x <= Math.min(field.w - 1, Math.ceil(centre.x + r)); x++) {
        if (Math.hypot(x - centre.x, y - centre.y) <= r) out.push(y * field.w + x);
      }
    }
    return fieldSamples(field, out);
  }

  function spreadDistance(field, i, m) {
    var eL = (field.L[i] - m.mL) / m.dL, eA = (field.A[i] - m.mA) / m.dA, eB = (field.B[i] - m.mB) / m.dB;
    return Math.sqrt((eL * eL + eA * eA + eB * eB) / 3);
  }

  /* Distance from every cell to the nearest cell set in `mask` (0 on it), in cells: a two-pass
     chamfer, within a few percent of the true distance, which is all a reach limit or a crown
     radius needs. */
  function distanceTo(mask, w, h) {
    var n = w * h, d = new Float32Array(n), BIG = 1e9, D = Math.SQRT2, x, y, i;
    for (i = 0; i < n; i++) d[i] = mask[i] ? 0 : BIG;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (!d[i]) continue;
        var v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) {
          v = Math.min(v, d[i - w] + 1);
          if (x > 0) v = Math.min(v, d[i - w - 1] + D);
          if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
        }
        d[i] = v;
      }
    }
    for (y = h - 1; y >= 0; y--) {
      for (x = w - 1; x >= 0; x--) {
        i = y * w + x;
        if (!d[i]) continue;
        var u = d[i];
        if (x < w - 1) u = Math.min(u, d[i + 1] + 1);
        if (y < h - 1) {
          u = Math.min(u, d[i + w] + 1);
          if (x < w - 1) u = Math.min(u, d[i + w + 1] + D);
          if (x > 0) u = Math.min(u, d[i + w - 1] + D);
        }
        d[i] = u;
      }
    }
    return d;
  }

  /* The grow both wands share: every pixel connected to the seeds whose colour is close enough
     to the model, no further than `reach` from the seed shape (near[i]: distance to it,
     Infinity past the reach). Each level is one candidate edge, weakest reach first. `force`
     (optional) is a mask always kept - the drawn shape of a waste area. */
  function growRegion(field, seeds, model, near, reach, force, o) {
    var w = field.w, h = field.h, n = w * h, i, j;
    var dist = new Float32Array(n);
    dist.fill(Infinity);
    for (i = 0; i < n; i++) if (near[i] <= reach) dist[i] = spreadDistance(field, i, model);
    var open = Math.max(0, Math.round(Number(o.openPx) || 0));
    var minArea = Math.max(16, Number(o.minAreaPx) || 0);
    var levels = Array.isArray(o.levels) && o.levels.length ? o.levels : LINE_WAND_LEVELS;
    var leakShare = Number.isFinite(Number(o.leakShare)) && o.leakShare != null ? Number(o.leakShare) : LINE_WAND_LEAK_SHARE;
    var rings = [];
    levels.forEach(function (level) {
      var ok = new Uint8Array(n);
      for (j = 0; j < n; j++) ok[j] = dist[j] <= level || (force && force[j]) ? 1 : 0;
      var mask = connected(ok, w, h, seeds);
      if (open) {
        var opened = morph(morph(mask, w, h, open, false), w, h, open, true);
        for (j = 0; j < n; j++) opened[j] = opened[j] && mask[j] ? 1 : 0;
        if (force) for (j = 0; j < n; j++) if (force[j]) opened[j] = 1;
        var kept = connected(opened, w, h, seeds);
        var any = false;
        for (j = 0; j < n && !any; j++) if (kept[j]) any = true;
        if (any) mask = kept;
      }
      mask = fillHoles(mask, w, h);
      var area = 0, edge = 0, atReach = 0;
      for (j = 0; j < n; j++) {
        if (!mask[j]) continue;
        area++;
        var ex = j % w;
        if ((ex > 0 && !mask[j - 1]) || (ex < w - 1 && !mask[j + 1]) || (j >= w && !mask[j - w]) || (j < n - w && !mask[j + w])) {
          edge++;
          if (near[j] >= reach - 2) atReach++;
        }
      }
      if (area < minArea) { rings.push(null); return; }
      var loop = traceLargestLoop(mask, w, h);
      if (!loop) { rings.push(null); return; }
      var tol = 0.75, ring = simplifyRing(loop, tol);
      var cap = Number(o.maxPoints) || DETAIL_MAX_POINTS;
      while (ring.length > cap) { tol *= 1.5; ring = simplifyRing(loop, tol); }
      /* Leaked: a good share of its edge is the reach limit, not anything in the picture. */
      rings.push(ring.length >= 3 ? { ring: ring, area: area, leaked: edge > 0 && atReach / edge > leakShare } : null);
    });

    /* Same choice the point wand makes: the step whose edge moved least from the one before
       is the edge the picture actually has. Neighbouring steps on the same edge are one. */
    /* A leaked level is never the pick - its area stops changing because the reach stopped it,
       which would otherwise read as the most stable edge of all. It stays a candidate, last in
       line, for a person who wants it. */
    var best = null, bestSpread = Infinity, k;
    for (k = 1; k < rings.length; k++) {
      if (!rings[k - 1] || !rings[k] || rings[k].leaked) continue;
      var spread = Math.abs(Math.log(rings[k].area / rings[k - 1].area));
      if (spread < bestSpread - 1e-9) { bestSpread = spread; best = rings[k]; }
    }
    var candidates = [];
    rings.forEach(function (r) {
      if (!r) return;
      var last = candidates[candidates.length - 1];
      if (last && Math.abs(Math.log(r.area / last.area)) < 0.06) { if (r === best) candidates[candidates.length - 1] = r; return; }
      candidates.push(r);
    });
    if (!candidates.length) return { candidates: [], reason: "no-edge" };
    if (!best || candidates.indexOf(best) < 0) {
      var tight = candidates.filter(function (r) { return !r.leaked; });
      best = tight.length ? tight[tight.length - 1] : candidates[0];
    }
    return {
      candidates: candidates.map(function (r) { return r.ring; }),
      areas: candidates.map(function (r) { return r.area; }),
      pick: candidates.indexOf(best),
      stable: bestSpread <= 0.25
    };
  }

  /* image: {width, height, data} RGBA (an ImageData, or anything shaped like one). line: 2+
     points in that image's pixels. opts: reachPx (how far from the line an edge may be),
     blurPx (smoothing radius), openPx (the narrowest neck kept), minAreaPx. Returns
     {candidates: [ring in pixels], areas, pick} or {candidates: [], reason}. */
  function growFromLine(image, line, opts) {
    var o = opts || {};
    var w = image && image.width, h = image && image.height, data = image && image.data;
    if (!w || !h || !data || !Array.isArray(line) || line.length < 2) return { candidates: [], reason: "no-line" };
    var reach = Math.max(4, Number(o.reachPx) || 60), reachSq = reach * reach;
    var field = colourField(image, o.blurPx);

    /* The line, rasterised a pixel at a time, is both the seed and the colour sample. */
    var seeds = [], seen = {};
    for (var k = 1; k < line.length; k++) {
      var a0 = line[k - 1], a1 = line[k];
      var steps = Math.max(1, Math.ceil(Math.hypot(a1.x - a0.x, a1.y - a0.y)));
      for (var st = 0; st <= steps; st++) {
        var sx = Math.round(a0.x + (a1.x - a0.x) * st / steps), sy = Math.round(a0.y + (a1.y - a0.y) * st / steps);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        var si = sy * w + sx;
        if (!seen[si]) { seen[si] = 1; seeds.push(si); }
      }
    }
    if (seeds.length < 2) return { candidates: [], reason: "line-off-picture" };

    /* Distance to the line, so a region that ran all the way out to the reach can be told
       apart from one that stopped at a real edge. */
    var near = new Float32Array(w * h);
    near.fill(Infinity);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    line.forEach(function (p) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    var bx0 = Math.max(0, Math.floor(minX - reach)), by0 = Math.max(0, Math.floor(minY - reach));
    var bx1 = Math.min(w - 1, Math.ceil(maxX + reach)), by1 = Math.min(h - 1, Math.ceil(maxY + reach));
    for (var y = by0; y <= by1; y++) {
      for (var x = bx0; x <= bx1; x++) {
        var nearest = Infinity;
        for (k = 1; k < line.length; k++) nearest = Math.min(nearest, segDistSq(x, y, line[k - 1], line[k]));
        if (nearest <= reachSq) near[y * w + x] = Math.sqrt(nearest);
      }
    }
    return growRegion(field, seeds, colourModel(fieldSamples(field, seeds)), near, reach, null, o);
  }

  /* ---- the area wand ----
     A rough shape drawn round a waste area, pushed outward to fill the gaps the hand left: the
     colour INSIDE the drawn shape is the surface, and every connected pixel close enough to it,
     out to `reachPx` beyond the drawn edge, joins. The drawn shape itself is always kept, so
     the answer only ever grows from what was drawn. Same options and answer as growFromLine. */
  function growFromArea(image, ring, opts) {
    var o = opts || {};
    var w = image && image.width, h = image && image.height, data = image && image.data;
    if (!w || !h || !data || !Array.isArray(ring) || ring.length < 3) return { candidates: [], reason: "no-area" };
    var reach = Math.max(4, Number(o.reachPx) || 40);
    var field = colourField(image, o.blurPx);
    var inside = new Uint8Array(w * h), seeds = [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ring.forEach(function (p) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    for (var y = Math.max(0, Math.floor(minY)); y <= Math.min(h - 1, Math.ceil(maxY)); y++) {
      for (var x = Math.max(0, Math.floor(minX)); x <= Math.min(w - 1, Math.ceil(maxX)); x++) {
        if (insideRing({ x: x + 0.5, y: y + 0.5 }, ring)) { inside[y * w + x] = 1; seeds.push(y * w + x); }
      }
    }
    if (seeds.length < 4) return { candidates: [], reason: "area-off-picture" };
    var near = distanceTo(inside, w, h);
    for (var i = 0; i < near.length; i++) if (near[i] > reach) near[i] = Infinity;
    return growRegion(field, seeds, colourModel(fieldSamples(field, seeds)), near, reach, inside, o);
  }

  /* ---- the tree finder ----
     Something says what a tree looks like here - trees placed by hand this session (their
     crowns' colour, colourModel over circleSamples, and their size, radiusPx), or the ground
     round the fairways (autoTreeModel, below). Every pixel that colour is a "crown" pixel; the
     crown pixels furthest from anything else are the middles of trees. A lone tree is one round
     blob with its middle at its centre; a row of trees is a ridge, and the middles are spaced
     along it a crown apart. It looks inside a box, or only at the pixels `inside` (a 0/1 mask
     the size of the picture) allows. Already-placed trees (`avoid`, {x, y, r}) are left alone.
     Returns {find(level) -> [{x, y, r}]}: the picture is read once and each sensitivity level
     is cheap, so left and right answer at once. */
  var TREE_FINDER_LEVELS = [1.3, 1.7, 2.1, 2.6, 3.2, 4];
  var TREE_FINDER_MAX = 150;

  /* The smallest box holding every pixel set in a 0/1 mask, or null when none is. */
  function maskBox(mask, w, h) {
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1 };
  }

  /* The middles of the crowns in a 0/1 crown mask: opened so specks and thin lines go, then
     the deepest points, deepest first, kept where they do not overlap one already kept or a
     tree in `avoid`. radius: a crown's usual radius in pixels; each tree's own radius is its
     depth, held to 0.5-2.2 x that. */
  function crownCentres(crown, w, h, radius, avoid, max) {
    var n = w * h, j, open = Math.max(1, Math.round(radius * 0.25)), minR = radius * 0.4;
    crown = morph(morph(crown, w, h, open, false), w, h, open, true);
    var empty = new Uint8Array(n);
    for (j = 0; j < n; j++) empty[j] = crown[j] ? 0 : 1;
    var depth = distanceTo(empty, w, h);
    /* Candidate middles: deep enough to be a crown, and the deepest of their neighbours. */
    var peaks = [];
    for (var yy = 1; yy < h - 1; yy++) {
      for (var xx = 1; xx < w - 1; xx++) {
        j = yy * w + xx;
        var d = depth[j];
        if (d < minR) continue;
        if (d < depth[j - 1] || d < depth[j + 1] || d < depth[j - w] || d < depth[j + w] ||
            d < depth[j - w - 1] || d < depth[j - w + 1] || d < depth[j + w - 1] || d < depth[j + w + 1]) continue;
        peaks.push({ x: xx, y: yy, d: d });
      }
    }
    peaks.sort(function (a, b) { return b.d - a.d; });
    var kept = [];
    for (var p = 0; p < peaks.length && kept.length < max; p++) {
      var c = peaks[p];
      var r = Math.max(radius * 0.5, Math.min(radius * 2.2, c.d));
      var clash = kept.some(function (k) { return Math.hypot(k.x - c.x, k.y - c.y) < (k.r + r) * 0.75; }) ||
        (avoid || []).some(function (a) { return Math.hypot(a.x - c.x, a.y - c.y) < a.r + r * 0.5; });
      if (!clash) kept.push({ x: c.x + 0.5, y: c.y + 0.5, r: r });
    }
    return kept;
  }

  function treeFinder(image, model, opts) {
    var o = opts || {};
    var radius = Math.max(2, Number(o.radiusPx) || 10);
    /* insideAt(level index): a mask a sensitivity at a time (autoTreeModel's allowAt) - the
       loosest holds every other, so it sets the box. */
    var W = image.width, insideAt = o.insideAt || null, inside = insideAt ? insideAt(TREE_FINDER_LEVELS.length - 1) : o.inside || null;
    var box = o.box || (inside ? maskBox(inside, W, image.height) : { x0: 0, y0: 0, x1: W, y1: image.height });
    if (!box) return { find: function () { return []; } };
    var x0 = Math.max(0, Math.floor(Math.min(box.x0, box.x1))), y0 = Math.max(0, Math.floor(Math.min(box.y0, box.y1)));
    var x1 = Math.min(W, Math.ceil(Math.max(box.x0, box.x1))), y1 = Math.min(image.height, Math.ceil(Math.max(box.y0, box.y1)));
    var w = x1 - x0, h = y1 - y0;
    if (!model || w < 3 || h < 3) return { find: function () { return []; } };
    /* Just the box, so a big picture costs no more than the box drawn on it. */
    var crop = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) crop.set(image.data.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x1) * 4), y * w * 4);
    var field = colourField({ width: w, height: h, data: crop }, Math.max(1, Math.round(radius * 0.15)));
    /* How far each pixel is from the crown colour, held to a twentieth of a spread in one
       byte (255: too far for any level) - a course's worth of runs stays live for left and
       right, and four bytes a pixel each would not. */
    var n = w * h, dist = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      dist[i] = inside && !inside[(Math.floor(i / w) + y0) * W + (i % w) + x0] ? 255 : Math.min(255, Math.round(spreadDistance(field, i, model) * 20));
    }
    var avoid = (o.avoid || []).map(function (a) { return { x: a.x - x0, y: a.y - y0, r: a.r }; });
    var max = Math.max(1, Number(o.max) || TREE_FINDER_MAX);

    function find(level) {
      var crown = new Uint8Array(n);
      var cut = Math.min(254, Math.round(level * 20));
      var at = insideAt ? insideAt(nearestLevel(level)) : null;
      for (var j = 0; j < n; j++) crown[j] = dist[j] <= cut && (!at || at[(Math.floor(j / w) + y0) * W + (j % w) + x0]) ? 1 : 0;
      return crownCentres(crown, w, h, radius, avoid, max).map(function (k) { return { x: k.x + x0, y: k.y + y0, r: k.r }; });
    }
    return { find: find };
  }

  /* A finder's trees at every sensitivity at once, each tagged with the strictest level that
     finds it (l, an index into levels): strictest first, and a looser level only adds the trees
     that do not overlap one already found. So the trees at a level are exactly those with
     l <= level - a nested set More and Less step through with nothing read again, which is
     what lets a run be stored and still be made more or less of later. */
  function nestedTrees(finder, levels) {
    var out = [];
    (levels || TREE_FINDER_LEVELS).forEach(function (level, l) {
      finder.find(level).forEach(function (t) {
        var clash = out.some(function (k) { return Math.hypot(k.x - t.x, k.y - t.y) < (k.r + t.r) * 0.75; });
        if (!clash) out.push({ x: t.x, y: t.y, r: t.r, l: l });
      });
    });
    return out;
  }

  /* The index in TREE_FINDER_LEVELS nearest a level. */
  function nearestLevel(level) {
    var best = 0;
    TREE_FINDER_LEVELS.forEach(function (v, k) { if (Math.abs(v - level) < Math.abs(TREE_FINDER_LEVELS[best] - level)) best = k; });
    return best;
  }

  /* The middles of the crowns in a 0/1 mask the size of a picture - trees found from their
     height alone, with no colour to go on. Same answer as one find of the tree finder. */
  function treesInMask(mask, w, h, opts) {
    var o = opts || {};
    return crownCentres(mask, w, h, Math.max(2, Number(o.radiusPx) || 10), o.avoid || [], Math.max(1, Number(o.max) || TREE_FINDER_MAX));
  }

  /* ---- trees near play ----
     The tree finder with nobody placing sample trees or dragging a box. Where to look is the
     ground along the edge of what is played (playBand): out to TREE_BAND_M from a fairway or
     green, and no closer than TREE_CLEAR_M to anything on the course. What a tree looks like is
     worked out from the one thing we do know - the turf inside the fairways and greens
     (autoTreeModel). Inside the band a pixel is a crown when it is
       - darker than the turf by a margin (crowns are well darker than mown grass),
       - still green: green over red and yellow over blue, which is what drops tree shadows
         (dark, but grey or blue) and bare ground,
       - textured: the brightness varies more across a few metres than it does on turf, which
         is what drops dark smooth rough and mown lines,
     and, when tree heights are to hand, stands TREE_MIN_HEIGHT_M or more (heightMask). The
     crown pixels that pass become the colour model, and from there it is the tree finder as it
     is for a box. */
  var TREE_BAND_M = 40;
  var TREE_CLEAR_M = 3;
  var TREE_AUTO_RADIUS_M = 4.5;
  var TREE_MIN_HEIGHT_M = 3;
  /* How much darker than turf a crown is, at least (the field's brightness units, 0-153), and
     how far into the green half a pixel's colour must be to count as green. */
  var TREE_DARK_MARGIN = 10;
  var TREE_GREEN_MIN = 3;
  /* A crown's texture (autoTreeModel): a pixel is busy past this many times turf's own detail
     (and never under the floor), and a crown is busy over at least this share of it. */
  var TREE_DETAIL_FLOOR = 1.5;
  var TREE_DETAIL_OVER_TURF = 2;
  /* What each sensitivity (TREE_FINDER_LEVELS, strictest first) asks of a crown found with no
     samples: darker than turf by this many times the margin, and busy over this share of it.
     The middle one (TREE_DEFAULT_STEP) is what the finder asks by default. */
  var TREE_STEP_DARK = [1.6, 1.3, 1, 0.8, 0.6, 0.45];
  var TREE_STEP_BUSY = [0.62, 0.53, 0.45, 0.38, 0.31, 0.25];
  var TREE_DEFAULT_STEP = 2;
  /* The colour model reads at most this many pixels of turf and of crown, evenly spread. */
  var TREE_SAMPLE_PIXELS = 20000;

  /* 0/1 mask, the size of a picture, of the pixels inside any of `rings` (pixel {x, y}). */
  function ringsMask(w, h, rings) {
    var mask = new Uint8Array(w * h);
    (rings || []).forEach(function (r) { if (r && r.length >= 3) paintRing(mask, w, h, r, 0, 0, 1); });
    return mask;
  }

  /* Where to look for trees near a played shape, as a 0/1 mask the size of the picture: within
     bandPx of `play` (pixel rings - the fairway or green looked along) or of `lines` (pixel
     polylines - a play line, for the hazard finder), further than clearPx
     from every surface on the course (`surfaces`, pixel rings; the played shape counts as one),
     and not inside a wood already drawn (`woods`). */
  function playBand(w, h, opts) {
    var o = opts || {}, n = w * h;
    var play = ringsMask(w, h, o.play), surf = ringsMask(w, h, (o.surfaces || []).concat(o.play || [])), wood = ringsMask(w, h, o.woods);
    /* A play line looked along (the hazard finder) is where to look, not a surface. */
    (o.lines || []).forEach(function (line) { if (line && line.length >= 2) paintLine(play, w, h, line); });
    var dPlay = distanceTo(play, w, h), dSurf = distanceTo(surf, w, h);
    var bandPx = Number(o.bandPx) || 0, clearPx = Number(o.clearPx) || 0;
    var band = new Uint8Array(n);
    for (var i = 0; i < n; i++) band[i] = dPlay[i] <= bandPx && dSurf[i] > clearPx && !wood[i] ? 1 : 0;
    return band;
  }

  function maskIndices(mask, cap) {
    var all = [];
    for (var i = 0; i < mask.length; i++) if (mask[i]) all.push(i);
    if (all.length <= cap) return all;
    var step = all.length / cap, out = [];
    for (var k = 0; k < cap; k++) out.push(all[Math.floor(k * step)]);
    return out;
  }

  /* What a tree looks like in this picture, learnt from its turf. turf: 0/1 mask of the
     fairways' and greens' pixels; band: where to look (playBand). opts.radiusPx: a crown's
     radius in pixels; opts.tall: 0/1 mask of pixels at least TREE_MIN_HEIGHT_M tall, or none.
     Returns {model, allow} for treeFinder (model: the crowns' colour; allow: the pixels that
     pass, its `inside`), or {model: null, reason} when there is no turf to read or no crown
     in the band. */
  function autoTreeModel(image, turf, band, opts) {
    var o = opts || {}, w = image.width, h = image.height, n = w * h, i;
    var radius = Math.max(2, Number(o.radiusPx) || 10);
    /* The turf's own edge is half rough, half shadow: only its inside is read. */
    var core = morph(turf, w, h, Math.max(1, Math.round(radius * 0.3)), false);
    var turfAt = maskIndices(core, TREE_SAMPLE_PIXELS);
    if (turfAt.length < 20) return { model: null, reason: "no-turf" };
    var field = colourField(image, Math.max(1, Math.round(radius * 0.15)));
    var turfModel = colourModel(fieldSamples(field, turfAt));
    /* Texture: how much of the ground round a pixel - about half a crown - is busy, a busy
       pixel being one whose brightness stands off its close neighbours' by more than turf's
       ever does. Leaves and the shade between them make a crown busy all over; the edge of a
       dark patch against the rough is busy along one line, a thin share of any window, so a
       smooth dark patch does not read as textured for having an edge - even once a resized
       frame has smeared that edge over a few pixels. */
    var L = colourField(image, 0).L, near = boxBlur(L, w, h, 1), detail = new Float32Array(n);
    for (i = 0; i < n; i++) detail[i] = Math.abs(L[i] - near[i]);
    var busyOver = Math.max(TREE_DETAIL_FLOOR, TREE_DETAIL_OVER_TURF * median(turfAt.map(function (k) { return detail[k]; })));
    var busy = new Float32Array(n);
    for (i = 0; i < n; i++) busy[i] = detail[i] > busyOver ? 1 : 0;
    var tex = boxBlur(busy, w, h, Math.max(2, Math.round(radius * 0.4)));
    /* How much darker than turf each pixel is, and whether it is green at all: the darkness
       and texture asked of a crown move with the sensitivity (TREE_STEP_DARK, TREE_STEP_BUSY),
       greenness does not - a shadow is never a tree. */
    var margin = Math.max(TREE_DARK_MARGIN, turfModel.dL), gap = new Float32Array(n), green = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      gap[i] = turfModel.mL - field.L[i];
      var a = field.A[i], b = field.B[i];
      green[i] = band[i] && (!o.tall || o.tall[i]) && a < -TREE_GREEN_MIN && b > -a * 0.25 ? 1 : 0;
    }
    var shut = Math.max(1, Math.round(radius * 0.15)), masks = [];
    /* The crown pixels at a sensitivity (an index into TREE_FINDER_LEVELS): stricter asks for
       darker and busier ground, looser for less. Each is closed over the pinholes a crown's
       own bright leaves leave, without reaching out past the band. */
    function allowAt(level) {
      var k = Math.max(0, Math.min(TREE_STEP_DARK.length - 1, level | 0));
      if (masks[k]) return masks[k];
      var dark = margin * TREE_STEP_DARK[k], share = TREE_STEP_BUSY[k], m = new Uint8Array(n);
      for (var j = 0; j < n; j++) m[j] = green[j] && gap[j] > dark && tex[j] >= share ? 1 : 0;
      m = morph(morph(m, w, h, shut, true), w, h, shut, false);
      for (j = 0; j < n; j++) if (!band[j] || (o.tall && !o.tall[j])) m[j] = 0;
      return (masks[k] = m);
    }
    /* What a crown looks like here, from the crowns at the middle sensitivity - or, on ground
       where those are too few to say, from the loosest. */
    var enough = Math.PI * radius * radius * 0.25, crownAt = null;
    [TREE_DEFAULT_STEP, TREE_STEP_DARK.length - 1].some(function (k) { crownAt = maskIndices(allowAt(k), TREE_SAMPLE_PIXELS); return crownAt.length >= enough; });
    if (crownAt.length < enough) return { model: null, reason: "no-crowns", allow: allowAt(TREE_DEFAULT_STEP) };
    return { model: colourModel(fieldSamples(field, crownAt)), allow: allowAt(TREE_DEFAULT_STEP), allowAt: allowAt };
  }

  /* ---- bunkers, water and crossings along play ----
     The hazard finder: walks a hole's play line (tee to green) with nothing placed first, and
     finds inside a corridor along it
       - bunkers: ground much brighter than the turf, not green, warm (yellow over blue - what
         tells sand from a grey path), smooth, a bunker's size;
       - water: ground well darker than the turf, not green or bluer than it is yellow, the
         smoothest thing on the picture, and not under anything tall when heights are to hand;
       - crossings: a stretch of the line that is not turf, grown sideways with the line wand's
         engine, read against the hole's fairway shapes (crossingCase): right through one it is
         a hazard unless it looks like a path; in a split between two it is a hazard when its
         ground is rougher than the course's own rough; partial, it is a hazard only with a hint
         of water in it. A path is nothing.
     Turf is the reference: the fairways and greens on the picture, or failing those the strip
     under the line itself. Returns {find(level) -> {bunkers, water, hazards}} (pixel rings),
     the picture read once; find is cheap enough to run for every level up front. */
  var HAZARD_CORRIDOR_M = 45;
  var HAZARD_CLEAR_M = 3;
  /* How much brighter than turf sand is, at least, and how far into the warm half its colour
     must sit; how much darker than turf water is, at least (the field's brightness units). */
  var SAND_BRIGHT_MARGIN = 15;
  var SAND_WARM_MIN = 4;
  var WATER_DARK_MARGIN = 12;
  /* A bunker's believable size (the wand's own band) and the thinnest a bunker is anywhere;
     the smallest water worth a shape. */
  var BUNKER_AREA_M2 = { min: 8, max: 1200 };
  var BUNKER_MIN_DEPTH_M = 1.5;
  var WATER_MIN_AREA_M2 = 60;
  /* A crossing: a run along the line this long, read this far either side of it, grown out
     this far; and the line's first and last metres, which are tee and green, not crossings. */
  var CROSSING_MIN_M = 3;
  var CROSSING_MAX_M = 80;
  var CROSSING_HALF_M = 4;
  var CROSSING_REACH_M = 60;
  var CROSSING_SKIP_TEE_M = 15;
  var CROSSING_SKIP_GREEN_M = 20;
  /* A split between two fairways is a hazard when it is this many times rougher than the
     rough; a partial crossing when this share of it reads as water; a path is no deeper than
     this anywhere and at least this many times longer than it is wide. */
  var GAP_TEXTURE_OVER_ROUGH = 1.8;
  var PARTIAL_WATER_SHARE = 0.15;
  var PATH_MAX_DEPTH_M = 2.5;
  var PATH_MIN_ELONGATION = 6;
  /* Sensitivity, strictest first: what each level multiplies the margins by (a stricter level
     asks sand to be brighter and water darker) and the turf tolerance a crossing must exceed.
     HAZARD_FINDER_LEVELS indexes them; the middle is the default. */
  var HAZARD_STEP_MARGIN = [1.6, 1.3, 1, 0.8, 0.6, 0.45];
  var HAZARD_STEP_TURF = [3.4, 2.9, 2.5, 2.1, 1.8, 1.5];
  var HAZARD_FINDER_LEVELS = [0, 1, 2, 3, 4, 5];
  var HAZARD_DEFAULT_STEP = 2;
  var HAZARD_FINDER_MAX = 60;
  var HAZARD_SAMPLE_PIXELS = 20000;

  /* Paint a polyline (pixel {x, y}) into a 0/1 mask, one pixel wide. */
  function paintLine(mask, w, h, line) {
    for (var k = 1; k < line.length; k++) {
      var a = line[k - 1], b = line[k], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
      for (var s = 0; s <= steps; s++) {
        var x = Math.round(a.x + (b.x - a.x) * s / steps), y = Math.round(a.y + (b.y - a.y) * s / steps);
        if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
      }
    }
  }

  /* A polyline as a 0/1 mask the size of a picture, widthPx wide. */
  function lineMask(w, h, line, widthPx) {
    var mask = new Uint8Array(w * h);
    if (Array.isArray(line) && line.length >= 2) paintLine(mask, w, h, line);
    var r = Math.round((Number(widthPx) || 1) / 2);
    return r >= 1 ? morph(mask, w, h, r, true) : mask;
  }

  /* The polyline walked a pixel at a time: its points, each with how far along (px) it is. */
  function walkLine(line, w, h) {
    var out = [], along = 0;
    for (var k = 1; k < line.length; k++) {
      var a = line[k - 1], b = line[k], d = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.max(1, Math.ceil(d));
      for (var s = k === 1 ? 0 : 1; s <= steps; s++) {
        var t = s / steps;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: along + d * t, ux: d > 1e-9 ? (b.x - a.x) / d : 0, uy: d > 1e-9 ? (b.y - a.y) / d : 1 });
      }
      along += d;
    }
    return out;
  }

  /* How busy the ground is round each pixel: a pixel's brightness against its close
     neighbours', averaged over a window winPx either way. Flat turf, sand and water score
     low; rocks, scrub and a creek bed high. */
  function textureField(image, winPx) {
    var w = image.width, h = image.height, n = w * h;
    var L = colourField(image, 0).L, near = boxBlur(L, w, h, 1), detail = new Float32Array(n);
    for (var i = 0; i < n; i++) detail[i] = Math.abs(L[i] - near[i]);
    return boxBlur(detail, w, h, Math.max(1, Math.round(winPx)));
  }

  /* The connected blobs of a 0/1 mask: [{at: [indices], area, depth, box}], biggest first.
     depth: the deepest the blob goes from its edge (px), read off one distance transform of
     the whole mask. Blobs under minAreaPx are dropped. */
  function blobs(mask, w, h, opts) {
    var o = opts || {}, n = w * h, label = new Int32Array(n), queue = new Int32Array(n), out = [];
    var empty = new Uint8Array(n);
    for (var i = 0; i < n; i++) empty[i] = mask[i] ? 0 : 1;
    var depth = distanceTo(empty, w, h), minArea = Number(o.minAreaPx) || 1, id = 0;
    for (i = 0; i < n; i++) {
      if (!mask[i] || label[i]) continue;
      id++;
      var head = 0, tail = 0, at = [], deep = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      label[i] = id; queue[tail++] = i;
      while (head < tail) {
        var j = queue[head++], x = j % w, y = (j - x) / w;
        at.push(j);
        if (depth[j] > deep) deep = depth[j];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[j - 1] && !label[j - 1]) { label[j - 1] = id; queue[tail++] = j - 1; }
        if (x < w - 1 && mask[j + 1] && !label[j + 1]) { label[j + 1] = id; queue[tail++] = j + 1; }
        if (y > 0 && mask[j - w] && !label[j - w]) { label[j - w] = id; queue[tail++] = j - w; }
        if (y < h - 1 && mask[j + w] && !label[j + w]) { label[j + w] = id; queue[tail++] = j + w; }
      }
      if (at.length >= minArea) out.push({ at: at, area: at.length, depth: deep, box: { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1 } });
    }
    out.sort(function (a, b) { return b.area - a.area; });
    return out;
  }

  function blobMask(blob, n) {
    var m = new Uint8Array(n);
    blob.at.forEach(function (i) { m[i] = 1; });
    return m;
  }

  /* How many separate pieces a 0/1 mask is in, counting only pieces of at least minPx. */
  function pieces(mask, w, h, minPx) {
    return blobs(mask, w, h, { minAreaPx: minPx }).length;
  }

  /* How a crossing sits against a hole's fairway shapes. run: the walked points of the line
     along it; grown: the crossing's 0/1 mask; fairways: [0/1 mask] one per fairway shape;
     fairwayOnLine(s): whether the line is on a fairway shape at distance s along it.
       through - the run is on a fairway shape and the crossing cuts that shape in two;
       gap     - the run is off every fairway shape, with fairway on the line before and after
                 it within CROSSING_MAX;
       partial - anything else. */
  function crossingCase(run, grown, fairways, fairwayOnLine, w, h, maxPx) {
    var n = w * h, inside = 0, which = {};
    run.forEach(function (p) {
      var i = Math.round(p.y) * w + Math.round(p.x);
      fairways.forEach(function (f, k) { if (f[i]) { inside++; which[k] = (which[k] || 0) + 1; } });
    });
    if (inside > run.length * 0.5) {
      var best = Object.keys(which).sort(function (a, b) { return which[b] - which[a]; })[0], f = fairways[best];
      var cut = new Uint8Array(n), area = 0;
      for (var i = 0; i < n; i++) { if (f[i]) area++; cut[i] = f[i] && !grown[i] ? 1 : 0; }
      return pieces(cut, w, h, Math.max(50, area * 0.03)) >= 2 ? "through" : "partial";
    }
    var s0 = run[0].s, s1 = run[run.length - 1].s, before = false, after = false;
    for (var d = 1; d <= maxPx && !(before && after); d++) {
      if (!before && fairwayOnLine(s0 - d)) before = true;
      if (!after && fairwayOnLine(s1 + d)) after = true;
    }
    return before && after ? "gap" : "partial";
  }

  /* Whether a grown crossing looks like a path: brighter than turf, grey, of one colour,
     thin everywhere and long. */
  function pathLike(field, blob, turf, mpp) {
    var model = colourModel(fieldSamples(field, maskIndices(blobMask(blob, field.w * field.h), HAZARD_SAMPLE_PIXELS)));
    if (!model) return false;
    var width = Math.max(1, blob.depth * 2), length = blob.area / width;
    return model.mL > turf.mL + 5 && Math.abs(model.mA) < 6 && model.mB < SAND_WARM_MIN + 2 && model.dL < 8 &&
      blob.depth * mpp < PATH_MAX_DEPTH_M && length / width >= PATH_MIN_ELONGATION;
  }

  /* opts: corridor (0/1 mask: where to look - playBand along the line, clear of the bunkers,
     water, hazards, waste and woods already drawn, but NOT of the fairways: a crossing drawn
     over is still a crossing, and sand inside a fairway shape is still sand), turf (0/1 mask of
     the fairways and greens on the picture; may be empty), line ([{x, y}] the play line in pixels),
     fairways ([pixel ring] this hole's fairway shapes), rough (0/1 mask of ground to read the
     course's rough from - the corridor clear of every surface and wood), tall (0/1 mask of
     pixels under something ≥ TREE_MIN_HEIGHT_M, or null), mpp (metres a pixel), max (shapes
     of a kind a run may return). */
  function hazardFinder(image, opts) {
    var o = opts || {}, w = image.width, h = image.height, n = w * h, i;
    var mpp = Number(o.mpp) || 0.4, line = o.line || [], corridor = o.corridor, tall = o.tall || null;
    function none(reason) { return { reason: reason, find: function () { return { bunkers: [], water: [], hazards: [] }; } }; }
    if (!corridor || line.length < 2) return none("no-line");
    var field = colourField(image, 1);
    /* Texture read tight (a pixel against its 3x3), so a shape's own edge is busy only a pixel
       or two in and the close below bridges it; a blob's roughness is the median over it. */
    var tex = textureField(image, 1);
    var walked = walkLine(line, w, h), total = walked.length ? walked[walked.length - 1].s : 0;

    /* Turf: the fairways and greens, their edge trimmed; or, with none here, the strip under
       the line between tee and green. */
    var turfAt = [], turfFrom = "shapes";
    if (o.turf) turfAt = maskIndices(morph(o.turf, w, h, Math.max(1, Math.round(1 / mpp)), false), HAZARD_SAMPLE_PIXELS);
    if (turfAt.length < 200) {
      turfFrom = "line";
      var strip = lineMask(w, h, line, 12 / mpp), ends = new Uint8Array(n);
      var endA = CROSSING_SKIP_TEE_M / mpp, endB = total - CROSSING_SKIP_GREEN_M / mpp;
      walked.forEach(function (p) { if ((p.s < endA || p.s > endB) && p.x >= 0 && p.y >= 0 && p.x < w && p.y < h) ends[Math.round(p.y) * w + Math.round(p.x)] = 1; });
      var farFromEnds = distanceTo(ends, w, h);
      for (i = 0; i < n; i++) if (strip[i] && farFromEnds[i] <= 8 / mpp) strip[i] = 0;
      turfAt = maskIndices(strip, HAZARD_SAMPLE_PIXELS);
    }
    if (turfAt.length < 200) return none("no-turf");
    var turf = colourModel(fieldSamples(field, turfAt));
    var turfTex = median(turfAt.map(function (k) { return tex[k]; }));
    /* The course's rough, for the split-fairway test: its texture. With none to read, the
       turf's own, which only makes the test stricter. */
    var roughAt = o.rough ? maskIndices(o.rough, HAZARD_SAMPLE_PIXELS) : [];
    var roughTex = roughAt.length >= 200 ? median(roughAt.map(function (k) { return tex[k]; })) : turfTex;
    var smoothTop = Math.max(1, turfTex * 2);

    /* Per pixel, once: how far above and below turf's brightness, and whether it is warm /
       not green / smooth - so each level is a threshold pass. */
    var over = new Float32Array(n), under = new Float32Array(n), sandy = new Uint8Array(n), wet = new Uint8Array(n), watery = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      over[i] = field.L[i] - turf.mL;
      under[i] = turf.mL - field.L[i];
      var a = field.A[i], b = field.B[i], smooth = tex[i] <= smoothTop;
      sandy[i] = corridor[i] && smooth && a >= -2 && b > SAND_WARM_MIN ? 1 : 0;
      /* Water's colour - blue over yellow, or grey: not green, not the brown of bare ground -
         (wet - the hint a partial crossing is read for) and water proper: that colour, flat,
         and not under a tree. */
      wet[i] = corridor[i] && (b < 0 || (Math.abs(a) < 6 && b < 8)) ? 1 : 0;
      watery[i] = wet[i] && smooth && (!tall || !tall[i]) ? 1 : 0;
    }
    var fairways = (o.fairways || []).map(function (r) { return ringsMask(w, h, [r]); });
    var onFairway = new Uint8Array(walked.length);
    walked.forEach(function (p, k) {
      var j = Math.round(p.y) * w + Math.round(p.x);
      onFairway[k] = p.x >= 0 && p.y >= 0 && p.x < w && p.y < h && fairways.some(function (f) { return f[j]; }) ? 1 : 0;
    });
    function fairwayOnLine(s) { var k = Math.round(s); return k >= 0 && k < walked.length && onFairway[k] === 1; }
    /* The turf score across the line at each step: the median over a strip ±CROSSING_HALF_M. */
    var halfPx = CROSSING_HALF_M / mpp, offTurf = new Float32Array(walked.length);
    walked.forEach(function (p, k) {
      var vals = [];
      for (var t = -halfPx; t <= halfPx; t += Math.max(1, halfPx / 3)) {
        var x = Math.round(p.x - p.uy * t), y = Math.round(p.y + p.ux * t);
        if (x >= 0 && y >= 0 && x < w && y < h) vals.push(spreadDistance(field, y * w + x, turf));
      }
      offTurf[k] = vals.length ? median(vals) : 0;
    });
    var max = Math.max(1, Number(o.max) || HAZARD_FINDER_MAX);
    var minBunkerPx = BUNKER_AREA_M2.min / (mpp * mpp), maxBunkerPx = BUNKER_AREA_M2.max / (mpp * mpp), minBunkerDepth = BUNKER_MIN_DEPTH_M / mpp;
    var minWaterPx = WATER_MIN_AREA_M2 / (mpp * mpp), openPx = Math.max(1, Math.round(0.5 / mpp));

    function outline(mask) { return maskOutline(mask, w, h, DETAIL_MAX_POINTS); }

    function find(level) {
      var k = Math.max(0, Math.min(HAZARD_STEP_MARGIN.length - 1, Math.round(Number(level)) || 0));
      var m = HAZARD_STEP_MARGIN[k], tol = HAZARD_STEP_TURF[k];
      var sandOver = Math.max(SAND_BRIGHT_MARGIN, turf.dL) * m, waterUnder = Math.max(WATER_DARK_MARGIN, turf.dL) * m;
      var sand = new Uint8Array(n), water = new Uint8Array(n), j;
      for (j = 0; j < n; j++) {
        sand[j] = sandy[j] && over[j] > sandOver ? 1 : 0;
        water[j] = watery[j] && under[j] > waterUnder ? 1 : 0;
      }
      sand = morph(morph(sand, w, h, openPx, false), w, h, openPx, true);
      water = morph(morph(morph(morph(water, w, h, openPx, true), w, h, openPx, false), w, h, openPx, false), w, h, openPx, true);
      var out = { bunkers: [], water: [], hazards: [] }, taken = new Uint8Array(n);
      blobs(sand, w, h, { minAreaPx: minBunkerPx }).forEach(function (b) {
        if (out.bunkers.length >= max || b.area > maxBunkerPx || b.depth < minBunkerDepth) return;
        var ring = outline(blobMask(b, n));
        if (ring) { out.bunkers.push(ring); b.at.forEach(function (q) { taken[q] = 1; }); }
      });
      blobs(water, w, h, { minAreaPx: minWaterPx }).forEach(function (b) {
        if (out.water.length >= max) return;
        var ring = outline(blobMask(b, n));
        if (ring) { out.water.push(ring); b.at.forEach(function (q) { taken[q] = 1; }); }
      });

      /* Crossings: runs of the line that are not turf, clear of the tee and green ends and of
         what was just found, grown sideways and read against the fairway shapes. */
      var skip0 = CROSSING_SKIP_TEE_M / mpp, skip1 = total - CROSSING_SKIP_GREEN_M / mpp;
      var minRun = CROSSING_MIN_M / mpp, maxRun = CROSSING_MAX_M / mpp, reach = CROSSING_REACH_M / mpp;
      var runs = [], cur = null;
      walked.forEach(function (p, q) {
        var j = Math.round(p.y) * w + Math.round(p.x), on = p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
        var off = on && p.s >= skip0 && p.s <= skip1 && offTurf[q] > tol && corridor[j] && !taken[j];
        if (off) { if (!cur) cur = []; cur.push({ x: p.x, y: p.y, s: p.s, off: offTurf[q] }); }
        else if (cur) { runs.push(cur); cur = null; }
      });
      if (cur) runs.push(cur);
      runs.forEach(function (run) {
        if (out.hazards.length >= max) return;
        var length = run[run.length - 1].s - run[0].s;
        if (length < minRun || length > maxRun) return;
        /* The run's own pixels are the seed and the colour sample - one pixel wide, and only
           its solid middle: the few blended pixels at either end, half turf, would widen the
           colour's spread until turf itself fitted it. */
        var solid = median(run.map(function (p) { return p.off; })) * 0.6, seedMask = new Uint8Array(n), seeds = [];
        paintLine(seedMask, w, h, run.filter(function (p) { return p.off >= solid; }));
        for (var q = 0; q < n; q++) if (seedMask[q] && corridor[q]) seeds.push(q);
        if (seeds.length < 3) return;
        var near = distanceTo(seedMask, w, h);
        for (q = 0; q < n; q++) if (near[q] > reach) near[q] = Infinity;
        var grown = growRegion(field, seeds, colourModel(fieldSamples(field, seeds)), near, reach, null, { levels: [2.2], openPx: openPx, minAreaPx: seeds.length });
        if (!grown.candidates.length) return;
        var mask = ringsMask(w, h, [grown.candidates[grown.pick]]);
        for (q = 0; q < n; q++) if (mask[q] && taken[q]) mask[q] = 0;
        var blob = blobs(mask, w, h, { minAreaPx: 1 })[0];
        if (!blob) return;
        var sits = crossingCase(run, mask, fairways, fairwayOnLine, w, h, maxRun), hazard = false;
        if (sits === "through") hazard = !pathLike(field, blob, turf, mpp);
        else if (sits === "gap") hazard = median(maskIndices(mask, HAZARD_SAMPLE_PIXELS).map(function (q) { return tex[q]; })) >= GAP_TEXTURE_OVER_ROUGH * Math.max(roughTex, 0.5);
        else {
          /* A hint of water: in the crossing or along it (a creek the grow left out, being
             another colour), a couple of metres either way. */
          var zone = morph(mask, w, h, Math.max(1, Math.round(2 / mpp)), true), wetPx = 0;
          for (q = 0; q < n; q++) if (zone[q] && wet[q] && under[q] > waterUnder * 0.6) wetPx++;
          hazard = wetPx >= blob.area * PARTIAL_WATER_SHARE;
        }
        if (!hazard) return;
        var ring = outline(mask);
        if (ring) { out.hazards.push(ring); blob.at.forEach(function (q) { taken[q] = 1; }); }
      });
      return out;
    }
    return { find: find, turfFrom: turfFrom };
  }

  /* Which pixels of a picture stand at least minM tall, from canopy-height grids. cap: the
     picture's {width, height, z, ox, oy} - its top-left corner in world pixels at Web Mercator
     zoom z. grids: [{crs: "EPSG:3857" | "EPSG:4326", x0, y0 (top-left corner in that crs),
     dx, dy (a cell's size, dy negative going down), width, height, heights (metres, a cell
     each)}]. Null when the grids hold nothing above zero: 0 is both "no tree" and "no data",
     and a picture of nothing but 0 is read as no data, not as no trees. */
  function heightMask(cap, grids, minM) {
    var W = cap.width, H = cap.height, out = new Uint8Array(W * H);
    var list = (grids || []).filter(function (g) {
      for (var k = 0; k < g.heights.length; k++) if (g.heights[k] > 0) return true;
      return false;
    });
    if (!list.length) return null;
    var R = 6378137, C = 2 * Math.PI * R, world = 256 * Math.pow(2, cap.z), min = Number(minM) || TREE_MIN_HEIGHT_M;
    for (var y = 0; y < H; y++) {
      var my = (0.5 - (cap.oy + y + 0.5) / world) * C;
      var lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180 / Math.PI;
      for (var x = 0; x < W; x++) {
        var mx = ((cap.ox + x + 0.5) / world - 0.5) * C, lng = mx / R * 180 / Math.PI;
        for (var g = 0; g < list.length; g++) {
          var grid = list[g], geo = grid.crs === "EPSG:4326";
          var col = Math.floor(((geo ? lng : mx) - grid.x0) / grid.dx), row = Math.floor(((geo ? lat : my) - grid.y0) / grid.dy);
          if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) continue;
          if (grid.heights[row * grid.width + col] >= min) out[y * W + x] = 1;
          break;
        }
      }
    }
    return out;
  }

  /* ---- the colour wand ----
     Like Instant Alpha in Preview: a press on the picture takes the colour under it, and every
     pixel connected to it within `tolerance` of that colour is selected - dragging further
     raises the tolerance. field: a colourField. Returns a 0/1 mask the size of the field. */
  function floodSelect(field, x, y, tolerance) {
    var w = field.w, h = field.h, sx = Math.round(x), sy = Math.round(y);
    var mask = new Uint8Array(w * h);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
    var s = sy * w + sx, cL = field.L[s], cA = field.A[s], cB = field.B[s];
    var tol2 = Math.max(0, Number(tolerance) || 0);
    tol2 *= tol2;
    var queue = new Int32Array(w * h), head = 0, tail = 0;
    mask[s] = 1; queue[tail++] = s;
    function visit(i) {
      if (mask[i]) return;
      var dL = field.L[i] - cL, dA = field.A[i] - cA, dB = field.B[i] - cB;
      if (dL * dL + dA * dA + dB * dB > tol2) return;
      mask[i] = 1; queue[tail++] = i;
    }
    while (head < tail) {
      var i = queue[head++], ix = i % w;
      if (ix > 0) visit(i - 1);
      if (ix < w - 1) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i < w * h - w) visit(i + w);
    }
    return mask;
  }

  /* The outer edge of the biggest region in a 0/1 mask, holes filled, as a ring of at most
     maxPoints corners in the mask's pixels - or null when there is nothing to outline. */
  function maskOutline(mask, w, h, maxPoints) {
    var filled = fillHoles(mask, w, h);
    var loop = traceLargestLoop(filled, w, h);
    if (!loop || Math.abs(ringArea(loop)) < 4) return null;
    var cap = maxPoints || DETAIL_MAX_POINTS;
    var tol = 0.75, ring = simplifyRing(loop, tol);
    while (ring.length > cap) { tol *= 1.5; ring = simplifyRing(loop, tol); }
    return ring.length >= 3 ? ring : null;
  }

  /* ---- reshaping a detailed outline ----
     A wand outline has far more corners than anyone wants to drag one by one. It is edited by
     a few key corners - its sharpest turns, spaced out - and by grabbing the edge anywhere:
     the edge bends smoothly round the grab, as if there were corners close by, and the key
     corners either side stay put. All of this works in screen pixels ({x, y}), so how fine the
     bend is follows the zoom. */

  /* Distance round a closed ring to each corner from the first. */
  function ringArc(xy) {
    var cum = [0], total = 0;
    for (var i = 1; i <= xy.length; i++) { total += len(sub(xy[i % xy.length], xy[i - 1])); if (i < xy.length) cum.push(total); }
    return { cum: cum, total: total };
  }

  /* The corners of a ring that get a handle, as indices in order: the corners Douglas-Peucker
     keeps at `tolPx` (the turns that shape it), none closer than `minGapPx` round the edge to
     the one before, and an extra one wherever two are more than `maxGapPx` apart. */
  function keyCorners(xy, opts) {
    var o = opts || {}, n = xy ? xy.length : 0;
    if (n < 3) return [];
    var minGap = o.minGapPx || 64, maxGap = o.maxGapPx || 240;
    var arc = ringArc(xy), total = arc.total;
    var tagged = xy.map(function (p, i) { return { x: p.x, y: p.y, i: i }; });
    var turns = simplifyRing(tagged, o.tolPx || 4).map(function (p) { return p.i; }).sort(function (a, b) { return a - b; });
    var kept = [];
    turns.forEach(function (i) { if (!kept.length || arc.cum[i] - arc.cum[kept[kept.length - 1]] >= minGap) kept.push(i); });
    while (kept.length > 1 && total - arc.cum[kept[kept.length - 1]] + arc.cum[kept[0]] < minGap) kept.pop();
    if (kept.length < 3) {
      kept = [];
      for (var q = 0; q < 4; q++) kept.push(nearestAt(arc, total * q / 4));
    }
    var out = [];
    kept.forEach(function (i, k) {
      out.push(i);
      var a = arc.cum[i], b = k + 1 < kept.length ? arc.cum[kept[k + 1]] : total + arc.cum[kept[0]];
      var extra = Math.ceil((b - a) / maxGap) - 1;
      for (var e = 1; e <= extra; e++) out.push(nearestAt(arc, (a + (b - a) * e / (extra + 1)) % total));
    });
    return out.filter(function (i, k) { return out.indexOf(i) === k; }).sort(function (a, b) { return a - b; });
  }
  function nearestAt(arc, s) {
    var best = 0, bd = Infinity;
    arc.cum.forEach(function (c, i) { var d = Math.min(Math.abs(c - s), arc.total - Math.abs(c - s)); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  /* Where on a ring's edge a point is nearest: the corner it follows and the point itself. */
  function nearestOnRing(xy, pt) {
    var best = null;
    for (var i = 0; i < xy.length; i++) {
      var a = xy[i], b = xy[(i + 1) % xy.length], d = sub(b, a), l2 = d.x * d.x + d.y * d.y;
      var t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((pt.x - a.x) * d.x + (pt.y - a.y) * d.y) / l2)) : 0;
      var q = add(a, scale(d, t)), dist = len(sub(pt, q));
      if (!best || dist < best.dist) best = { segment: i, t: t, point: q, dist: dist };
    }
    return best;
  }

  function falloff(u) { return u < 1 ? 0.5 * (1 + Math.cos(Math.PI * u)) : 0; }
  function linearFalloff(u) { return u < 1 ? 1 - u : 0; }

  /* Ready a ring to be bent at one place. at: {index} - a corner - or {segment, point} - a
     point on the edge after corner `segment`, put in as a corner of its own. The bend reaches
     round the edge each way as far as the next of `keys` (the key corners, which stay put),
     and no further than `maxReachPx` when given. A corner (at.index) moves like a corner: the
     edge either side follows it in proportion, so a straight edge stays straight. A grab on
     the edge bends it as a smooth curve: the stretch it reaches is cut into corners no
     further apart than `spacingPx` (fewer if that would pass `maxPoints`) so it is a curve
     rather than a tent. Returns {ring, weights, added, from}: move corner i by the
     drag times weights[i]; added[i] marks a corner put in here, for tidyBend; from[i] is the
     corner of `xy` it was, or -1. The ring keeps its first corner first. */
  function bendRing(xy, at, opts) {
    var o = opts || {}, n = xy.length, smooth = at.segment != null;
    var fall = smooth ? falloff : linearFalloff;
    var ring = xy.map(function (p, i) { return { x: p.x, y: p.y, from: i }; }), anchor;
    if (at.segment != null) { ring.splice(at.segment + 1, 0, { x: at.point.x, y: at.point.y, from: -1 }); anchor = at.segment + 1; }
    else anchor = at.index;
    n = ring.length;
    var rot = ring.slice(anchor).concat(ring.slice(0, anchor));
    var arc = ringArc(rot), total = arc.total;
    var back = total / 2, ahead = total / 2;
    rot.forEach(function (p, i) {
      if (i === 0 || p.from < 0 || !o.keys || o.keys.indexOf(p.from) < 0) return;
      ahead = Math.min(ahead, arc.cum[i]);
      back = Math.min(back, total - arc.cum[i]);
    });
    if (o.maxReachPx) { ahead = Math.min(ahead, o.maxReachPx); back = Math.min(back, o.maxReachPx); }
    function reach(s) { return s <= ahead || total - s <= back; }
    var inRange = 0;
    for (var i = 0; i < n; i++) {
      var s0 = arc.cum[i], s1 = i + 1 < n ? arc.cum[i + 1] : total;
      if (reach(s0) || reach(s1)) inRange += s1 - s0;
    }
    var room = Math.max(0, (o.maxPoints || MAX_POINTS) - n);
    var gap = Math.max(o.spacingPx || 6, room ? inRange / room : Infinity);
    var out = [], sAt = [];
    for (i = 0; i < n; i++) {
      var a = rot[i], b = rot[(i + 1) % n], sa = arc.cum[i], sb = i + 1 < n ? arc.cum[i + 1] : total;
      out.push(a); sAt.push(sa);
      if (!smooth || !(reach(sa) || reach(sb)) || !isFinite(gap)) continue;
      var pieces = Math.floor((sb - sa) / gap);
      for (var k = 1; k < pieces; k++) {
        var t = k / pieces;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, from: -1 });
        sAt.push(sa + (sb - sa) * t);
      }
    }
    var weights = sAt.map(function (s) { return Math.max(ahead > 0 ? fall(s / ahead) : 0, back > 0 ? fall((total - s) / back) : 0, s === 0 ? 1 : 0); });
    var first = 0;
    out.forEach(function (p, i) { if (p.from === 0) first = i; });
    var order = out.slice(first).concat(out.slice(0, first));
    weights = weights.slice(first).concat(weights.slice(0, first));
    return {
      ring: order.map(function (p) { return { x: p.x, y: p.y }; }),
      weights: weights,
      added: order.map(function (p) { return p.from < 0; }),
      from: order.map(function (p) { return p.from; })
    };
  }

  /* After a bend: a corner bendRing put in that ended up on a straight line between its
     neighbours (within tolPx) is taken back out, so a bend leaves only the corners it needs. */
  function tidyBend(xy, added, tolPx) {
    var out = xy.slice(), flags = added.slice(), tol = tolPx || 0.4;
    for (var i = 0; i < out.length && out.length > 3; i++) {
      if (!flags[i]) continue;
      var a = out[(i - 1 + out.length) % out.length], b = out[(i + 1) % out.length], d = sub(b, a), l = len(d);
      var off = l < 1e-9 ? len(sub(out[i], a)) : Math.abs(d.x * (a.y - out[i].y) - d.y * (a.x - out[i].x)) / l;
      if (off <= tol) { out.splice(i, 1); flags.splice(i, 1); i--; }
    }
    return out;
  }

  /* ---- seams ----
     Where two areas meet - a fairway and the waste beside it, a wood and a water hazard - the
     line between them is one line, held by both. A small gap between them, or a thin overlap,
     closes in the middle: each edge meets the other halfway, and that line becomes a seam -
     the very same corners in both outlines. Dragging a seam moves it for both (weldRuns /
     applyWeld), so it only changes which ground belongs to which.

     seamPair works in flat metres. Close to the other shape, an edge is cut into corners
     SEAM_SPACING_M apart; a corner within 0.7 x gapM of the other edge (or inside it) moves
     to halfway between itself and the nearest point of that edge, and those corners are the
     seam; out to 1.3 x gapM it moves part of the way, so the seam runs out into the gap
     smoothly. The other shape's corners along the seam are replaced by the seam itself.
     Corners in lockedA / lockedB (a seam with a third shape) are never moved or removed, and
     corners the seam never reached keep their exact coordinates. */
  var SEAM_GAP_M = 5;
  var SEAM_SPACING_M = 1;
  var SEAM_TOL_M = 0.15;

  /* A ring with every edge that passes within `reach` of `other` cut into corners no more than
     `spacing` apart - except an edge between two locked corners. Each corner says whether it
     was one of the ring's own (index) or put in here (-1). */
  function densifyNear(ring, locked, other, reach, spacing) {
    var out = [], n = ring.length;
    for (var i = 0; i < n; i++) {
      var a = ring[i], b = ring[(i + 1) % n], l = len(sub(b, a));
      out.push({ x: a.x, y: a.y, own: i, locked: !!locked[i] });
      if (locked[i] && locked[(i + 1) % n]) continue;
      var samples = Math.max(1, Math.ceil(l / Math.max(1, reach))), near = false;
      for (var k = 0; k <= samples && !near; k++) near = nearestOnRing(other, add(a, scale(sub(b, a), k / samples))).dist <= reach;
      if (!near) continue;
      var pieces = Math.floor(l / spacing);
      for (var q = 1; q < pieces; q++) { var t = q / pieces; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, own: -1, locked: false }); }
    }
    return out;
  }

  /* How far each corner moves toward the other shape: w 1 on the seam, 0 out of reach. A
     corner outside the other shape whose way to it runs along its own edge (the side of a
     fairway running past the end of a waste area) is not facing it, and does not move. */
  function seamPull(pts, other, gap, reach) {
    var full = gap * 0.7, n = pts.length;
    pts.forEach(function (p, i) {
      if (p.locked) { p.w = 0; return; }
      var near = nearestOnRing(other, p), within = insideRing(p, other), d = within ? 0 : near.dist;
      p.w = d <= full ? 1 : d >= reach ? 0 : (reach - d) / (reach - full);
      if (!within && p.w > 0 && near.dist > 1e-6) {
        var along = unit(sub(pts[(i + 1) % n], pts[(i - 1 + n) % n])), toward = unit(sub(near.point, p));
        if (Math.abs(along.x * toward.x + along.y * toward.y) > 0.75) p.w = 0;
      }
      p.mid = { x: (p.x + near.point.x) / 2, y: (p.y + near.point.y) / 2 };
    });
  }

  /* The runs of seam corners (w 1) round a ring, as [start, end] index pairs that may wrap.
     A short break between two runs where the edge never leaves reach (a wiggle in a wand edge
     that steps a little further away) is bridged, so a facing edge is one seam. */
  function seamRuns(pts, bridge) {
    var n = pts.length, start = -1, i, runs = [];
    for (i = 0; i < n; i++) if (pts[i].w >= 1) { start = i; break; }
    if (start >= 0) {
      var gapRun = [], arc = 0;
      for (var s = 1; s <= n; s++) {
        i = (start + s) % n;
        var prev = pts[(i - 1 + n) % n];
        if (pts[i].w >= 1) {
          if (gapRun.length && arc + len(sub(pts[i], prev)) <= bridge && gapRun.every(function (j) { return pts[j].w > 0; })) gapRun.forEach(function (j) { pts[j].w = 1; });
          gapRun = []; arc = 0;
        } else { gapRun.push(i); arc += len(sub(pts[i], prev)); }
      }
    }
    start = -1;
    for (i = 0; i < n; i++) if (pts[i].w < 1) { start = i; break; }
    if (start < 0) return null;
    var cur = null;
    for (var k = 1; k <= n; k++) {
      i = (start + k) % n;
      if (pts[i].w >= 1) { if (!cur) cur = [i, i]; else cur[1] = i; }
      else if (cur) { runs.push(cur); cur = null; }
    }
    return runs.filter(function (r) { return r[0] !== r[1]; });
  }
  function runIndices(r, n) { var out = [], i = r[0]; for (;;) { out.push(i); if (i === r[1]) break; i = (i + 1) % n; } return out; }

  /* Distance from a point to an open line. */
  function distToLine(line, p) {
    var best = Infinity;
    for (var i = 1; i < line.length; i++) {
      var a = line[i - 1], d = sub(line[i], a), l2 = d.x * d.x + d.y * d.y;
      var t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2)) : 0;
      best = Math.min(best, len(sub(p, add(a, scale(d, t)))));
    }
    return best;
  }

  /* ringA and ringB ({lat, lng}) joined along a seam wherever they are within gapM of each
     other or overlap at an edge: {a, b, seams} with the new outlines, or null when they do not
     meet, when one sits mostly inside the other (a pond in a waste area is not a seam), or
     when the result would pass maxPoints. */
  function seamPair(ringA, ringB, opts) {
    var o = opts || {};
    if (!ringA || !ringB || ringA.length < 3 || ringB.length < 3) return null;
    var gap = o.gapM || SEAM_GAP_M, reach = gap * 1.3, spacing = o.spacingM || SEAM_SPACING_M, cap = o.maxPoints || MAX_POINTS;
    var f = frame(ringA[0]);
    var A = ringA.map(f.toXY), B = ringB.map(f.toXY);
    var inside = function (P, Q) { return P.filter(function (p) { return insideRing(p, Q); }).length / P.length; };
    if (inside(A, B) > 0.5 || inside(B, A) > 0.5) return null;
    var dA = densifyNear(A, o.lockedA || [], B, reach, spacing);
    var dB = densifyNear(B, o.lockedB || [], A, reach, spacing);
    seamPull(dA, B, gap, reach);
    seamPull(dB, A, gap, reach);
    var runsA = seamRuns(dA, gap * 6), runsB = seamRuns(dB, gap * 6);
    if (!runsA || !runsB || !runsA.length || !runsB.length) return null;

    var tol = o.tolM || SEAM_TOL_M;
    for (var attempt = 0; attempt < 8; attempt++, tol *= 1.6) {
      /* The seams, from A's side: its seam corners moved to the middle, thinned once, as
         lat/lng once - so both outlines get exactly the same numbers. */
      var seams = runsA.map(function (r) {
        var line = simplifyLine(runIndices(r, dA.length).map(function (i) { return dA[i].mid; }), tol);
        return { line: line, ll: line.map(f.toLL), used: false };
      });
      /* Each of B's seam runs takes the seam nearest it, at most one run a seam. */
      var takeB = runsB.map(function (r) {
        var idx = runIndices(r, dB.length), probe = dB[idx[Math.floor(idx.length / 2)]];
        var best = null, bd = Infinity;
        seams.forEach(function (sm) { if (sm.used) return; var d = distToLine(sm.line, probe); if (d < bd) { bd = d; best = sm; } });
        if (!best || bd > gap) return null;
        best.used = true;
        var before = dB[(r[0] - 1 + dB.length) % dB.length];
        var fwd = len(sub(before, best.line[0])) <= len(sub(before, best.line[best.line.length - 1]));
        return { run: r, ll: fwd ? best.ll : best.ll.slice().reverse() };
      });
      var a = assemble(dA, ringA, runsA.map(function (r, k) { return seams[k].used ? { run: r, ll: seams[k].ll } : null; }), tol, f);
      var b = assemble(dB, ringB, takeB, tol, f);
      if (!seams.some(function (sm) { return sm.used; })) return null;
      if (a.length <= cap && b.length <= cap) return { a: a, b: b, seams: seams.filter(function (sm) { return sm.used; }).length };
    }
    return null;
  }

  /* One outline put back together: its seam runs replaced by the seam, the corners near the
     other shape pulled part of the way, the corners put in along the way thinned out again,
     and every corner the seam never reached exactly as it was. */
  function assemble(pts, orig, takes, tol, f) {
    var n = pts.length, seamAt = {};
    takes.forEach(function (t) { if (!t) return; runIndices(t.run, n).forEach(function (i, k) { seamAt[i] = k === 0 ? t : "skip"; }); });
    var items = [];
    for (var i = 0; i < n; i++) {
      var p = pts[i], t = seamAt[i];
      if (t === "skip") continue;
      if (t) { t.ll.forEach(function (ll) { items.push({ ll: { lat: ll.lat, lng: ll.lng }, fixed: true }); }); continue; }
      if (p.own >= 0 && !(p.w > 0)) { items.push({ ll: { lat: orig[p.own].lat, lng: orig[p.own].lng }, fixed: true }); continue; }
      var at = p.w > 0 ? add(p, scale(sub(p.mid, p), p.w)) : { x: p.x, y: p.y };
      items.push({ xy: at, fixed: false });
    }
    /* Thin each stretch of loose corners between two fixed ones. */
    items.forEach(function (it) { if (!it.xy) it.xy = f.toXY(it.ll); });
    var first = -1;
    for (i = 0; i < items.length; i++) if (items[i].fixed) { first = i; break; }
    var out = [];
    if (first < 0) {
      out = simplifyRing(items.map(function (it) { return it.xy; }), tol).map(f.toLL);
      return out;
    }
    var rot = items.slice(first).concat(items.slice(0, first)).concat([items[first]]);
    var from = 0;
    for (i = 1; i < rot.length; i++) {
      if (!rot[i].fixed) continue;
      var stretch = rot.slice(from, i + 1);
      var kept = stretch.length > 2 ? simplifyLine(stretch.map(function (it) { return it.xy; }), tol) : stretch.map(function (it) { return it.xy; });
      kept.slice(0, -1).forEach(function (xy, k) {
        var it = k === 0 ? stretch[0] : stretch.filter(function (s) { return s.xy === xy; })[0];
        out.push(it.ll ? { lat: it.ll.lat, lng: it.ll.lng } : f.toLL(xy));
      });
      from = i;
    }
    return out;
  }

  /* Where outline g shares corners with outline f (the very same coordinates): the runs of
     them round g, each with the corners of f it matches, in order. For applyWeld. */
  function pointKey(p) { return p.lat.toFixed(9) + "," + p.lng.toFixed(9); }
  function weldRuns(g, f) {
    var at = {}, nf = f.length, ng = g.length;
    f.forEach(function (p, j) { at[pointKey(p)] = j; });
    var m = g.map(function (p) { var j = at[pointKey(p)]; return j == null ? -1 : j; });
    var start = -1, i;
    for (i = 0; i < ng; i++) if (m[i] < 0) { start = i; break; }
    if (start < 0) return [];
    var runs = [], cur = null;
    for (var k = 1; k <= ng; k++) {
      i = (start + k) % ng;
      var j = m[i];
      if (j < 0) { if (cur) runs.push(cur); cur = null; continue; }
      if (cur) {
        var last = cur.f[cur.f.length - 1], step = (j - last + nf) % nf;
        var dir = step === 1 ? 1 : step === nf - 1 ? -1 : 0;
        if (dir && (cur.dir === 0 || cur.dir === dir)) { cur.g.push(i); cur.f.push(j); cur.dir = dir; continue; }
        runs.push(cur);
      }
      cur = { g: [i], f: [j], dir: 0 };
    }
    if (cur) runs.push(cur);
    return runs;
  }

  /* g again, with its shared runs following f to where f now is: fNew is f's new outline and
     from[i] the old corner of f that fNew[i] was (-1 for a corner put in since). A run takes
     every corner f now has along it, so the two stay the very same line. */
  function applyWeld(g, runs, fNew, from) {
    if (!runs.length) return g.slice();
    var now = {}, nn = fNew.length;
    from.forEach(function (j, i) { if (j >= 0) now[j] = i; });
    var take = {};
    runs.forEach(function (r) {
      var a = now[r.f[0]], b = now[r.f[r.f.length - 1]];
      var line = [];
      if (a == null || b == null) line = null;
      else if (r.f.length === 1) line = [fNew[a]];
      else for (var i = a, guard = 0; guard <= nn; guard++, i = (i + r.dir + nn) % nn) { line.push(fNew[i]); if (i === b) break; }
      r.g.forEach(function (gi, k) { take[gi] = k === 0 ? (line || null) : "skip"; });
      if (!line) r.g.forEach(function (gi) { take[gi] = undefined; });
    });
    var out = [];
    g.forEach(function (p, i) {
      var t = take[i];
      if (t === "skip") return;
      if (t) t.forEach(function (q) { out.push({ lat: q.lat, lng: q.lng }); });
      else out.push(p);
    });
    return out;
  }

  var api = {
    FAIRWAY_WIDTH_M: FAIRWAY_WIDTH_M, TEE_RADIUS_M: TEE_RADIUS_M, GREEN_RADIUS_M: GREEN_RADIUS_M,
    SMOOTH: SMOOTH, softenOutline: softenOutline, BUNKER_RADIUS_M: BUNKER_RADIUS_M, WATER_RADIUS_M: WATER_RADIUS_M, WATER_MAX_POINTS: WATER_MAX_POINTS, MAX_POINTS: MAX_POINTS,
    distanceM: distanceM, lineLengthM: lineLengthM, centroid: centroid,
    fairwayFromLine: fairwayFromLine, teeAt: teeAt, circle: circle, mergeOverlapping: mergeOverlapping,
    smoothRing: smoothRing, ringHandles: ringHandles, smoothOutline: smoothOutline,
    scaleAbout: scaleAbout, simplifyOutline: simplifyOutline,
    growFromLine: growFromLine, traceLargestLoop: traceLargestLoop, LINE_WAND_LEVELS: LINE_WAND_LEVELS,
    TREE_RADIUS_M: TREE_RADIUS_M, treeAt: treeAt, ellipseInBox: ellipseInBox, ringRadiusM: ringRadiusM,
    growFromArea: growFromArea, colourField: colourField, colourModel: colourModel, circleSamples: circleSamples,
    treeFinder: treeFinder, TREE_FINDER_LEVELS: TREE_FINDER_LEVELS, TREE_FINDER_MAX: TREE_FINDER_MAX, treesInMask: treesInMask, nestedTrees: nestedTrees,
    TREE_BAND_M: TREE_BAND_M, TREE_CLEAR_M: TREE_CLEAR_M, TREE_AUTO_RADIUS_M: TREE_AUTO_RADIUS_M, TREE_MIN_HEIGHT_M: TREE_MIN_HEIGHT_M, TREE_DEFAULT_STEP: TREE_DEFAULT_STEP,
    ringsMask: ringsMask, playBand: playBand, autoTreeModel: autoTreeModel, heightMask: heightMask,
    hazardFinder: hazardFinder, HAZARD_FINDER_LEVELS: HAZARD_FINDER_LEVELS, HAZARD_DEFAULT_STEP: HAZARD_DEFAULT_STEP, HAZARD_CORRIDOR_M: HAZARD_CORRIDOR_M, HAZARD_CLEAR_M: HAZARD_CLEAR_M,
    lineMask: lineMask, blobs: blobs, textureField: textureField,
    floodSelect: floodSelect, maskOutline: maskOutline,
    reshapeOutline: reshapeOutline, collarOutline: collarOutline, insideLatLngRing: insideLatLngRing,
    DETAIL_MAX_POINTS: DETAIL_MAX_POINTS, keyCorners: keyCorners, nearestOnRing: nearestOnRing, bendRing: bendRing, tidyBend: tidyBend,
    SEAM_GAP_M: SEAM_GAP_M, seamPair: seamPair, pointKey: pointKey, weldRuns: weldRuns, applyWeld: applyWeld
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GDOverlayShapes = api;
})(typeof window !== "undefined" ? window : this);
