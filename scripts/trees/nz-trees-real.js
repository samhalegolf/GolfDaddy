/* Clarity Caddy - New Zealand course trees, realistic set (for the photo / aerial 3D map).
 *
 * The low-poly set (nz-trees.js) is for the watch maps and far distances. This one is for the
 * photo map up close: a real branch skeleton, tiling bark textures, and foliage made of
 * alpha-cut "cards" painted with leaves, needles or sprays for each species.
 *
 * Same rules as the low-poly set: real-world metres, Y up, origin at the base of the main trunk,
 * deterministic per species. One generator feeds both the .glb export (build-glb-real.mjs) and
 * the Design canvas preview, so they always match.
 *
 * build(id, opts) -> {
 *   id, name, meta,
 *   bark:   { positions, normals, uvs, colors, indices }   textures.bark   tiles (REPEAT)
 *   leaves: { positions, normals, uvs, colors, indices }   textures.leaves alpha-cut (MASK 0.45)
 *   textures: { bark: {width, height, data:Uint8Array RGBA}, leaves: {...} }
 * }
 * opts.flowering  pōhutukawa in bloom    opts.seed  another individual of the same species
 *
 * Foliage lighting: each card's normal points out from the crown's centre, not along the
 * card, so a crown shades like one soft volume (bright sunny side, dark core) instead of a
 * pile of flat cards. Every card is written front and back with the same normal, so the
 * material is single-sided and no engine flips those normals. Vertex colour holds ambient
 * occlusion (darker deep inside and low in the crown) and multiplies the texture.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NZTreesReal = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PI = Math.PI, TAU = PI * 2;

  /* ------------------------------------------------------------------ maths */
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 1, 0]; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function mixc(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function scalec(c, s) { return [c[0] * s, c[1] * s, c[2] * s]; }

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rr(r, lo, hi) { return lo + (hi - lo) * r(); }
  function pick(r, list) { return list[Math.floor(r() * list.length) % list.length]; }
  function randUnit(r) {
    var z = rr(r, -1, 1), a = r() * TAU, s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), z, s * Math.sin(a)];
  }
  function hex(h) {
    var n = parseInt(h.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function toLinear(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }

  /* Integer hash -> [0,1), and tiling value noise for bark. */
  function ihash(x, y, s) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function pnoise(x, y, px, py, s) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    function h(i, j) { return ihash(((i % px) + px) % px, ((j % py) + py) % py, s); }
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
  }
  function pfbm(u, v, px, py, oct, s) {
    var t = 0, a = 0.5, f = 1, n = 0;
    for (var o = 0; o < oct; o++) { t += a * pnoise(u * px * f, v * py * f, px * f, py * f, s + o * 17); n += a; a *= 0.5; f *= 2; }
    return t / n;
  }

  /* ------------------------------------------------------------------ painter */

  function Img(w, h, bg) {
    this.w = w; this.h = h; this.d = new Float32Array(w * h * 4);
    for (var i = 0; i < w * h; i++) { this.d[i * 4] = bg[0]; this.d[i * 4 + 1] = bg[1]; this.d[i * 4 + 2] = bg[2]; }
    this.clip = [0, 0, w, h];
  }
  Img.prototype.put = function (x, y, c, a) {
    if (a <= 0.003) return;
    var i = (y * this.w + x) * 4, d = this.d, da = d[i + 3], oa = a + da * (1 - a), k = a / oa;
    d[i] += (c[0] - d[i]) * k; d[i + 1] += (c[1] - d[i + 1]) * k; d[i + 2] += (c[2] - d[i + 2]) * k; d[i + 3] = oa;
  };
  Img.prototype.box = function (x0, y0, x1, y1) {
    var c = this.clip;
    return [Math.max(c[0], Math.floor(x0)), Math.max(c[1], Math.floor(y0)), Math.min(c[2], Math.ceil(x1)), Math.min(c[3], Math.ceil(y1))];
  };
  Img.prototype.rgba = function () {
    var out = new Uint8Array(this.w * this.h * 4);
    for (var i = 0; i < out.length; i++) out[i] = Math.round(clamp(this.d[i], 0, 1) * 255);
    return { width: this.w, height: this.h, data: out };
  };

  function grain(x, y) { return (ihash(x, y, 99) - 0.5) * 0.06; }

  /* A tapered stroke from (x0,y0) to (x1,y1), widths in px. */
  function stroke(img, x0, y0, x1, y1, w0, w1, col, alpha) {
    var pad = Math.max(w0, w1) / 2 + 1.5, b = img.box(Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad);
    var dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
    for (var y = b[1]; y < b[3]; y++) for (var x = b[0]; x < b[2]; x++) {
      var px = x + 0.5 - x0, py = y + 0.5 - y0, t = clamp((px * dx + py * dy) / L2, 0, 1);
      var ex = px - dx * t, ey = py - dy * t, d = Math.sqrt(ex * ex + ey * ey) - lerp(w0, w1, t) / 2;
      var cov = clamp(0.5 - d, 0, 1);
      if (cov > 0) { var g = 1 + grain(x, y); img.put(x, y, [col[0] * g, col[1] * g, col[2] * g], cov * (alpha == null ? 1 : alpha)); }
    }
  }
  function polyline(img, pts, w0, w1, col) {
    for (var i = 0; i < pts.length - 1; i++) {
      stroke(img, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], lerp(w0, w1, i / (pts.length - 1)), lerp(w0, w1, (i + 1) / (pts.length - 1)), col);
    }
  }
  function disc(img, cx, cy, rad, col, alpha) {
    var b = img.box(cx - rad - 1, cy - rad - 1, cx + rad + 1, cy + rad + 1);
    for (var y = b[1]; y < b[3]; y++) for (var x = b[0]; x < b[2]; x++) {
      var d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - rad, cov = clamp(0.5 - d, 0, 1);
      if (cov > 0) img.put(x, y, col, cov * (alpha == null ? 1 : alpha));
    }
  }

  var PROFILE = {
    oval: function (u) { return Math.pow(Math.sin(PI * u), 0.7); },
    lance: function (u) { return Math.pow(Math.sin(PI * Math.pow(u, 0.85)), 1.25); },
    delta: function (u) { return u < 0.18 ? Math.sqrt(u / 0.18) : Math.pow((1 - u) / 0.82, 0.85); },
    strap: function (u) { return u < 0.04 ? 0.55 + u * 11 : u > 0.82 ? Math.pow((1 - u) / 0.18, 0.8) : 1; },
    scale: function (u) { return Math.pow(Math.sin(PI * u), 0.5); }
  };

  /* One leaf from its base, pointing at `ang` (radians, image space), L long, W half-wide.
     o: {profile, bend, rib (colour), fold (two-tone across the midrib), tip (colour at the tip), veins} */
  function leaf(img, bx, by, ang, L, W, col, o) {
    o = o || {};
    var prof = PROFILE[o.profile || "oval"], bend = o.bend || 0, fold = o.fold == null ? 0.08 : o.fold;
    var ca = Math.cos(ang), sa = Math.sin(ang), pad = W + Math.abs(bend) * L + 2;
    var tx = bx + ca * L, ty = by + sa * L;
    var b = img.box(Math.min(bx, tx) - pad, Math.min(by, ty) - pad, Math.max(bx, tx) + pad, Math.max(by, ty) + pad);
    for (var y = b[1]; y < b[3]; y++) for (var x = b[0]; x < b[2]; x++) {
      var dx = x + 0.5 - bx, dy = y + 0.5 - by, al = dx * ca + dy * sa, ac = -dx * sa + dy * ca;
      var u = al / L;
      if (u < 0 || u > 1) continue;
      var centre = bend * L * 4 * u * (1 - u), off = ac - centre, hw = W * prof(u);
      var cov = clamp(0.5 - (Math.abs(off) - hw), 0, 1);
      if (cov <= 0) continue;
      var c = col;
      if (o.tip) c = mixc(c, o.tip, u * u);
      c = scalec(c, 1 + (off >= 0 ? fold : -fold) * (0.6 + 0.4 * Math.abs(off) / Math.max(hw, 0.5)));
      if (o.rib) c = mixc(c, o.rib, clamp(1 - Math.abs(off) / 0.9, 0, 1) * (u < 0.92 ? 0.75 : 0));
      if (o.veins) {
        var vv = Math.abs(Math.sin((Math.abs(off) / Math.max(W, 1)) * o.veins * PI));
        c = scalec(c, 1 + 0.08 * (vv > 0.85 ? 1 : 0));
      }
      if (o.edge) c = scalec(c, 1 - o.edge * smooth(-1.2, 0, Math.abs(off) - hw));
      var g = 1 + grain(x, y);
      img.put(x, y, [c[0] * g, c[1] * g, c[2] * g], cov);
    }
  }

  /* A wandering 2D path in image space from (x,y) heading `ang`, n steps of `step` px. */
  function path2(r, x, y, ang, n, step, wob, curl) {
    var pts = [[x, y]];
    for (var i = 0; i < n; i++) {
      ang += rr(r, -wob, wob) + (curl || 0);
      x += Math.cos(ang) * step; y += Math.sin(ang) * step;
      pts.push([x, y]);
    }
    return pts;
  }
  function pointOn(pts, t) {
    var f = t * (pts.length - 1), i = Math.min(Math.floor(f), pts.length - 2), k = f - i;
    return [lerp(pts[i][0], pts[i + 1][0], k), lerp(pts[i][1], pts[i + 1][1], k), Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0])];
  }

  /* --------------------------------------------------- leaf atlas painters (one cell each) */

  /* Broad leaves on a twig: native broadleaf, pōhutukawa, poplar. */
  function paintBroad(img, ox, oy, cw, ch, cell, r, P) {
    var cx = ox + cw / 2, leaves = [], twigs = [];
    var main = path2(r, cx + rr(r, -0.08, 0.08) * cw, oy + ch * 0.9, -PI / 2 + rr(r, -0.25, 0.25), 8, ch * 0.09, 0.12);
    twigs.push([main, 6, 2.2]);
    var sides = P.sides || 7;
    for (var i = 0; i < sides; i++) {
      var at = pointOn(main, 0.12 + (i / sides) * 0.85), side = i % 2 ? 1 : -1;
      var sang = at[2] + side * rr(r, 0.55, 1.05), slen = cw * rr(r, 0.12, 0.22) * (1 - i / sides * 0.4);
      var sp = path2(r, at[0], at[1], sang, 3, slen / 3, 0.15);
      twigs.push([sp, 3, 1.2]);
      var tip = sp[sp.length - 1], tipAng = sang;
      var n = P.perTwig[0] + Math.floor(r() * (P.perTwig[1] - P.perTwig[0] + 1));
      for (var k = 0; k < n; k++) {
        var on = k < n * 0.4 ? pointOn(sp, rr(r, 0.2, 0.9)) : [tip[0], tip[1], tipAng];
        leaves.push({ x: on[0], y: on[1], a: on[2] + rr(r, -1.3, 1.3), L: P.L * rr(r, 0.7, 1.1), depth: r() });
      }
    }
    var tipM = main[main.length - 1];
    for (var t = 0; t < (P.tipLeaves || 5); t++) leaves.push({ x: tipM[0], y: tipM[1], a: -PI / 2 + rr(r, -1.2, 1.2), L: P.L * rr(r, 0.6, 0.95), depth: r() });
    twigs.forEach(function (tw) { polyline(img, tw[0], tw[1], tw[2], P.twig); });
    leaves.sort(function (a, b) { return a.depth - b.depth; });
    leaves.forEach(function (lf) {
      var col = mixc(P.dark, P.light, lf.depth * 0.8 + r() * 0.2);
      if (P.under && r() < P.underChance) col = mixc(P.under, P.dark, r() * 0.3);
      if (P.petiole) {
        var pe = P.petiole * rr(r, 0.7, 1.2), px = lf.x + Math.cos(lf.a) * pe, py = lf.y + Math.sin(lf.a) * pe;
        stroke(img, lf.x, lf.y, px, py, 1.6, 1.2, P.petioleCol || P.twig);
        lf.x = px; lf.y = py;
      }
      leaf(img, lf.x, lf.y, lf.a, lf.L, lf.L * P.W * rr(r, 0.85, 1.1), col, { profile: P.profile, rib: P.rib, fold: P.fold, bend: rr(r, -0.06, 0.06), tip: P.tip, edge: 0.25 });
    });
    if (P.flowers && cell >= 2) {
      var count = 2 + Math.floor(r() * 3);
      for (var f = 0; f < count; f++) {
        var at2 = f === 0 ? [tipM[0], tipM[1]] : pointOn(twigs[1 + Math.floor(r() * (twigs.length - 1))][0], 1);
        pompom(img, at2[0], at2[1], rr(r, 0.085, 0.12) * cw, r, P.flowers);
      }
    }
  }

  /* A pōhutukawa flower head: a burst of crimson stamens tipped with gold. */
  function pompom(img, x, y, R, r, F) {
    for (var i = 0; i < 90; i++) {
      var a = -PI / 2 + rr(r, -1.9, 1.9), l = R * rr(r, 0.45, 1), ex = x + Math.cos(a) * l, ey = y + Math.sin(a) * l;
      stroke(img, x, y, ex, ey, 2.2, 1.2, mixc(F.deep, F.red, r()));
      disc(img, ex, ey, 1.6, F.gold, 0.95);
    }
  }

  /* Radiata: twigs thick with long needles in threes, and a bushy tuft at each tip. */
  function paintNeedles(img, ox, oy, cw, ch, cell, r, P) {
    var twigN = 2 + (cell % 2);
    for (var tw = 0; tw < twigN; tw++) {
      var sx = ox + cw * rr(r, 0.3, 0.7), sy = oy + ch * 0.92;
      var main = path2(r, sx, sy, -PI / 2 + rr(r, -0.45, 0.45), 6, ch * rr(r, 0.11, 0.13), 0.1);
      var needles = [];
      for (var t = 0.06; t <= 1; t += 0.012) {
        var at = pointOn(main, t);
        for (var k = 0; k < 3; k++) {
          var side = r() < 0.5 ? -1 : 1, a = at[2] + side * rr(r, 0.35, 1.15);
          needles.push([at[0], at[1], a, cw * rr(r, 0.1, 0.17), r()]);
        }
      }
      var tip = main[main.length - 1];
      for (var q = 0; q < 70; q++) needles.push([tip[0], tip[1], -PI / 2 + rr(r, -1.9, 1.9), cw * rr(r, 0.08, 0.15), 0.6 + r() * 0.4]);
      polyline(img, main, 5, 3, P.twig);
      needles.sort(function (a, b) { return a[4] - b[4]; });
      needles.forEach(function (n) {
        var col = mixc(P.dark, P.light, n[4]);
        stroke(img, n[0], n[1], n[0] + Math.cos(n[2]) * n[3], n[1] + Math.sin(n[2]) * n[3], 2.2, 0.8, col);
      });
      disc(img, tip[0], tip[1], 3.5, P.bud);
    }
  }

  /* Macrocarpa: feathery sprays of tiny overlapping scale leaves. */
  function paintCypress(img, ox, oy, cw, ch, cell, r, P) {
    function frond(x, y, ang, L, w, depth) {
      var steps = Math.max(3, Math.round(L / 4)), pts = path2(r, x, y, ang, steps, L / steps, 0.06);
      for (var i = 0; i < pts.length; i++) {
        var t = i / (pts.length - 1), col = mixc(P.dark, P.light, Math.min(1, t * 0.9 + (3 - depth) * 0.12)) ;
        disc(img, pts[i][0], pts[i][1], Math.max(1.2, w * (1 - t * 0.55)), scalec(col, 0.92 + r() * 0.16));
      }
      if (depth <= 0) return;
      var n = Math.round(L / (w * 3.2));
      for (var k = 1; k < n; k++) {
        var at = pointOn(pts, k / n), side = k % 2 ? 1 : -1;
        frond(at[0], at[1], at[2] + side * rr(r, 0.6, 0.95), L * rr(r, 0.32, 0.45) * (1 - k / n * 0.5), w * 0.72, depth - 1);
      }
    }
    var n = 5;
    for (var f = 0; f < n; f++) {
      frond(ox + cw * rr(r, 0.3, 0.7), oy + ch * 0.93, -PI / 2 + (f - 2) * 0.32 + rr(r, -0.12, 0.12), ch * rr(r, 0.55, 0.82), 3.2, 3);
    }
  }

  /* Eucalyptus: drooping sickle leaves, grey-blue-green, on a red-brown twig. */
  function paintGum(img, ox, oy, cw, ch, cell, r, P) {
    var leaves = [];
    for (var tw = 0; tw < 2; tw++) {
      var main = path2(r, ox + cw * rr(r, 0.12, 0.3), oy + ch * (tw ? 0.42 : 0.1), rr(r, -0.1, 0.35), 6, cw * 0.12, 0.18, 0.04);
      polyline(img, main, 4, 2, P.twig);
      for (var i = 0; i < 15; i++) {
        var at = pointOn(main, rr(r, 0.05, 1));
        leaves.push([at[0], at[1], PI / 2 + rr(r, -0.7, 0.7), ch * rr(r, 0.26, 0.4) * (tw ? 0.85 : 1), r()]);
      }
    }
    leaves.sort(function (a, b) { return a[4] - b[4]; });
    leaves.forEach(function (l) {
      var pe = 9, px = l[0] + Math.cos(l[2]) * pe, py = l[1] + Math.sin(l[2]) * pe;
      stroke(img, l[0], l[1], px, py, 1.8, 1.4, P.petiole);
      leaf(img, px, py, l[2], l[3], l[3] * 0.075, mixc(P.dark, P.light, l[4]), { profile: "lance", bend: rr(r, -0.14, 0.14), rib: P.rib, fold: 0.06, edge: 0.2 });
    });
  }

  /* Willow: long hanging strands lined with narrow leaves (tall cells). */
  function paintWillow(img, ox, oy, cw, ch, cell, r, P) {
    var strands = 2 + (cell % 2);
    for (var s = 0; s < strands; s++) {
      var x = ox + cw * (0.25 + 0.5 * (s + 0.5) / strands) + rr(r, -8, 8);
      var pts = path2(r, x, oy + 6, PI / 2, 14, (ch * 0.92) / 14, 0.07);
      polyline(img, pts, 2.6, 1.2, P.twig);
      var leaves = [];
      for (var t = 0.02; t < 0.99; t += 0.011) {
        var at = pointOn(pts, t), side = r() < 0.5 ? -1 : 1;
        leaves.push([at[0], at[1], at[2] + side * rr(r, 0.22, 0.6), cw * rr(r, 0.16, 0.24), r()]);
      }
      leaves.sort(function (a, b) { return a[4] - b[4]; });
      leaves.forEach(function (l) {
        leaf(img, l[0], l[1], l[2], l[3], l[3] * 0.12, mixc(P.dark, P.light, l[4]), { profile: "lance", bend: rr(r, -0.08, 0.08), fold: 0.07, edge: 0.15 });
      });
    }
  }

  /* Cabbage tree: one strap leaf per tall cell; the last cell is a dead, straw-brown one. */
  function paintStrap(img, ox, oy, cw, ch, cell, r, P) {
    var dead = cell === 3, base = dead ? P.dead : mixc(P.dark, P.light, cell / 2);
    leaf(img, ox + cw / 2, oy + ch - 6, -PI / 2, ch - 12, cw * 0.4, base, { profile: "strap", rib: dead ? P.deadRib : P.rib, fold: 0.05, veins: 7, tip: dead ? P.deadTip : P.tip, edge: 0.3 });
    if (dead) {
      for (var k = 0; k < 40; k++) {
        var y = oy + rr(r, 0.05, 0.95) * ch, x = ox + cw / 2 + rr(r, -0.3, 0.3) * cw;
        stroke(img, x, y, x + rr(r, -2, 2), y + rr(r, 10, 40), 2, 1, P.deadStreak, 0.5);
      }
    }
  }

  /* --------------------------------------------------- bark (256 x 256, tiles both ways) */

  function bark(style, seed, P) {
    var N = 256, img = new Img(N, N, P.a), d = img.d;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var u = x / N, v = y / N, c, f;
      if (style === "furrowed") {
        /* Plates split by deep vertical fissures, broken across at staggered heights. */
        var cols = 6, warp = (pfbm(u, v, 3, 4, 3, seed) - 0.5) * 0.9, cu = u * cols + warp;
        var col = ((Math.floor(cu) % cols) + cols) % cols, fx = cu - Math.floor(cu);
        var cv = v * 3 + ihash(col, 0, seed) * 3 + (pfbm(u, v, 6, 3, 2, seed + 3) - 0.5) * 0.9, fy = cv - Math.floor(cv);
        var fw = 0.1 + 0.14 * pfbm(u, v, 4, 8, 2, seed + 6);
        var edge = Math.min(smooth(0, fw, fx), smooth(0, fw, 1 - fx)) * Math.min(smooth(0, 0.035, fy), smooth(0, 0.035, 1 - fy));
        edge *= 0.8 + 0.2 * pfbm(u, v, 24, 4, 2, seed + 8);
        var plate = mixc(P.b, P.a, 0.25 + 0.5 * ihash(col, Math.floor(cv), seed + 1));
        c = mixc(scalec(P.a, 0.45), plate, edge);
        c = scalec(c, 0.8 + 0.4 * pfbm(u, v, 32, 32, 3, seed + 9));
      } else if (style === "stringy") {
        f = pfbm(u, v, 28, 3, 3, seed);
        var f2 = pfbm(u, v, 12, 2, 2, seed + 3);
        c = mixc(P.a, P.b, smooth(0.35, 0.7, f) * 0.8 + f2 * 0.2);
        c = scalec(c, 0.85 + 0.3 * pfbm(u, v, 64, 8, 1, seed + 7));
      } else if (style === "gum") {
        var p1 = pfbm(u, v, 3, 4, 4, seed), p2 = pfbm(u, v, 5, 6, 3, seed + 11);
        c = P.a;
        c = mixc(c, P.b, smooth(0.52, 0.56, p1));
        c = mixc(c, P.c, smooth(0.6, 0.64, p2) * 0.8);
        c = scalec(c, 0.9 + 0.15 * pfbm(u, v, 4, 40, 2, seed + 2));
      } else if (style === "smooth") {
        c = scalec(P.a, 0.88 + 0.22 * pfbm(u, v, 8, 8, 4, seed));
        var lent = pnoise(u * 40, v * 160, 40, 160, seed + 4);
        if (lent > 0.86) c = mixc(c, P.b, 0.6);
      } else { /* corky: rough blocks */
        var bx = pfbm(u, v, 10, 14, 3, seed), by = Math.abs(Math.sin(PI * (v * 14 + bx * 1.5)));
        f = smooth(0.15, 0.4, by) * smooth(0.25, 0.5, Math.abs(Math.sin(PI * (u * 9 + bx))));
        c = mixc(P.b, P.a, f);
        c = scalec(c, 0.85 + 0.3 * pfbm(u, v, 32, 32, 2, seed + 1));
      }
      var i = (y * N + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 1;
    }
    return img;
  }

  /* ------------------------------------------------------------------ geometry */

  function Geo() { this.p = []; this.n = []; this.uv = []; this.c = []; this.i = []; }
  Geo.prototype.v = function (p, n, uv, c) {
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.uv.push(uv[0], uv[1]); this.c.push(c[0], c[1], c[2]);
    return this.p.length / 3 - 1;
  };
  Geo.prototype.t = function (a, b, c) { this.i.push(a, b, c); };

  var BARK_TILE = 0.9; // metres of trunk one bark tile covers

  /* Smooth bark tube with tiling UVs: u round the girth, v up the length. */
  function tube(G, r, pts, r0, r1, sides, opts) {
    opts = opts || {};
    var n = pts.length, base = G.p.length / 3, prevU = null, acc = 0;
    var uRep = Math.max(1, Math.round((TAU * r0) / BARK_TILE));
    for (var i = 0; i < n; i++) {
      var t = norm(sub(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]));
      var u = prevU ? norm(sub(prevU, mul(t, dot(prevU, t)))) : norm(cross(t, Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      prevU = u;
      var w = cross(t, u);
      if (i > 0) acc += len(sub(pts[i], pts[i - 1]));
      var rad = lerp(r0, r1, i / (n - 1));
      if (i === 0 && opts.flare) rad *= opts.flare;
      var jit = [];
      for (var q = 0; q < sides; q++) jit.push(1 + (r() - 0.5) * 0.1);
      var shade = opts.groundAO ? lerp(0.7, 1, smooth(0, 1.5, pts[i][1])) : 1;
      for (var s = 0; s <= sides; s++) {
        var ang = (s / sides) * TAU, radial = add(mul(u, Math.cos(ang)), mul(w, Math.sin(ang)));
        var k = jit[s % sides];
        G.v(add(pts[i], mul(radial, rad * k)), radial, [(s / sides) * uRep, acc / BARK_TILE], [shade, shade, shade]);
      }
    }
    for (var j = 0; j < n - 1; j++) {
      for (var s2 = 0; s2 < sides; s2++) {
        var a = base + j * (sides + 1) + s2, b = a + 1, c = a + sides + 2, d = a + sides + 1;
        G.t(a, b, c); G.t(a, c, d);
      }
    }
    var lastRing = base + (n - 1) * (sides + 1), tdir = norm(sub(pts[n - 1], pts[n - 2]));
    var tip = G.v(add(pts[n - 1], mul(tdir, r1 * 0.8)), tdir, [0.5, (acc + r1) / BARK_TILE], [1, 1, 1]);
    for (var e = 0; e < sides; e++) G.t(lastRing + e, lastRing + e + 1, tip);
  }

  function grow(r, start, d, length, segs, wob, up) {
    var pts = [start], p = start, dd = norm(d);
    for (var i = 1; i <= segs; i++) {
      dd = norm(add(dd, [(r() - 0.5) * wob, up || 0, (r() - 0.5) * wob]));
      p = add(p, mul(dd, length / segs));
      pts.push(p);
    }
    return pts;
  }
  function along(pts, t) {
    var f = clamp(t, 0, 1) * (pts.length - 1), i = Math.min(Math.floor(f), pts.length - 2), k = f - i;
    return add(pts[i], mul(sub(pts[i + 1], pts[i]), k));
  }
  function tangent(pts, t) {
    var f = clamp(t, 0, 1) * (pts.length - 1), i = Math.min(Math.floor(f), pts.length - 2);
    return norm(sub(pts[i + 1], pts[i]));
  }
  /* Turn `t` by `deg` towards a perpendicular picked by azimuth `phi`. */
  function childDir(t, deg, phi) {
    var u = norm(cross(t, Math.abs(t[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0])), w = cross(t, u);
    var perp = add(mul(u, Math.cos(phi)), mul(w, Math.sin(phi))), a = (deg * PI) / 180;
    return norm(add(mul(t, Math.cos(a)), mul(perp, Math.sin(a))));
  }
  function inside(env, p) {
    var q = [(p[0] - env.c[0]) / env.r[0], (p[1] - env.c[1]) / env.r[1], (p[2] - env.c[2]) / env.r[2]];
    return dot(q, q) <= 1;
  }
  function fitEnv(env, start, d, L) {
    if (!env) return L;
    for (var k = 0; k < 8 && !inside(env, add(start, mul(d, L))); k++) L *= 0.78;
    return L;
  }

  var SIDES = [12, 8, 6, 4, 3];

  /* ------------------------------------------------------------------ the tree builder */

  function buildTree(spec, r, opts) {
    var bark = new Geo(), leaves = new Geo(), anchors = [];
    var F = spec.foliage;

    function anchorsFrom(br) {
      var Llen = br.len, s = (F.start || 0) * Llen;
      if (F.mode === "tuft") { anchors.push({ p: br.pts[br.pts.length - 1], d: tangent(br.pts, 1), level: br.level }); return; }
      while (s <= Llen) {
        var t = s / Llen;
        anchors.push({ p: along(br.pts, t), d: tangent(br.pts, t), level: br.level });
        s += F.step * rr(r, 0.7, 1.3);
      }
    }

    function addBranch(br) {
      var terminal = br.level >= spec.levels.length;
      if (!terminal || spec.tubeTwigs) tube(bark, r, br.pts, br.r0, br.r1, SIDES[Math.min(br.level, SIDES.length - 1)], { flare: br.level === 0 ? spec.flare : 0, groundAO: br.level === 0 });
      if (terminal) { anchorsFrom(br); return; }
      if (F.alsoFromLevel != null && br.level >= F.alsoFromLevel) anchorsFrom(br);
      var L = spec.levels[br.level];
      var n = Math.round(rr(r, L.count[0], L.count[1])), phi = r() * TAU;
      for (var k = 0; k < n; k++) {
        var tPos = lerp(L.range[0], L.range[1], (k + rr(r, 0.1, 0.9)) / n);
        phi += 2.39996 + rr(r, -0.3, 0.3);
        var start = along(br.pts, tPos), d = childDir(tangent(br.pts, tPos), rr(r, L.angle[0], L.angle[1]), phi);
        var length = (L.abs ? rr(r, L.len[0], L.len[1]) : br.len * rr(r, L.len[0], L.len[1]));
        if (L.taper != null) length *= lerp(1, L.taper, tPos);
        if (L.shape) length *= L.shape(tPos);
        length = fitEnv(spec.env, start, d, length);
        if (length < 0.2) continue;
        var r0 = Math.max(0.012, lerp(br.r0, br.r1, tPos) * L.rRatio);
        addBranch({ pts: grow(r, start, d, length, L.segs, L.wob, L.up), len: length, r0: r0, r1: Math.max(0.008, r0 * 0.3), level: br.level + 1 });
      }
    }

    spec.trunks(r).forEach(function (tr) {
      addBranch({ pts: grow(r, tr.start || [0, 0, 0], tr.dir, tr.len, tr.segs, tr.wob, tr.up), len: tr.len, r0: tr.r0, r1: tr.r1, level: 0 });
    });

    /* The crown's extent, from where the foliage actually is: for normals and shading. */
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    anchors.forEach(function (a) { for (var q = 0; q < 3; q++) { mn[q] = Math.min(mn[q], a.p[q]); mx[q] = Math.max(mx[q], a.p[q]); } });
    var cc = mul(add(mn, mx), 0.5), cr = [Math.max(0.5, (mx[0] - mn[0]) / 2 + 0.6), Math.max(0.5, (mx[1] - mn[1]) / 2 + 0.6), Math.max(0.5, (mx[2] - mn[2]) / 2 + 0.6)];
    var crown = { c: cc, r: cr, minY: mn[1], maxY: mx[1] };

    var atlas = spec.atlas;
    anchors.forEach(function (a) {
      if (F.mode === "tuft") return tuft(leaves, r, a, spec, crown, opts);
      var size = rr(r, F.size[0], F.size[1]);
      if (F.mode === "hang") return hang(leaves, r, a, size, spec, crown);
      /* Always one roll, so the flowering tree is the same tree, just in bloom. */
      var cells = F.cells, bloom = r();
      if (spec.flowerCells && opts.flowering && bloom < spec.flowerChance) cells = spec.flowerCells;
      var cell = pick(r, cells);
      if (F.mode === "cross") {
        var upv = a.d, right = norm(cross(upv, randUnit(r)));
        card(leaves, r, add(a.p, mul(upv, size * 0.25)), upv, right, size * F.aspect, size, cell, atlas, crown);
        card(leaves, r, add(a.p, mul(upv, size * 0.25)), upv, norm(cross(upv, right)), size * F.aspect, size, cell, atlas, crown);
      } else {
        var nrm = norm(add(randUnit(r), [0, F.upBias || 0, 0]));
        var axis = F.worldUp ? norm(add([0, 1, 0], mul(randUnit(r), 0.35))) : a.d;
        var up2 = norm(sub(axis, mul(nrm, dot(axis, nrm))));
        if (len(sub(axis, mul(nrm, dot(axis, nrm)))) < 0.05) up2 = norm(cross(nrm, [1, 0, 0]));
        var rt = norm(cross(up2, nrm));
        card(leaves, r, add(a.p, mul(up2, size * (F.lift == null ? 0.2 : F.lift))), up2, rt, size * F.aspect, size, cell, atlas, crown);
      }
    });

    return { bark: bark, leaves: leaves, crown: crown };
  }

  function cellUV(atlas, cell) {
    var cx = cell % atlas.cols, cy = Math.floor(cell / atlas.cols), e = 0.004;
    return [cx / atlas.cols + e, cy / atlas.rows + e, (cx + 1) / atlas.cols - e, (cy + 1) / atlas.rows - e];
  }

  function shadeAt(p, crown, r) {
    var q = [(p[0] - crown.c[0]) / crown.r[0], (p[1] - crown.c[1]) / crown.r[1], (p[2] - crown.c[2]) / crown.r[2]];
    var e = Math.sqrt(dot(q, q));
    var ao = lerp(0.38, 1, smooth(0.1, 1.0, e)) * lerp(0.78, 1.04, clamp((p[1] - crown.minY) / Math.max(crown.maxY - crown.minY, 0.5), 0, 1));
    var j = 0.92 + r() * 0.16, hue = (r() - 0.5) * 0.08;
    return [ao * j * (1 + hue), ao * j, ao * j * (1 - hue)];
  }
  function outward(p, crown, face) {
    var g = norm([(p[0] - crown.c[0]) / (crown.r[0] * crown.r[0]), (p[1] - crown.c[1]) / (crown.r[1] * crown.r[1]), (p[2] - crown.c[2]) / (crown.r[2] * crown.r[2])]);
    if (face) { if (dot(face, g) < 0) face = mul(face, -1); g = norm(add(mul(g, 0.78), mul(face, 0.22))); }
    return g;
  }

  /* One foliage card, centred on p, written front and back with crown-outward normals. */
  function card(G, r, p, up, right, w, h, cell, atlas, crown) {
    var uv = cellUV(atlas, cell), face = norm(cross(right, up)), col = shadeAt(p, crown, r);
    var hw = mul(right, w / 2), hh = mul(up, h / 2);
    var corners = [sub(sub(p, hw), hh), sub(add(p, hw), hh), add(add(p, hw), hh), add(sub(p, hw), hh)];
    var uvs = [[uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]], [uv[0], uv[1]]];
    var ids = corners.map(function (c, k) { return G.v(c, outward(c, crown, face), uvs[k], col); });
    G.t(ids[0], ids[1], ids[2]); G.t(ids[0], ids[2], ids[3]);
    G.t(ids[0], ids[2], ids[1]); G.t(ids[0], ids[3], ids[2]);
  }

  /* Willow tresses: a crossed pair of tall cards hanging from the anchor. */
  function hang(G, r, a, size, spec, crown) {
    var F = spec.foliage, drop = clamp((a.p[1] - rr(r, 0.6, 2.2)) * rr(r, 0.55, 0.95), 1.2, F.maxDrop || 6);
    var out = norm([a.p[0] - crown.c[0], 0, a.p[2] - crown.c[2]]);
    var right = norm(add(cross([0, 1, 0], out), mul(randUnit(r), 0.3)));
    right = norm([right[0], 0, right[2]]);
    var w = size * F.aspect, cell = pick(r, F.cells), mid = add(a.p, [0, -drop / 2 + 0.15, 0]);
    var lean = add([0, 1, 0], mul(out, -0.12));
    card(G, r, mid, norm(lean), right, w, drop, cell, spec.atlas, crown);
    card(G, r, mid, norm(lean), norm(cross(norm(lean), right)), w, drop, pick(r, F.cells), spec.atlas, crown);
  }

  /* Cabbage-tree tuft: a burst of real strap leaves, arching over, with a dead skirt below. */
  function tuft(G, r, a, spec, crown) {
    var live = 54, dead = 26, atlas = spec.atlas;
    for (var k = 0; k < live + dead; k++) {
      var isDead = k >= live, cell = isDead ? 3 : Math.floor(r() * 3);
      var up = isDead ? rr(r, -85, -50) : rr(r, -25, 85), yaw = r() * 360;
      var d = [Math.cos(up * PI / 180) * Math.cos(yaw * PI / 180), Math.sin(up * PI / 180), Math.cos(up * PI / 180) * Math.sin(yaw * PI / 180)];
      var L = isDead ? rr(r, 0.6, 0.85) : rr(r, 0.75, 1.05), droop = isDead ? 0.05 : lerp(0.6, 0.06, (up + 25) / 110);
      blade(G, r, add(a.p, isDead ? [0, -0.1, 0] : [0, 0, 0]), d, L, 0.075, droop, cell, atlas, a.p);
    }
  }
  function blade(G, r, base, d, L, w, droop, cell, atlas, centre) {
    var uv = cellUV(atlas, cell), segs = 5;
    var side = cross(d, [0, 1, 0]);
    side = len(side) < 1e-3 ? [1, 0, 0] : norm(side);
    var tw = rr(r, -0.6, 0.6), upn = cross(side, d);
    side = norm(add(mul(side, Math.cos(tw)), mul(upn, Math.sin(tw))));
    var face = norm(cross(side, d)), ids = [];
    var col = [rr(r, 0.82, 1.02), rr(r, 0.82, 1.02), rr(r, 0.82, 1.02)];
    for (var i = 0; i <= segs; i++) {
      var s = i / segs, p = add(add(base, mul(d, L * s)), [0, -droop * L * s * s, 0]);
      var n = norm(add(mul(norm(sub(p, centre)), 0.6), mul(face[1] < 0 ? mul(face, -1) : face, 0.4)));
      var v = lerp(uv[3], uv[1], s), shade = lerp(0.7, 1, s);
      ids.push(G.v(add(p, mul(side, -w / 2)), n, [uv[0], v], scalec(col, shade)));
      ids.push(G.v(add(p, mul(side, w / 2)), n, [uv[2], v], scalec(col, shade)));
    }
    for (var j = 0; j < segs; j++) {
      var a0 = ids[j * 2], b0 = ids[j * 2 + 1], a1 = ids[j * 2 + 2], b1 = ids[j * 2 + 3];
      G.t(a0, b0, b1); G.t(a0, b1, a1);
      G.t(a0, b1, b0); G.t(a0, a1, b1);
    }
  }

  /* ------------------------------------------------------------------ species */

  function H(h) { return hex(h); }
  var trunkUp = function (len, r0, r1, wob) { return function () { return [{ dir: [0.02, 1, 0.01], len: len, r0: r0, r1: r1, segs: Math.max(4, Math.round(len / 2)), wob: wob || 0.04, up: 0 }]; }; };

  var SPECIES = {
    "radiata-pine": {
      name: "Radiata pine", botanical: "Pinus radiata", seed: 11, billboardType: 2,
      trunks: trunkUp(25, 0.55, 0.08, 0.035), flare: 1.3,
      levels: [
        { count: [22, 26], range: [0.55, 0.98], angle: [58, 84], len: [5, 8], abs: true, taper: 0.45, up: 0.07, wob: 0.2, segs: 4, rRatio: 0.32 },
        { count: [3, 5], range: [0.55, 1], angle: [30, 55], len: [0.25, 0.4], up: 0.12, wob: 0.25, segs: 2, rRatio: 0.55 },
        { count: [3, 5], range: [0.4, 1], angle: [25, 50], len: [0.4, 0.7], up: 0.12, wob: 0.25, segs: 2, rRatio: 0.6 }
      ],
      foliage: { mode: "cross", step: 0.36, start: 0.1, size: [1.6, 2.2], aspect: 0.85, cells: [0, 1, 2, 3] },
      barkStyle: "furrowed", barkCol: { a: H("#3a2e25"), b: H("#7a6553") },
      atlas: { cols: 2, rows: 2, bg: H("#2f4a2b"), paint: paintNeedles, P: { dark: H("#18301c"), light: H("#4c6c3a"), twig: H("#5b4a36"), bud: H("#8c7a55") } }
    },
    "macrocarpa": {
      name: "Macrocarpa", botanical: "Cupressus macrocarpa", seed: 23, billboardType: 1,
      trunks: trunkUp(3.6, 1.0, 0.75, 0.06), flare: 1.4,
      env: { c: [1.2, 10.8, 0], r: [9.6, 6.6, 8.2] },
      levels: [
        { count: [6, 7], range: [0.82, 1], angle: [25, 58], len: [7.5, 10], abs: true, up: 0.03, wob: 0.25, segs: 5, rRatio: 0.55 },
        { count: [7, 9], range: [0.18, 1], angle: [30, 70], len: [0.3, 0.5], up: 0.07, wob: 0.3, segs: 3, rRatio: 0.5 },
        { count: [5, 7], range: [0.2, 1], angle: [30, 60], len: [0.35, 0.55], up: 0.06, wob: 0.3, segs: 2, rRatio: 0.55 }
      ],
      foliage: { mode: "card", step: 0.19, start: 0.1, size: [1.0, 1.45], aspect: 1, cells: [0, 1, 2, 3], upBias: 0.9, lift: 0.1, alsoFromLevel: 2 },
      barkStyle: "stringy", barkCol: { a: H("#4a4038"), b: H("#8d8174") },
      atlas: { cols: 2, rows: 2, bg: H("#2b452a"), paint: paintCypress, P: { dark: H("#162c1a"), light: H("#4b6c35") } }
    },
    "poplar": {
      name: "Poplar", botanical: "Populus nigra 'Italica'", seed: 37, billboardType: 3,
      trunks: trunkUp(22, 0.45, 0.06, 0.02), flare: 1.25,
      env: { c: [0, 13, 0], r: [3.2, 11.8, 3.2] },
      levels: [
        { count: [46, 52], range: [0.1, 0.98], angle: [14, 30], len: [3, 6], abs: true, shape: function (t) { return Math.pow(Math.sin(PI * (0.15 + 0.85 * t)), 0.6); }, up: 0.18, wob: 0.15, segs: 3, rRatio: 0.3 },
        { count: [4, 6], range: [0.25, 1], angle: [20, 45], len: [0.3, 0.5], up: 0.15, wob: 0.2, segs: 2, rRatio: 0.55 }
      ],
      foliage: { mode: "card", step: 0.26, start: 0.1, size: [1.4, 1.9], aspect: 1, cells: [0, 1, 2, 3], upBias: 0.3, alsoFromLevel: 1 },
      barkStyle: "furrowed", barkCol: { a: H("#4e4a42"), b: H("#8e887c") },
      atlas: { cols: 2, rows: 2, bg: H("#5e8a34"), paint: paintBroad, P: { L: 50, W: 0.42, profile: "delta", perTwig: [3, 5], sides: 8, petiole: 16, petioleCol: H("#b6b26a"), twig: H("#6b604a"), dark: H("#4d7a2c"), light: H("#a8c45a"), rib: H("#c9d48c"), fold: 0.1 } }
    },
    "willow": {
      name: "Willow", botanical: "Salix babylonica", seed: 41, billboardType: 3,
      trunks: function () { return [{ dir: [0.2, 1, 0.06], len: 3.2, r0: 0.7, r1: 0.5, segs: 3, wob: 0.08, up: 0 }]; }, flare: 1.35,
      env: { c: [0.6, 8.6, 0], r: [7.4, 4.2, 7.4] },
      levels: [
        { count: [6, 7], range: [0.88, 1], angle: [28, 55], len: [5.5, 7.5], abs: true, up: 0.03, wob: 0.25, segs: 5, rRatio: 0.55 },
        { count: [6, 8], range: [0.3, 1], angle: [30, 70], len: [0.35, 0.6], up: -0.05, wob: 0.3, segs: 3, rRatio: 0.5 },
        { count: [3, 4], range: [0.4, 1], angle: [30, 55], len: [0.3, 0.5], up: -0.12, wob: 0.3, segs: 2, rRatio: 0.5 }
      ],
      foliage: { mode: "hang", step: 0.55, start: 0.3, size: [0.9, 1.2], aspect: 0.55, cells: [0, 1, 2, 3], maxDrop: 6.5 },
      barkStyle: "furrowed", barkCol: { a: H("#3d362e"), b: H("#7d7262") },
      atlas: { cols: 4, rows: 1, bg: H("#8aa548"), paint: paintWillow, P: { dark: H("#5e7f2e"), light: H("#bccf6e"), twig: H("#8c7b3e") } }
    },
    "eucalyptus": {
      name: "Eucalyptus", botanical: "Eucalyptus spp.", seed: 53, billboardType: 0,
      trunks: function () { return [{ dir: [0.06, 1, -0.03], len: 9, r0: 0.65, r1: 0.45, segs: 5, wob: 0.1, up: 0 }]; }, flare: 1.3,
      levels: [
        { count: [4, 4], range: [0.92, 1], angle: [20, 40], len: [9, 12], abs: true, up: 0.03, wob: 0.28, segs: 5, rRatio: 0.62 },
        { count: [6, 8], range: [0.25, 1], angle: [30, 60], len: [0.35, 0.55], up: 0.04, wob: 0.35, segs: 3, rRatio: 0.5 },
        { count: [4, 6], range: [0.4, 1], angle: [30, 60], len: [0.4, 0.65], up: -0.05, wob: 0.35, segs: 2, rRatio: 0.5 }
      ],
      foliage: { mode: "card", step: 0.36, start: 0.15, size: [2.2, 3.0], aspect: 1, cells: [0, 1, 2, 3], upBias: 0, worldUp: true, lift: -0.2, alsoFromLevel: 2 },
      barkStyle: "gum", barkCol: { a: H("#d6cfbd"), b: H("#9a917c"), c: H("#c59a7c") },
      atlas: { cols: 2, rows: 2, bg: H("#7b9180"), paint: paintGum, P: { dark: H("#5b7366"), light: H("#a6b8a4"), rib: H("#c4b48a"), twig: H("#8a4f38"), petiole: H("#a0603f") } }
    },
    "pohutukawa": {
      name: "Pōhutukawa", botanical: "Metrosideros excelsa", seed: 67, billboardType: 1,
      trunks: function (r) {
        var out = [];
        for (var i = 0; i < 4; i++) out.push({ dir: childDir([0, 1, 0], rr(r, 34, 50), i * PI / 2 + rr(r, -0.4, 0.4)), len: rr(r, 4.6, 6), r0: 0.5, r1: 0.32, segs: 4, wob: 0.18, up: -0.01 });
        return out;
      }, flare: 1.2,
      env: { c: [0, 8.2, 0], r: [10.8, 6.2, 10.8] },
      levels: [
        { count: [3, 4], range: [0.6, 1], angle: [22, 48], len: [0.7, 1.0], up: 0.02, wob: 0.25, segs: 4, rRatio: 0.65 },
        { count: [5, 7], range: [0.25, 1], angle: [30, 60], len: [0.4, 0.6], up: 0.06, wob: 0.3, segs: 3, rRatio: 0.5 },
        { count: [4, 6], range: [0.3, 1], angle: [30, 60], len: [0.35, 0.5], up: 0.05, wob: 0.3, segs: 2, rRatio: 0.5 }
      ],
      foliage: { mode: "card", step: 0.26, start: 0.1, size: [1.8, 2.4], aspect: 1, cells: [0, 1], upBias: 0.8, lift: 0.15, alsoFromLevel: 2 },
      flowerCells: [2, 3], flowerChance: 0.42,
      barkStyle: "stringy", barkCol: { a: H("#463c33"), b: H("#8e8476") },
      atlas: { cols: 2, rows: 2, bg: H("#2e4a2c"), paint: paintBroad, P: { L: 82, W: 0.36, profile: "oval", perTwig: [7, 10], sides: 9, tipLeaves: 10, twig: H("#6a5a48"), dark: H("#203a22"), light: H("#4f7240"), under: H("#a9b19a"), underChance: 0.22, rib: H("#9fae84"), fold: 0.12, flowers: { red: H("#d01f2e"), deep: H("#8c0f1e"), gold: H("#e6c35a") } } }
    },
    "cabbage-tree": {
      name: "Cabbage tree / tī kōuka", botanical: "Cordyline australis", seed: 79, billboardType: 3,
      trunks: trunkUp(3.1, 0.28, 0.2, 0.05), flare: 1.4, tubeTwigs: true,
      levels: [
        { count: [3, 3], range: [0.97, 1], angle: [22, 34], len: [1.4, 2.1], abs: true, up: 0.02, wob: 0.1, segs: 3, rRatio: 0.6 },
        { count: [2, 2], range: [0.98, 1], angle: [15, 28], len: [0.6, 0.85], up: 0.02, wob: 0.1, segs: 2, rRatio: 0.75 }
      ],
      foliage: { mode: "tuft" },
      barkStyle: "corky", barkCol: { a: H("#7a6a55"), b: H("#45392e") },
      atlas: { cols: 4, rows: 1, bg: H("#7e8e43"), paint: paintStrap, P: { dark: H("#4f6b2c"), light: H("#879a46"), rib: H("#b7c27d"), tip: H("#8a8248"), dead: H("#a88f5c"), deadRib: H("#c9b07a"), deadTip: H("#7d6a45"), deadStreak: H("#6d5a3c") } }
    },
    "native-broadleaf": {
      name: "Native broadleaf", botanical: "generic evergreen", seed: 83, billboardType: 0,
      trunks: trunkUp(3.0, 0.4, 0.3, 0.06), flare: 1.3,
      env: { c: [0, 7.1, 0], r: [5.2, 4.2, 5.2] },
      levels: [
        { count: [4, 5], range: [0.85, 1], angle: [28, 50], len: [4, 5.2], abs: true, up: 0.05, wob: 0.25, segs: 4, rRatio: 0.62 },
        { count: [5, 7], range: [0.3, 1], angle: [30, 65], len: [0.4, 0.6], up: 0.06, wob: 0.3, segs: 3, rRatio: 0.5 },
        { count: [4, 6], range: [0.3, 1], angle: [30, 60], len: [0.35, 0.5], up: 0.05, wob: 0.3, segs: 2, rRatio: 0.5 }
      ],
      foliage: { mode: "card", step: 0.24, start: 0.1, size: [1.6, 2.1], aspect: 1, cells: [0, 1, 2, 3], upBias: 0.7, lift: 0.15, alsoFromLevel: 2 },
      barkStyle: "smooth", barkCol: { a: H("#6f6a60"), b: H("#b3ab98") },
      atlas: { cols: 2, rows: 2, bg: H("#3b6630"), paint: paintBroad, P: { L: 78, W: 0.38, profile: "oval", perTwig: [6, 9], sides: 9, twig: H("#5e5242"), dark: H("#244a22"), light: H("#6e9a46"), rib: H("#a8c07a"), fold: 0.14 } }
    }
  };
  var ORDER = ["radiata-pine", "macrocarpa", "poplar", "willow", "eucalyptus", "pohutukawa", "cabbage-tree", "native-broadleaf"];

  /* ------------------------------------------------------------------ output */

  var textureCache = {};
  function textures(id) {
    if (textureCache[id]) return textureCache[id];
    var s = SPECIES[id], A = s.atlas, N = 1024, img = new Img(N, N, A.bg), r = rng(s.seed * 7 + 1);
    var cw = N / A.cols, ch = N / A.rows;
    for (var c = 0; c < A.cols * A.rows; c++) {
      var ox = (c % A.cols) * cw, oy = Math.floor(c / A.cols) * ch;
      img.clip = [ox + 3, oy + 3, ox + cw - 3, oy + ch - 3];
      A.paint(img, ox, oy, cw, ch, c, r, A.P);
    }
    return (textureCache[id] = { leaves: img.rgba(), bark: bark(s.barkStyle, s.seed, s.barkCol).rgba() });
  }

  function pack(G) {
    var count = G.p.length / 3, colors = new Float32Array(G.c.length);
    for (var i = 0; i < G.c.length; i++) colors[i] = toLinear(clamp(G.c[i], 0, 1));
    return {
      positions: new Float32Array(G.p), normals: new Float32Array(G.n), uvs: new Float32Array(G.uv), colors: colors,
      indices: count > 65535 ? new Uint32Array(G.i) : new Uint16Array(G.i), vertexCount: count, triangles: G.i.length / 3
    };
  }

  function build(id, opts) {
    var s = SPECIES[id];
    if (!s) throw new Error("unknown tree: " + id);
    opts = opts || {};
    var r = rng(opts.seed != null ? opts.seed : s.seed);
    var t = buildTree(s, r, opts), bark = pack(t.bark), leaves = pack(t.leaves);
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    [bark.positions, leaves.positions].forEach(function (P) {
      for (var i = 0; i < P.length; i += 3) for (var a = 0; a < 3; a++) { if (P[i + a] < mn[a]) mn[a] = P[i + a]; if (P[i + a] > mx[a]) mx[a] = P[i + a]; }
    });
    return {
      id: id, name: s.name, bark: bark, leaves: leaves, textures: textures(id),
      meta: {
        species: id, name: s.name, botanical: s.botanical, variant: opts.flowering ? "flowering" : null,
        heightM: +mx[1].toFixed(2), crownRadiusM: +(((mx[0] - mn[0]) + (mx[2] - mn[2])) / 4).toFixed(2),
        triangles: bark.triangles + leaves.triangles, billboardType: s.billboardType,
        leafAlphaCutoff: 0.45, barkTileM: BARK_TILE
      }
    };
  }

  /* Smaller copies of a leaf atlas for drawing at a distance (mip levels), each holding the
     same share of solid leaf as the full size. A plain average thins every cut-out edge, so
     far away fine leaves - willow strands, needles - fade under the alpha cut-off and the tree
     goes bald; here each level's alpha is lifted until as much of it passes the cut-off as at
     full size. Returns [level0, level1, ... 1x1], each {width, height, data}. */
  function mipLevels(img, cutoff) {
    cutoff = cutoff == null ? 0.45 : cutoff;
    var c255 = cutoff * 255;
    function coverage(d) {
      var n = 0;
      for (var i = 3; i < d.length; i += 4) if (d[i] >= c255) n++;
      return n / (d.length / 4);
    }
    var want = coverage(img.data), levels = [img], cur = img;
    while (cur.width > 1 || cur.height > 1) {
      var w = Math.max(1, cur.width >> 1), h = Math.max(1, cur.height >> 1), out = new Uint8Array(w * h * 4), src = cur.data;
      var alpha = new Float32Array(w * h);
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
        var r = 0, g = 0, b = 0, a = 0;
        for (var dy = 0; dy < 2; dy++) for (var dx = 0; dx < 2; dx++) {
          var sx = Math.min(cur.width - 1, x * 2 + dx), sy = Math.min(cur.height - 1, y * 2 + dy), i = (sy * cur.width + sx) * 4, wa = src[i + 3] + 1;
          r += src[i] * wa; g += src[i + 1] * wa; b += src[i + 2] * wa; a += src[i + 3];
        }
        var k = (y * w + x) * 4, sum = 0;
        for (var q = 0; q < 4; q++) sum += src[(Math.min(cur.height - 1, y * 2 + (q >> 1)) * cur.width + Math.min(cur.width - 1, x * 2 + (q & 1))) * 4 + 3] + 1;
        out[k] = r / sum; out[k + 1] = g / sum; out[k + 2] = b / sum;
        alpha[y * w + x] = a / 4;
      }
      /* The smallest lift that brings coverage back up to the full-size share. */
      var lo = 1, hi = 8;
      for (var it = 0; it < 14; it++) {
        var mid = (lo + hi) / 2, n = 0;
        for (var j = 0; j < alpha.length; j++) if (alpha[j] * mid >= c255) n++;
        if (n / alpha.length < want) lo = mid; else hi = mid;
      }
      for (var m = 0; m < alpha.length; m++) out[m * 4 + 3] = Math.min(255, Math.round(alpha[m] * hi));
      cur = { width: w, height: h, data: out };
      levels.push(cur);
    }
    return levels;
  }

  /* A mown-fairway texture for previews: tiling, with stripes. Not exported. */
  function fairway() {
    var N = 256, img = new Img(N, N, [0, 0, 0]), d = img.d, a = hex("#5f7f3a"), b = hex("#86a24f");
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var u = x / N, v = y / N, stripe = Math.sin(TAU * u * 2) > 0 ? 1 : 0;
      var g = pfbm(u, v, 16, 16, 3, 4), fine = pnoise(u * 128, v * 128, 128, 128, 8);
      var c = scalec(mixc(a, b, 0.35 + 0.3 * stripe + (g - 0.5) * 0.5), 0.88 + 0.22 * fine), i = (y * N + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 1;
    }
    return img.rgba();
  }

  return {
    SPECIES: ORDER.map(function (id) { return { id: id, name: SPECIES[id].name, botanical: SPECIES[id].botanical, billboardType: SPECIES[id].billboardType }; }),
    build: build, textures: textures, mipLevels: mipLevels, fairway: fairway
  };
});
