/* Terrain PIECES for the watch's own drawn map: the hole cut into rounded shapes of light and
   shadow - ground facing the light, ground facing away - each a closed ring of whole image
   pixels in its Watch package's spatial reference (the space of buildHoleOutlines), so a watch
   places them with the same camera as the surfaces and simply fills them in darker or lighter
   variants of the surface they lie on. Abstract puzzle pieces that slot together; the watch
   is told what to draw, not asked to shade anything.

   HOW. Heights are sampled on a grid of cellPx, lit (Horn hillshade, the relief's own light),
   blurred to blobs of about blurM, and each cell classed dark / mid / lit by the thresholds.
   Cells are also classed by SURFACE (rough, fairway, green - rasterised from the hole's own
   outlines; bunkers and water are never shaded), so a piece never straddles a fairway edge:
   the label is surface * 3 + shade. Specks smaller than minAreaM2 are dropped, each label's
   region is traced into rings (marching squares on its mask), rounded (Chaikin) and simplified
   back under Connect IQ's 64-point fillPolygon limit.

   A ring inside another ring of the same label is a HOLE in that piece; it ships with the
   surface's MID label (surface * 3 + 1), meaning "this surface's own colour", and because
   pieces are ordered surface by surface and largest first, painting them in order is exact.

   Why pieces and not contours or a shade grid: contours read as lines, not texture; a shade
   grid fine enough to read cost 90-142 KB for Millbrook and thousands of drawn dots a frame.
   Pieces came to ~48 KB for the course, at most ~5 KB a hole, a few dozen fills.

   UMD like its siblings: required by functions/course-watch-maps.mjs (listed in netlify.toml
   included_files) and by garmin/tools/make-sim-demo-fixture.js. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GDWatchTerrainCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    cellPx: 2,          // classification grid, image pixels
    blurM: 4,           // how big a piece of light or shadow is at the smallest
    darkBelow: 0.40,    // hillshade (0..1) under this is shadow
    litAbove: 0.60,     // and over this is lit
    minAreaM2: 120,     // smaller specks are noise at watch scale
    toleranceM: 0.5,    // simplification after rounding
    maxPoints: 64,      // Connect IQ fillPolygon
    smoothPasses: 3,    // Chaikin corner cutting
    azimuth: 315,       // light, degrees clockwise from image-up
    altitude: 45,
    exaggeration: 2
  };

  var SURFACE_ROUGH = 0, SURFACE_FAIRWAY = 1, SURFACE_GREEN = 2, UNSHADED = 3;

  /* sample(lat, lng) -> metres; toLatLng({x, y}) -> {lat, lng}; outlines: buildHoleOutlines'
     result. Returns {version, p: [[label, x0, y0, x1, y1, ...], ...]} or null. */
  function buildHoleTerrain(spatialRef, sample, toLatLng, outlines, options) {
    var o = Object.assign({}, DEFAULTS, options || {});
    var cell = o.cellPx, mpp = Number(spatialRef.metresPerPixel) || 0.5;
    var gw = Math.ceil(spatialRef.imageWidth / cell), gh = Math.ceil(spatialRef.imageHeight / cell);
    var heights = new Float32Array(gw * gh);
    for (var y = 0; y < gh; y++) {
      for (var x = 0; x < gw; x++) {
        var ll = toLatLng({ x: (x + 0.5) * cell, y: (y + 0.5) * cell });
        var v = ll ? Number(sample(ll.lat, ll.lng)) : NaN;
        if (!isFinite(v)) return null;
        heights[y * gw + x] = v;
      }
    }
    var shade = blur(hillshade(heights, gw, gh, mpp * cell, o), gw, gh, Math.max(1, Math.round(o.blurM / (mpp * cell))));

    var surface = new Uint8Array(gw * gh);   // 0 rough everywhere to start
    var ring = function (flat, value) { rasterRing(surface, gw, gh, cell, flat, value); };
    /* In the order a watch paints them, so each cell is labelled as the surface left on top:
       trees and hazards under the fairways, waste under the green, water and sand last. Trees,
       hazards and waste are drawn flat, like water and sand, so shading under them would be pieces nothing
       ever shows. */
    (outlines && outlines.k || []).forEach(function (r) { ring(r, UNSHADED); });
    (outlines && outlines.h || []).forEach(function (r) { ring(r, UNSHADED); });
    (outlines && outlines.f || []).forEach(function (r) { ring(r, SURFACE_FAIRWAY); });
    (outlines && outlines.z || []).forEach(function (r) { ring(r, UNSHADED); });
    if (outlines && outlines.g) ring(outlines.g, SURFACE_GREEN);
    (outlines && outlines.w || []).forEach(function (r) { ring(r, UNSHADED); });
    (outlines && outlines.b || []).forEach(function (r) { ring(r, UNSHADED); });

    var label = new Int16Array(gw * gh);
    for (var i = 0; i < label.length; i++) {
      var s = shade[i] < o.darkBelow ? 0 : shade[i] > o.litAbove ? 2 : 1;
      label[i] = surface[i] !== UNSHADED && s !== 1 ? surface[i] * 3 + s : -1;
    }
    dropSpecks(label, gw, gh, o.minAreaM2 / ((mpp * cell) * (mpp * cell)));

    var pieces = [];
    for (var L = 0; L < 9; L++) {
      if (L % 3 === 1) continue;
      var rings = traceLabel(label, gw, gh, L, cell);
      rings.forEach(function (r, index) {
        var depth = 0;
        rings.forEach(function (other, j) { if (j !== index && contains(other, r[0])) depth++; });
        var round = roundRing(r, o, mpp);
        if (round.length < 3) return;
        var flat = [depth % 2 ? Math.floor(L / 3) * 3 + 1 : L];
        round.forEach(function (p) { flat.push(p.x, p.y); });
        pieces.push({ surface: Math.floor(L / 3), area: areaOf(round), flat: flat });
      });
    }
    /* Surface by surface (the watch draws each surface's outline, then its pieces), and
       largest first within it, so a hole painted after its piece is exactly right. */
    pieces.sort(function (a, b) { return a.surface - b.surface || b.area - a.area; });
    return { version: 1, p: pieces.map(function (piece) { return piece.flat; }) };
  }

  /* Horn's method, one light; 0.5 is flat, lower faces away, higher faces the light. */
  function hillshade(h, w, hgt, cellM, o) {
    var out = new Float32Array(w * hgt);
    var az = (360 - o.azimuth + 90) * Math.PI / 180, zen = (90 - o.altitude) * Math.PI / 180;
    var at = function (x, y) { return h[Math.max(0, Math.min(hgt - 1, y)) * w + Math.max(0, Math.min(w - 1, x))] * o.exaggeration; };
    for (var y = 0; y < hgt; y++) {
      for (var x = 0; x < w; x++) {
        var dzdx = ((at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))) / (8 * cellM);
        var dzdy = ((at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))) / (8 * cellM);
        var slope = Math.atan(Math.hypot(dzdx, dzdy));
        var aspect = Math.atan2(dzdy, -dzdx);
        var v = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
        /* Centred so FLAT ground is 0.5 whatever the light's altitude: the thresholds then
           say how far a slope turns toward or away from the light, not how high the sun is. */
        out[y * w + x] = Math.max(0, Math.min(1, 0.5 + v - Math.cos(zen)));
      }
    }
    return out;
  }

  /* Three box passes, close to a gaussian. */
  function blur(a, w, h, r) {
    var t = new Float32Array(a.length);
    for (var pass = 0; pass < 3; pass++) {
      for (var y = 0; y < h; y++) {
        var s = 0, c = 0;
        for (var x = -r; x < w + r; x++) {
          if (x + r < w) { s += a[y * w + x + r]; c++; }
          if (x - r - 1 >= 0) { s -= a[y * w + x - r - 1]; c--; }
          if (x >= 0 && x < w) t[y * w + x] = s / c;
        }
      }
      for (var x2 = 0; x2 < w; x2++) {
        var s2 = 0, c2 = 0;
        for (var y2 = -r; y2 < h + r; y2++) {
          if (y2 + r < h) { s2 += t[(y2 + r) * w + x2]; c2++; }
          if (y2 - r - 1 >= 0) { s2 -= t[(y2 - r - 1) * w + x2]; c2--; }
          if (y2 >= 0 && y2 < h) a[y2 * w + x2] = s2 / c2;
        }
      }
    }
    return a;
  }

  function rasterRing(grid, gw, gh, cell, flat, value) {
    var pts = [];
    for (var i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i] / cell - 0.5, y: flat[i + 1] / cell - 0.5 });
    var minY = Infinity, maxY = -Infinity;
    pts.forEach(function (p) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
    for (var y = Math.max(0, Math.ceil(minY)); y <= Math.min(gh - 1, Math.floor(maxY)); y++) {
      var xs = [];
      for (var k = 0; k < pts.length; k++) {
        var a = pts[k], b = pts[(k + 1) % pts.length];
        if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
      }
      xs.sort(function (p, q) { return p - q; });
      for (var j = 0; j + 1 < xs.length; j += 2) {
        for (var x = Math.max(0, Math.ceil(xs[j])); x <= Math.min(gw - 1, Math.floor(xs[j + 1])); x++) grid[y * gw + x] = value;
      }
    }
  }

  function dropSpecks(label, gw, gh, minCells) {
    var seen = new Uint8Array(label.length);
    for (var i = 0; i < label.length; i++) {
      if (seen[i] || label[i] < 0) continue;
      var L = label[i], comp = [i];
      seen[i] = 1;
      for (var k = 0; k < comp.length; k++) {
        var j = comp[k], x = j % gw, y = (j / gw) | 0;
        var near = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
        for (var n = 0; n < 4; n++) {
          var nx = near[n][0], ny = near[n][1];
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          var q = ny * gw + nx;
          if (!seen[q] && label[q] === L) { seen[q] = 1; comp.push(q); }
        }
      }
      if (comp.length < minCells) comp.forEach(function (c) { label[c] = -1; });
    }
  }

  /* Marching squares on one label's mask, padded so every boundary closes; image pixels. */
  function traceLabel(label, gw, gh, L, cell) {
    var pw = gw + 2, ph = gh + 2, m = new Uint8Array(pw * ph);
    for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) if (label[y * gw + x] === L) m[(y + 1) * pw + x + 1] = 1;
    var segs = [];
    for (var yy = 0; yy < ph - 1; yy++) {
      for (var xx = 0; xx < pw - 1; xx++) {
        var a = m[yy * pw + xx], b = m[yy * pw + xx + 1], c = m[(yy + 1) * pw + xx + 1], d = m[(yy + 1) * pw + xx];
        if (a === b && b === c && c === d) continue;
        var pts = [];
        if (a !== b) pts.push([xx + 0.5, yy]);
        if (b !== c) pts.push([xx + 1, yy + 0.5]);
        if (c !== d) pts.push([xx + 0.5, yy + 1]);
        if (d !== a) pts.push([xx, yy + 0.5]);
        if (pts.length === 2) segs.push(pts);
        else if (pts.length === 4) { segs.push([pts[0], pts[1]]); segs.push([pts[2], pts[3]]); }
      }
    }
    var key = function (p) { return p[0] + "," + p[1]; };
    var ends = {};
    segs.forEach(function (s, i) { [0, 1].forEach(function (e) { var k = key(s[e]); (ends[k] = ends[k] || []).push([i, e]); }); });
    var used = new Uint8Array(segs.length), rings = [];
    for (var i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      var line = [segs[i][0], segs[i][1]];
      for (;;) {
        var next = (ends[key(line[line.length - 1])] || []).filter(function (c) { return !used[c[0]]; })[0];
        if (!next) break;
        used[next[0]] = 1;
        line.push(segs[next[0]][1 - next[1]]);
      }
      if (line.length > 3) rings.push(line.map(function (p) { return { x: (p[0] - 0.5) * cell, y: (p[1] - 0.5) * cell }; }));
    }
    return rings;
  }

  function contains(ring, p) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function roundRing(points, o, mpp) {
    var smooth = chaikin(points, o.smoothPasses);
    var tol = o.toleranceM / mpp;
    var out = douglasPeuckerRing(smooth, tol);
    while (out.length > o.maxPoints) { tol *= 1.3; out = douglasPeuckerRing(smooth, tol); }
    return out.map(function (p) { return { x: Math.round(p.x), y: Math.round(p.y) }; });
  }

  function chaikin(points, passes) {
    var pts = points;
    for (var p = 0; p < passes; p++) {
      var out = [];
      for (var i = 0; i < pts.length; i++) {
        var a = pts[i], b = pts[(i + 1) % pts.length];
        out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
      }
      pts = out;
    }
    return pts;
  }

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

  function areaOf(r) {
    var a = 0;
    for (var i = 0; i < r.length; i++) { var p = r[i], q = r[(i + 1) % r.length]; a += p.x * q.y - q.x * p.y; }
    return Math.abs(a / 2);
  }

  return { DEFAULTS: DEFAULTS, buildHoleTerrain: buildHoleTerrain, chaikin: chaikin, douglasPeuckerRing: douglasPeuckerRing };
});
