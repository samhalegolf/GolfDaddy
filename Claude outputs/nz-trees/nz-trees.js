/* Clarity Caddy - New Zealand course trees.
 *
 * One generator for every tree, used by both the .glb export (build-glb.mjs) and the
 * Design canvas preview, so the shipped models and the preview can never drift apart.
 *
 * Every model is:
 *   - real-world metres, Y up, origin at the base of the main trunk
 *   - flat-shaded low poly: a plain triangle list with face normals
 *   - vertex coloured (COLOR_0, linear), no textures, one material, double sided
 *   - deterministic: the same species + variant always gives the same tree
 *
 * build(id, opts) -> { id, name, positions, normals, colors, triangles, meta }
 *   opts.flowering  pōhutukawa only - crimson on the sunny side of the crown
 *   opts.seed       optional override for a different individual of the same species
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NZTrees = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------------------------------------------- maths */

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 1, 0]; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  /* A direction from a compass angle (degrees) and an angle above the horizon (degrees). */
  function dir(yawDeg, upDeg) {
    var y = yawDeg * Math.PI / 180, p = upDeg * Math.PI / 180;
    return [Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y)];
  }

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function range(r, lo, hi) { return lo + (hi - lo) * r(); }

  /* ---------------------------------------------------------------- colour (authored sRGB) */

  function hex(h) {
    var n = parseInt(h.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function tint(c, s) { return [clamp(c[0] * s, 0, 1), clamp(c[1] * s, 0, 1), clamp(c[2] * s, 0, 1)]; }
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function toLinear(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }

  var C = {
    bark: hex("#5b4734"), barkDark: hex("#3e3227"), barkGrey: hex("#6e6558"),
    gumBark: hex("#d3cbb7"), gumPatch: hex("#a0947c"),
    cabbageTrunk: hex("#6d5c48"),
    radiata: hex("#33502d"), macrocarpa: hex("#2a4529"), poplar: hex("#6e9139"),
    willow: hex("#93aa4c"), gum: hex("#7f9479"), pohutukawa: hex("#2f4d2e"),
    pohutukawaUnder: hex("#76826c"), flower: hex("#b3192a"),
    cabbageLeaf: hex("#879646"), cabbageDead: hex("#a88f5c"), broadleaf: hex("#3f6c33"),
    figure: hex("#2b3440")
  };

  /* ---------------------------------------------------------------- mesh */

  function Mesh() { this.p = []; this.n = []; this.c = []; }
  Mesh.prototype.tri = function (a, b, c, col) {
    var n = cross(sub(b, a), sub(c, a));
    if (len(n) < 1e-10) return;
    n = norm(n);
    var vs = [a, b, c];
    for (var i = 0; i < 3; i++) {
      this.p.push(vs[i][0], vs[i][1], vs[i][2]);
      this.n.push(n[0], n[1], n[2]);
      this.c.push(col[0], col[1], col[2]);
    }
  };

  /* Icosahedron (detail 0, 20 faces) and once-subdivided icosphere (detail 1, 80 faces). */
  var ICO = (function () {
    var t = (1 + Math.sqrt(5)) / 2;
    var v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
    var f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
      [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    var nv = v.slice(), cache = {}, nf = [];
    function mid(a, b) {
      var k = a < b ? a + "_" + b : b + "_" + a;
      if (cache[k] != null) return cache[k];
      nv.push(norm(mul(add(v[a], v[b]), 0.5)));
      return (cache[k] = nv.length - 1);
    }
    f.forEach(function (tr) {
      var a = tr[0], b = tr[1], c = tr[2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    });
    return [{ v: v, f: f }, { v: nv, f: nf }];
  })();

  /* A lumpy foliage clump: a jittered ellipsoid, darker underneath, a little colour noise per face.
     o: {c, rad:[rx,ry,rz], col, jit, detail, low, high, taperDown, taperUp, sag, face(n, centre, col, r)} */
  function blob(m, r, o) {
    var ico = ICO[o.detail == null ? 1 : o.detail];
    var jit = o.jit == null ? 0.22 : o.jit;
    var pts = ico.v.map(function (u) {
      var k = 1 + (r() - 0.5) * 2 * jit;
      var sx = 1;
      if (u[1] < 0 && o.taperDown) sx = 1 + u[1] * o.taperDown;
      if (u[1] > 0 && o.taperUp) sx = 1 - u[1] * o.taperUp;
      var y = u[1] * o.rad[1] * k;
      if (o.sag) y -= o.sag * (1 - Math.abs(u[1])) * o.rad[1];
      return [o.c[0] + u[0] * o.rad[0] * k * sx, o.c[1] + y, o.c[2] + u[2] * o.rad[2] * k * sx];
    });
    var bottom = o.c[1] - o.rad[1], height = 2 * o.rad[1];
    ico.f.forEach(function (tr) {
      var a = pts[tr[0]], b = pts[tr[1]], c = pts[tr[2]];
      var cen = mul(add(add(a, b), c), 1 / 3);
      var n = cross(sub(b, a), sub(c, a));
      if (dot(n, sub(cen, o.c)) < 0) { var s = b; b = c; c = s; n = mul(n, -1); }
      n = norm(n);
      var ty = clamp((cen[1] - bottom) / height, 0, 1);
      var col = tint(o.col, lerp(o.low == null ? 0.7 : o.low, o.high == null ? 1.06 : o.high, ty) * (1 + (r() - 0.5) * 0.14));
      if (o.face) col = o.face(n, cen, col, r);
      m.tri(a, b, c, col);
    });
  }

  /* A tapered tube along a path - trunks and limbs. Parallel-transported rings so it never twists. */
  function tube(m, r, pts, r0, r1, sides, col, opts) {
    opts = opts || {};
    var rings = [], prevU = null, n = pts.length;
    for (var i = 0; i < n; i++) {
      var t = norm(sub(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]));
      var u;
      if (prevU) u = norm(sub(prevU, mul(t, dot(prevU, t))));
      else u = norm(cross(t, Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      prevU = u;
      var w = cross(t, u);
      var rad = lerp(r0, r1, Math.pow(i / (n - 1), opts.taperPow || 1));
      if (i === 0 && opts.flare) rad *= opts.flare;
      var ring = [];
      for (var s = 0; s < sides; s++) {
        var ang = (s / sides) * Math.PI * 2;
        var rr = rad * (1 + (r() - 0.5) * 0.14);
        ring.push(add(pts[i], add(mul(u, Math.cos(ang) * rr), mul(w, Math.sin(ang) * rr))));
      }
      rings.push(ring);
    }
    for (var j = 0; j < n - 1; j++) {
      for (var k = 0; k < sides; k++) {
        var a = rings[j][k], b = rings[j][(k + 1) % sides], c = rings[j + 1][(k + 1) % sides], d = rings[j + 1][k];
        var cc = opts.colour ? opts.colour(j / (n - 1), k, r) : tint(col, 0.92 + r() * 0.16);
        m.tri(a, b, c, cc);
        m.tri(a, c, d, cc);
      }
    }
    var last = rings[n - 1], tip = add(pts[n - 1], mul(norm(sub(pts[n - 1], pts[n - 2])), r1 * 0.6));
    for (var q = 0; q < sides; q++) m.tri(last[q], last[(q + 1) % sides], tip, col);
  }

  /* A wandering limb path from start along d. droop bends it down as it goes (negative lifts it). */
  function limb(r, start, d, length, segs, wobble, droop) {
    var pts = [start], p = start, dd = norm(d);
    for (var i = 1; i <= segs; i++) {
      dd = norm(add(dd, [(r() - 0.5) * wobble, -(droop || 0), (r() - 0.5) * wobble]));
      p = add(p, mul(dd, length / segs));
      pts.push(p);
    }
    return pts;
  }
  function end(pts) { return pts[pts.length - 1]; }
  function along(pts, t) {
    var f = t * (pts.length - 1), i = Math.min(Math.floor(f), pts.length - 2), k = f - i;
    return add(pts[i], mul(sub(pts[i + 1], pts[i]), k));
  }

  /* A strap leaf in two bends: base, a drooping middle, a tip. */
  function blade(m, r, base, d, length, width, col, droop) {
    d = norm(d);
    var side = cross(d, [0, 1, 0]);
    side = len(side) < 1e-3 ? [1, 0, 0] : norm(side);
    var tw = (r() - 0.5) * 2.4, up = cross(side, d);
    side = norm(add(mul(side, Math.cos(tw)), mul(up, Math.sin(tw))));
    var mid = add(add(base, mul(d, length * 0.5)), [0, -droop * 0.22 * length, 0]);
    var tip = add(add(base, mul(d, length)), [0, -droop * length, 0]);
    var l = add(mid, mul(side, width)), rr = add(mid, mul(side, -width));
    var bl = add(base, mul(side, width * 0.35)), br = add(base, mul(side, -width * 0.35));
    m.tri(bl, br, rr, col);
    m.tri(bl, rr, l, col);
    m.tri(l, rr, tip, tint(col, 1.08));
  }

  /* ---------------------------------------------------------------- species */

  function radiata(m, r) {
    var trunk = limb(r, [0, 0, 0], [0.02, 1, 0.01], 26, 8, 0.05, 0);
    tube(m, r, trunk, 0.62, 0.1, 8, C.bark, { flare: 1.35, colour: function (t, k, rr) { return tint(mix(C.barkDark, C.bark, t), 0.9 + rr() * 0.2); } });
    /* Long bare trunk, then a high, ragged, layered crown of flattened bough clumps. */
    var tiers = 9;
    for (var i = 0; i < tiers; i++) {
      var t = 0.52 + (i / (tiers - 1)) * 0.42, at = along(trunk, t);
      var yaw = i * 137.5 + range(r, -20, 20), reach = lerp(6.2, 2.6, i / (tiers - 1)) * range(r, 0.85, 1.15);
      var arm = limb(r, at, dir(yaw, range(r, 18, 38)), reach, 3, 0.2, 0.04);
      tube(m, r, arm, 0.2, 0.06, 5, C.barkDark);
      var tip = end(arm);
      blob(m, r, { c: add(tip, [0, 0.3, 0]), rad: [range(r, 2.9, 3.6), range(r, 1.5, 1.9), range(r, 2.9, 3.6)], col: C.radiata, jit: 0.3, low: 0.6 });
      blob(m, r, { c: add(along(arm, 0.5), [0, 0.7, 0]), rad: [2.2, 1.4, 2.2], col: C.radiata, jit: 0.3, low: 0.5 });
    }
    blob(m, r, { c: add(end(trunk), [0, -0.6, 0]), rad: [3.2, 2.2, 3.2], col: C.radiata, jit: 0.28, low: 0.7, high: 1.12 });
  }

  function macrocarpa(m, r) {
    var trunk = limb(r, [0, 0, 0], [0.05, 1, 0], 3.8, 3, 0.08, 0);
    tube(m, r, trunk, 1.0, 0.75, 9, C.barkGrey, { flare: 1.4 });
    var top = end(trunk);
    /* Several heavy limbs, leaning with the wind (to +x). */
    var limbs = [[-30, 52], [60, 48], [150, 55], [230, 50], [310, 60]];
    limbs.forEach(function (l) {
      var arm = limb(r, top, add(dir(l[0], l[1]), [0.25, 0, 0]), range(r, 6, 8.5), 4, 0.25, 0.02);
      tube(m, r, arm, 0.5, 0.15, 6, C.barkGrey);
    });
    /* A dense, flat-topped, wind-sheared mass: big clumps, top pressed down, swept downwind. */
    for (var i = 0; i < 18; i++) {
      var a = r() * Math.PI * 2, d = Math.sqrt(r());
      var x = Math.cos(a) * d * 8.2 + 1.4, z = Math.sin(a) * d * 6.8;
      var y = 9.5 + (1 - d * d) * 5.2 + (x / 8) * 1.1 + range(r, -0.6, 0.6);
      blob(m, r, { c: [x, y, z], rad: [range(r, 3.0, 3.8), range(r, 2.2, 2.8), range(r, 3.0, 3.8)], col: C.macrocarpa, jit: 0.2, low: 0.55, high: 1.0 });
    }
    for (var j = 0; j < 5; j++) {
      var aa = (j / 5) * Math.PI * 2 + r();
      blob(m, r, { c: [Math.cos(aa) * 6.5 + 1, range(r, 6.5, 8), Math.sin(aa) * 5.4], rad: [2.6, 1.8, 2.6], col: C.macrocarpa, jit: 0.22, low: 0.5, high: 0.9 });
    }
  }

  function poplar(m, r) {
    var trunk = limb(r, [0, 0, 0], [0, 1, 0], 21, 6, 0.02, 0);
    tube(m, r, trunk, 0.42, 0.08, 7, C.barkGrey, { flare: 1.25 });
    /* Lombardy: a narrow, tapering column of upward-swept clumps. */
    var n = 12;
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1), y = lerp(3.4, 22.2, t);
      var w = 2.7 * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * t)), 0.75) + 0.35;
      var a = r() * Math.PI * 2, off = range(r, 0, 0.35) * w;
      blob(m, r, {
        c: [Math.cos(a) * off, y, Math.sin(a) * off], rad: [w, range(r, 1.9, 2.4), w * range(r, 0.85, 1.05)],
        col: C.poplar, jit: 0.24, taperUp: 0.35, low: lerp(0.62, 0.85, t), high: 1.1
      });
    }
  }

  function willow(m, r) {
    var trunk = limb(r, [0, 0, 0], [0.18, 1, 0.05], 3.2, 3, 0.1, 0);
    tube(m, r, trunk, 0.7, 0.5, 8, C.barkGrey, { flare: 1.35 });
    var top = end(trunk), tips = [];
    for (var i = 0; i < 5; i++) {
      var arm = limb(r, top, dir(i * 72 + range(r, -15, 15), range(r, 45, 62)), range(r, 5.5, 7), 4, 0.25, 0.05);
      tube(m, r, arm, 0.36, 0.1, 6, C.barkGrey);
      tips.push(end(arm));
    }
    /* A soft dome on top ... */
    tips.forEach(function (p) {
      blob(m, r, { c: add(p, [0, 0.2, 0]), rad: [3.2, 1.5, 3.2], col: C.willow, jit: 0.16, low: 0.75, high: 1.1 });
    });
    blob(m, r, { c: [0.6, 10.2, 0.2], rad: [3.2, 1.6, 3.2], col: C.willow, jit: 0.2, low: 0.8, high: 1.12 });
    /* ... and the curtain: long hanging tresses round the rim, narrowing to the ground. */
    var strands = 26;
    for (var k = 0; k < strands; k++) {
      var a = (k / strands) * Math.PI * 2 + range(r, -0.1, 0.1);
      var rad = range(r, 5.0, 6.2), topY = range(r, 8.2, 9.4), bottomY = range(r, 1.0, 2.2);
      var hy = (topY - bottomY) / 2, w = range(r, 1.3, 1.7);
      /* flattened along the rim so neighbours overlap into one curtain */
      var ca = Math.cos(a), sa = Math.sin(a);
      blob(m, r, {
        c: [ca * rad + 0.6, bottomY + hy, sa * rad], rad: [Math.abs(sa) * w + Math.abs(ca) * w * 0.7, hy, Math.abs(ca) * w + Math.abs(sa) * w * 0.7],
        col: C.willow, jit: 0.1, taperDown: 0.35, low: 0.6, high: 1.0
      });
    }
  }

  function eucalyptus(m, r) {
    var gum = function (t, k, rr) { return rr() < 0.3 ? tint(C.gumPatch, 0.9 + rr() * 0.2) : tint(C.gumBark, 0.92 + rr() * 0.12); };
    var trunk = limb(r, [0, 0, 0], [0.06, 1, -0.03], 9, 4, 0.12, 0);
    tube(m, r, trunk, 0.66, 0.42, 8, C.gumBark, { flare: 1.3, colour: gum });
    var tips = [];
    /* Forks into leaders that fork again: tall, open and uneven. */
    [[20, 70], [160, 66], [270, 74]].forEach(function (l) {
      var lead = limb(r, end(trunk), dir(l[0] + range(r, -20, 20), l[1]), range(r, 7, 10), 4, 0.3, 0);
      tube(m, r, lead, 0.36, 0.16, 6, C.gumBark, { colour: gum });
      for (var j = 0; j < 2; j++) {
        var br = limb(r, end(lead), dir(l[0] + (j ? 50 : -50) + range(r, -25, 25), range(r, 40, 65)), range(r, 3.5, 6), 3, 0.35, 0.02);
        tube(m, r, br, 0.15, 0.05, 5, C.gumBark, { colour: gum });
        tips.push(end(br));
      }
      tips.push(add(end(lead), [0, 0.8, 0]));
    });
    /* Sparse, ragged, blue-grey clumps with sky between them. */
    tips.forEach(function (p) {
      blob(m, r, { c: p, rad: [range(r, 2.0, 2.9), range(r, 1.3, 1.9), range(r, 2.0, 2.9)], col: C.gum, jit: 0.42, low: 0.68, high: 1.08 });
      if (r() < 0.6) blob(m, r, { c: add(p, [range(r, -2, 2), range(r, -2.2, -1), range(r, -2, 2)]), rad: [1.3, 0.9, 1.3], col: C.gum, jit: 0.4, detail: 0, low: 0.65 });
    });
  }

  function pohutukawa(m, r, opts) {
    var flowering = !!(opts && opts.flowering);
    /* Several stout trunks leaning out from one base, each splitting into limbs. */
    var limbsEnd = [];
    for (var i = 0; i < 4; i++) {
      var yaw = i * 90 + range(r, -25, 25);
      var stem = limb(r, [0, 0, 0], dir(yaw, range(r, 42, 58)), range(r, 4.2, 5.6), 4, 0.2, -0.02);
      tube(m, r, stem, 0.55, 0.32, 7, C.barkGrey, { flare: 1.2 });
      for (var j = 0; j < 2; j++) {
        var arm = limb(r, end(stem), dir(yaw + (j ? 35 : -35), range(r, 25, 45)), range(r, 3.5, 5), 3, 0.3, 0.03);
        tube(m, r, arm, 0.28, 0.1, 6, C.barkGrey);
        limbsEnd.push(end(arm));
      }
    }
    /* A broad, low dome: much wider than tall. Silvery leaf undersides; crimson when flowering. */
    /* Always draw the same two numbers, so the flowering tree is the same tree, just in bloom. */
    var face = function (n, cen, col, rr) {
      var roll = rr(), shade = rr();
      if (n[1] < -0.35) return mix(col, C.pohutukawaUnder, 0.55);
      if (flowering && n[1] > 0.3 && roll < 0.38) return tint(C.flower, 0.82 + shade * 0.25);
      return col;
    };
    for (var k = 0; k < 20; k++) {
      var a = r() * Math.PI * 2, d = Math.sqrt(r());
      var x = Math.cos(a) * d * 8.6, z = Math.sin(a) * d * 8.6;
      var y = 6.4 + Math.sqrt(Math.max(0, 1 - d * d * 0.92)) * 5.4;
      blob(m, r, { c: [x, y, z], rad: [range(r, 3.0, 3.6), range(r, 2.0, 2.5), range(r, 3.0, 3.6)], col: C.pohutukawa, jit: 0.2, low: 0.6, high: 1.05, face: face });
    }
    limbsEnd.forEach(function (p) {
      blob(m, r, { c: add(p, [0, 0.2, 0]), rad: [2.6, 1.6, 2.6], col: C.pohutukawa, jit: 0.22, low: 0.55, high: 1.0, face: face });
    });
  }

  function cabbageTree(m, r) {
    var trunk = limb(r, [0, 0, 0], [0.04, 1, 0], 3.1, 3, 0.06, 0);
    tube(m, r, trunk, 0.3, 0.22, 7, C.cabbageTrunk, { flare: 1.35 });
    /* Forks into a few stiff, upright branches, some forking again; a tuft at every tip. */
    var tips = [];
    for (var i = 0; i < 3; i++) {
      var br = limb(r, end(trunk), dir(i * 120 + range(r, -25, 25), range(r, 58, 72)), range(r, 1.4, 2.1), 2, 0.12, 0);
      tube(m, r, br, 0.15, 0.11, 6, C.cabbageTrunk);
      if (r() < 0.6) {
        for (var j = 0; j < 2; j++) {
          var b2 = limb(r, end(br), dir(i * 120 + (j ? 30 : -30), range(r, 62, 78)), range(r, 0.8, 1.3), 2, 0.1, 0);
          tube(m, r, b2, 0.1, 0.08, 5, C.cabbageTrunk);
          tips.push(end(b2));
        }
      } else tips.push(end(br));
    }
    tips.forEach(function (p) {
      /* Live leaves: long straps bursting from the tip, the lower ones arching over. */
      for (var k = 0; k < 34; k++) {
        var up = range(r, -15, 80), yaw = r() * 360;
        var droop = lerp(0.55, 0.05, (up + 15) / 95);
        blade(m, r, p, dir(yaw, up), range(r, 0.8, 1.05), 0.06, tint(C.cabbageLeaf, range(r, 0.85, 1.12)), droop);
      }
      /* Dead leaves: a brown skirt hanging under the tuft. */
      for (var q = 0; q < 10; q++) {
        blade(m, r, add(p, [0, -0.08, 0]), dir(r() * 360, range(r, -80, -55)), range(r, 0.6, 0.85), 0.04, tint(C.cabbageDead, range(r, 0.85, 1.1)), 0.05);
      }
    });
  }

  function nativeBroadleaf(m, r) {
    var trunk = limb(r, [0, 0, 0], [0.03, 1, 0.02], 3.0, 3, 0.08, 0);
    tube(m, r, trunk, 0.4, 0.3, 7, C.bark, { flare: 1.3 });
    for (var i = 0; i < 3; i++) {
      var arm = limb(r, end(trunk), dir(i * 120 + range(r, -20, 20), range(r, 45, 60)), range(r, 2.6, 3.4), 3, 0.2, 0);
      tube(m, r, arm, 0.22, 0.08, 6, C.bark);
    }
    /* A dense, rounded evergreen crown, glossier on top. */
    var face = function (n, cen, col) { return n[1] > 0.55 ? tint(col, 1.12) : col; };
    for (var k = 0; k < 11; k++) {
      var a = r() * Math.PI * 2, d = Math.sqrt(r());
      var x = Math.cos(a) * d * 3.2, z = Math.sin(a) * d * 3.2;
      var y = 6.0 + Math.sqrt(Math.max(0, 1 - d * d)) * 2.2 + range(r, -0.4, 0.4);
      blob(m, r, { c: [x, y, z], rad: [range(r, 2.0, 2.5), range(r, 1.7, 2.1), range(r, 2.0, 2.5)], col: C.broadleaf, jit: 0.18, low: 0.6, high: 1.06, face: face });
    }
  }

  /* id, display name, botanical name, seed, builder, nearest of the app's billboard types
     (0 round, 1 broadleaf, 2 pine, 3 yellow-green) for anywhere that still draws billboards. */
  var SPECIES = [
    { id: "radiata-pine", name: "Radiata pine", botanical: "Pinus radiata", seed: 11, build: radiata, billboardType: 2 },
    { id: "macrocarpa", name: "Macrocarpa", botanical: "Cupressus macrocarpa", seed: 23, build: macrocarpa, billboardType: 1 },
    { id: "poplar", name: "Poplar", botanical: "Populus nigra 'Italica'", seed: 37, build: poplar, billboardType: 3 },
    { id: "willow", name: "Willow", botanical: "Salix babylonica", seed: 41, build: willow, billboardType: 3 },
    { id: "eucalyptus", name: "Eucalyptus", botanical: "Eucalyptus spp.", seed: 53, build: eucalyptus, billboardType: 0 },
    { id: "pohutukawa", name: "Pōhutukawa", botanical: "Metrosideros excelsa", seed: 67, build: pohutukawa, billboardType: 1 },
    { id: "cabbage-tree", name: "Cabbage tree / tī kōuka", botanical: "Cordyline australis", seed: 79, build: cabbageTree, billboardType: 3 },
    { id: "native-broadleaf", name: "Native broadleaf", botanical: "generic evergreen", seed: 83, build: nativeBroadleaf, billboardType: 0 }
  ];
  var BY_ID = {};
  SPECIES.forEach(function (s) { BY_ID[s.id] = s; });

  function finish(m, info) {
    var positions = new Float32Array(m.p), normals = new Float32Array(m.n), colors = new Float32Array(m.c.length);
    for (var i = 0; i < m.c.length; i++) colors[i] = toLinear(m.c[i]);
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var j = 0; j < positions.length; j += 3) {
      for (var a = 0; a < 3; a++) {
        if (positions[j + a] < min[a]) min[a] = positions[j + a];
        if (positions[j + a] > max[a]) max[a] = positions[j + a];
      }
    }
    var crown = ((max[0] - min[0]) + (max[2] - min[2])) / 4;
    return {
      id: info.id, name: info.name, positions: positions, normals: normals, colors: colors,
      triangles: positions.length / 9,
      meta: {
        species: info.id, name: info.name, botanical: info.botanical, variant: info.variant || null,
        heightM: +max[1].toFixed(2), crownRadiusM: +crown.toFixed(2),
        bounds: { min: min.map(function (v) { return +v.toFixed(3); }), max: max.map(function (v) { return +v.toFixed(3); }) },
        billboardType: info.billboardType
      }
    };
  }

  function build(id, opts) {
    var s = BY_ID[id];
    if (!s) throw new Error("unknown tree: " + id);
    opts = opts || {};
    var m = new Mesh();
    s.build(m, rng(opts.seed != null ? opts.seed : s.seed), opts);
    return finish(m, { id: s.id, name: s.name, botanical: s.botanical, billboardType: s.billboardType, variant: opts.flowering ? "flowering" : null });
  }

  /* A 1.8 m figure for scale in previews (not exported). */
  function figure() {
    var m = new Mesh(), r = rng(5);
    tube(m, r, [[-0.12, 0, 0], [-0.1, 0.85, 0]], 0.09, 0.1, 6, C.figure);
    tube(m, r, [[0.12, 0, 0], [0.1, 0.85, 0]], 0.09, 0.1, 6, C.figure);
    tube(m, r, [[0, 0.8, 0], [0, 1.5, 0]], 0.2, 0.17, 7, C.figure);
    blob(m, r, { c: [0, 1.66, 0], rad: [0.12, 0.14, 0.12], col: C.figure, jit: 0, detail: 1, low: 1, high: 1 });
    return finish(m, { id: "figure", name: "1.8 m figure" });
  }

  return { SPECIES: SPECIES.map(function (s) { return { id: s.id, name: s.name, botanical: s.botanical, billboardType: s.billboardType }; }), build: build, figure: figure };
});
