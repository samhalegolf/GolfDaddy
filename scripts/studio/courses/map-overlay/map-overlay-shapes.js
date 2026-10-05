/* Clarity Studio — Mapping Overlay shape builders. Studio-only, pure geometry.
 *
 * The overlay is placed by eye, not traced: a person lays a line down the middle of a fairway
 * and gets a fairway-shaped polygon with evenly spaced corners to drag into shape; a pin on a
 * green becomes a green outline (the wand, server-side) or, when the wand has nothing, the
 * round default made here. Greens and bunkers are kept as smooth curves through a few handles.
 * Bunker outlines that overlap are merged into one. A water hazard drawn round by hand is
 * thinned to the corners that matter. A single tree is a small ring, a cluster an oval
 * stretched over it; the tree finder looks for more trees like the ones placed by hand, the
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
     the outline is a smooth curve through the handles, `steps` corners between each pair. A
     bunker gets a couple more than a green - they are less round - but nowhere near the wand's
     raw corners. The counts are fixed per kind so the handles read straight back off a saved
     outline (ringHandles). */
  var SMOOTH = { green: { handles: 6, steps: 6 }, bunker: { handles: 8, steps: 4 } };
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

  /* A green or bunker as it is kept once outlined: the smooth curve through its handles. Any
     other kind comes back as it is. */
  function smoothOutline(ring, kind) {
    var s = SMOOTH[kind];
    return s ? smoothRing(ringHandles(ring, s.handles, s.steps), s.steps) : ring;
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
     Trees placed by hand this session say what a tree looks like here: their crowns' colour
     (colourModel over circleSamples) and their size (radiusPx). Inside a box, every pixel that
     colour is a "crown" pixel; the crown pixels furthest from anything else are the middles of
     trees. A lone tree is one round blob with its middle at its centre; a row of trees is a
     ridge, and the middles are spaced along it a crown apart. Already-placed trees (`avoid`,
     {x, y, r}) are left alone. Returns {find(level) -> [{x, y, r}]}: the picture is read once
     and each sensitivity level is cheap, so left and right answer at once. */
  var TREE_FINDER_LEVELS = [1.3, 1.7, 2.1, 2.6, 3.2, 4];
  var TREE_FINDER_MAX = 150;

  function treeFinder(image, model, opts) {
    var o = opts || {};
    var radius = Math.max(2, Number(o.radiusPx) || 10);
    var box = o.box || { x0: 0, y0: 0, x1: image.width, y1: image.height };
    var x0 = Math.max(0, Math.floor(Math.min(box.x0, box.x1))), y0 = Math.max(0, Math.floor(Math.min(box.y0, box.y1)));
    var x1 = Math.min(image.width, Math.ceil(Math.max(box.x0, box.x1))), y1 = Math.min(image.height, Math.ceil(Math.max(box.y0, box.y1)));
    var w = x1 - x0, h = y1 - y0;
    if (!model || w < 3 || h < 3) return { find: function () { return []; } };
    /* Just the box, so a big picture costs no more than the box drawn on it. */
    var crop = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) crop.set(image.data.subarray(((y + y0) * image.width + x0) * 4, ((y + y0) * image.width + x1) * 4), y * w * 4);
    var field = colourField({ width: w, height: h, data: crop }, Math.max(1, Math.round(radius * 0.15)));
    var n = w * h, dist = new Float32Array(n);
    for (var i = 0; i < n; i++) dist[i] = spreadDistance(field, i, model);
    var open = Math.max(1, Math.round(radius * 0.25));
    var minR = radius * 0.4;
    var avoid = (o.avoid || []).map(function (a) { return { x: a.x - x0, y: a.y - y0, r: a.r }; });
    var max = Math.max(1, Number(o.max) || TREE_FINDER_MAX);

    function find(level) {
      var crown = new Uint8Array(n), j;
      for (j = 0; j < n; j++) crown[j] = dist[j] <= level ? 1 : 0;
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
          avoid.some(function (a) { return Math.hypot(a.x - c.x, a.y - c.y) < a.r + r * 0.5; });
        if (!clash) kept.push({ x: c.x, y: c.y, r: r });
      }
      return kept.map(function (k) { return { x: k.x + x0 + 0.5, y: k.y + y0 + 0.5, r: k.r }; });
    }
    return { find: find };
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

  var api = {
    FAIRWAY_WIDTH_M: FAIRWAY_WIDTH_M, TEE_RADIUS_M: TEE_RADIUS_M, GREEN_RADIUS_M: GREEN_RADIUS_M,
    SMOOTH: SMOOTH, BUNKER_RADIUS_M: BUNKER_RADIUS_M, WATER_RADIUS_M: WATER_RADIUS_M, WATER_MAX_POINTS: WATER_MAX_POINTS, MAX_POINTS: MAX_POINTS,
    distanceM: distanceM, lineLengthM: lineLengthM, centroid: centroid,
    fairwayFromLine: fairwayFromLine, teeAt: teeAt, circle: circle, mergeOverlapping: mergeOverlapping,
    smoothRing: smoothRing, ringHandles: ringHandles, smoothOutline: smoothOutline,
    scaleAbout: scaleAbout, simplifyOutline: simplifyOutline,
    growFromLine: growFromLine, traceLargestLoop: traceLargestLoop, LINE_WAND_LEVELS: LINE_WAND_LEVELS,
    TREE_RADIUS_M: TREE_RADIUS_M, treeAt: treeAt, ellipseInBox: ellipseInBox, ringRadiusM: ringRadiusM,
    growFromArea: growFromArea, colourField: colourField, colourModel: colourModel, circleSamples: circleSamples,
    treeFinder: treeFinder, TREE_FINDER_LEVELS: TREE_FINDER_LEVELS, TREE_FINDER_MAX: TREE_FINDER_MAX,
    floodSelect: floodSelect, maskOutline: maskOutline,
    DETAIL_MAX_POINTS: DETAIL_MAX_POINTS, keyCorners: keyCorners, nearestOnRing: nearestOnRing, bendRing: bendRing, tidyBend: tidyBend
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GDOverlayShapes = api;
})(typeof window !== "undefined" ? window : this);
