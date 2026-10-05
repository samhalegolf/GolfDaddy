/* Clarity Studio — Mapping Overlay shape builders. Studio-only, pure geometry.
 *
 * The overlay is placed by eye, not traced: a person lays a line down the middle of a fairway
 * and gets a fairway-shaped polygon with evenly spaced corners to drag into shape; a pin on a
 * green becomes a green outline (the wand, server-side) or, when the wand has nothing, the
 * round default made here. Greens and bunkers are kept as smooth curves through a few handles.
 * Bunker outlines that overlap are merged into one. A water hazard drawn round by hand is
 * thinned to the corners that matter. Everything is in
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
    var best = traceLargestLoop(filled, w, h);
    if (!best) return null;
    best = best.map(function (g) { return { x: x0 + g.x * cell, y: y0 + g.y * cell }; });
    if (!best) return null;
    var tol = cell * 0.75;
    var out = simplifyRing(best, tol);
    while (out.length > MERGE_MAX_POINTS) { tol *= 1.5; out = simplifyRing(best, tol); }
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
  var LINE_WAND_MAX_POINTS = 48;
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

  /* image: {width, height, data} RGBA (an ImageData, or anything shaped like one). line: 2+
     points in that image's pixels. opts: reachPx (how far from the line an edge may be),
     blurPx (smoothing radius), openPx (the narrowest neck kept), minAreaPx. Returns
     {candidates: [ring in pixels], areas, pick} or {candidates: [], reason}. */
  function growFromLine(image, line, opts) {
    var o = opts || {};
    var w = image && image.width, h = image && image.height, data = image && image.data;
    if (!w || !h || !data || !Array.isArray(line) || line.length < 2) return { candidates: [], reason: "no-line" };
    var reach = Math.max(4, Number(o.reachPx) || 60), reachSq = reach * reach;
    var n = w * h;
    /* Brightness counts for less than colour: mowing stripes and cloud shadow move brightness,
       and the edge of a fairway, a bunker or water is mostly a change of colour. */
    var L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      L[i] = (0.299 * r + 0.587 * g + 0.114 * b) * 0.6;
      A[i] = r - g;
      B[i] = (r + g) / 2 - b;
    }
    var blur = Math.max(0, Math.round(Number(o.blurPx) || 0));
    L = boxBlur(L, w, h, blur); A = boxBlur(A, w, h, blur); B = boxBlur(B, w, h, blur);

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
    var ls = [], as = [], bs = [];
    seeds.forEach(function (si) { ls.push(L[si]); as.push(A[si]); bs.push(B[si]); });
    var mL = median(ls), mA = median(as), mB = median(bs);
    /* Spread: median absolute deviation, floored so a perfectly flat sample (open water) still
       has a tolerance to scale. */
    var dL = Math.max(3, 1.4826 * median(ls.map(function (v) { return Math.abs(v - mL); })));
    var dA = Math.max(3, 1.4826 * median(as.map(function (v) { return Math.abs(v - mA); })));
    var dB = Math.max(3, 1.4826 * median(bs.map(function (v) { return Math.abs(v - mB); })));

    /* Colour distance from the line's colour, in spreads, and whether a pixel is within reach. */
    var dist = new Float32Array(n);
    /* Distance to the line, kept so a region that ran all the way out to the reach can be told
       apart from one that stopped at a real edge. */
    var lineD = new Float32Array(n);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    line.forEach(function (p) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    var bx0 = Math.max(0, Math.floor(minX - reach)), by0 = Math.max(0, Math.floor(minY - reach));
    var bx1 = Math.min(w - 1, Math.ceil(maxX + reach)), by1 = Math.min(h - 1, Math.ceil(maxY + reach));
    dist.fill(Infinity);
    for (var y = by0; y <= by1; y++) {
      for (var x = bx0; x <= bx1; x++) {
        var nearest = Infinity;
        for (k = 1; k < line.length; k++) nearest = Math.min(nearest, segDistSq(x, y, line[k - 1], line[k]));
        if (nearest > reachSq) continue;
        i = y * w + x;
        lineD[i] = Math.sqrt(nearest);
        var eL = (L[i] - mL) / dL, eA = (A[i] - mA) / dA, eB = (B[i] - mB) / dB;
        dist[i] = Math.sqrt((eL * eL + eA * eA + eB * eB) / 3);
      }
    }

    var open = Math.max(0, Math.round(Number(o.openPx) || 0));
    var minArea = Math.max(16, Number(o.minAreaPx) || 0);
    var levels = Array.isArray(o.levels) && o.levels.length ? o.levels : LINE_WAND_LEVELS;
    var leakShare = Number.isFinite(Number(o.leakShare)) && o.leakShare != null ? Number(o.leakShare) : LINE_WAND_LEAK_SHARE;
    var rings = [];
    levels.forEach(function (level) {
      var ok = new Uint8Array(n);
      for (var j = 0; j < n; j++) ok[j] = dist[j] <= level ? 1 : 0;
      var mask = connected(ok, w, h, seeds);
      if (open) {
        var opened = morph(morph(mask, w, h, open, false), w, h, open, true);
        for (j = 0; j < n; j++) opened[j] = opened[j] && mask[j] ? 1 : 0;
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
          if (lineD[j] >= reach - 2) atReach++;
        }
      }
      if (area < minArea) { rings.push(null); return; }
      var loop = traceLargestLoop(mask, w, h);
      if (!loop) { rings.push(null); return; }
      var tol = 0.75, ring = simplifyRing(loop, tol);
      var cap = Number(o.maxPoints) || LINE_WAND_MAX_POINTS;
      while (ring.length > cap) { tol *= 1.5; ring = simplifyRing(loop, tol); }
      /* Leaked: a good share of its edge is the reach limit, not anything in the picture. */
      rings.push(ring.length >= 3 ? { ring: ring, area: area, leaked: edge > 0 && atReach / edge > leakShare } : null);
    });

    /* Same choice the point wand makes: the step whose edge moved least from the one before
       is the edge the picture actually has. Neighbouring steps on the same edge are one. */
    /* A leaked level is never the pick - its area stops changing because the reach stopped it,
       which would otherwise read as the most stable edge of all. It stays a candidate, last in
       line, for a person who wants it. */
    var best = null, bestSpread = Infinity;
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

  var api = {
    FAIRWAY_WIDTH_M: FAIRWAY_WIDTH_M, TEE_RADIUS_M: TEE_RADIUS_M, GREEN_RADIUS_M: GREEN_RADIUS_M,
    SMOOTH: SMOOTH, BUNKER_RADIUS_M: BUNKER_RADIUS_M, WATER_RADIUS_M: WATER_RADIUS_M, WATER_MAX_POINTS: WATER_MAX_POINTS, MAX_POINTS: MAX_POINTS,
    distanceM: distanceM, lineLengthM: lineLengthM, centroid: centroid,
    fairwayFromLine: fairwayFromLine, teeAt: teeAt, circle: circle, mergeOverlapping: mergeOverlapping,
    smoothRing: smoothRing, ringHandles: ringHandles, smoothOutline: smoothOutline,
    scaleAbout: scaleAbout, simplifyOutline: simplifyOutline,
    growFromLine: growFromLine, traceLargestLoop: traceLargestLoop, LINE_WAND_LEVELS: LINE_WAND_LEVELS
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GDOverlayShapes = api;
})(typeof window !== "undefined" ? window : this);
