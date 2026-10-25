/* Clarity - which New Zealand tree is this? A best guess from the aerial photo.
 *
 * Nobody tags trees by hand. Each tree marker's crown is read off the published photo and
 * compared with the grass round it, and the guess is one of the eight species the 3D tree
 * sets have (scripts/trees/nz-trees.js and nz-trees-real.js):
 *
 *   radiata-pine, macrocarpa, poplar, willow, eucalyptus, pohutukawa, cabbage-tree,
 *   native-broadleaf (the fallback)
 *
 * What it looks at, per tree:
 *   - darkness: crown lightness minus the surrounding turf's (CIELAB L*), so a dull winter
 *     photo and a bright summer one read alike. Pines and macrocarpa are far darker than
 *     grass; willow and poplar are nearly as light.
 *   - greenness: crown chroma relative to the turf's. Gums read grey; willows and poplars
 *     read as vivid as the grass or more.
 *   - hue: yellow-green (willow, poplar) against blue-grey-green (gum).
 *   - texture: spread of lightness inside the crown - an open gum or pine canopy shows ground
 *     and shadow between clumps; a macrocarpa is a dense even mass.
 *   - crown radius, from the marker: cabbage trees and poplars are small from above,
 *     macrocarpa and pōhutukawa broad.
 *   - water: willows stand by ponds and streams, so mapped water nearby counts heavily.
 *   - latitude: pōhutukawa is mostly a northern tree; south of about 39°S it is less likely.
 * Then stands vote: trees whose crowns nearly touch form a stand. A tree that is clearly one
 * species keeps it; a borderline one takes the stand's pick, so a shelter belt comes out as
 * one species rather than a patchwork while a clearly different tree in it keeps its own.
 *
 * It is a guess. Colour from above cannot tell every pine from every macrocarpa, and a
 * deciduous tree photographed in winter reads as bare ground. Wrong guesses only change which
 * model stands there; nothing is stored.
 *
 * Pure: pixels in, ids out. dev/tree-species.test.js runs it on synthetic pictures. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GDTreeSpecies = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var FALLBACK = "native-broadleaf";
  var SPECIES = ["radiata-pine", "macrocarpa", "poplar", "willow", "eucalyptus", "pohutukawa", "cabbage-tree", "native-broadleaf"];
  /* Metres from a crown's edge to mapped water for a tree to count as "by the water". */
  var WATER_NEAR_M = 18;
  /* Pōhutukawa's natural range is the upper North Island. */
  var POHUTUKAWA_SOUTH_LAT = -39.5;
  /* Crowns closer than this, edge to edge, belong to one stand. */
  var STAND_GAP_M = 6;
  /* How far ahead (in share of a tree's own normalised scores) its best guess must be for the
     tree to keep it against its stand's pick. */
  var CONFIDENT_MARGIN = 0.25;

  /* ------------------------------------------------------------------ colour */

  var LINEAR = new Float32Array(256);
  for (var li = 0; li < 256; li++) { var cl = li / 255; LINEAR[li] = cl <= 0.04045 ? cl / 12.92 : Math.pow((cl + 0.055) / 1.055, 2.4); }
  function lab(r, g, b) {
    var R = LINEAR[r & 255], G = LINEAR[g & 255], B = LINEAR[b & 255];
    var x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    var y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    var z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    function f(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
    var fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function mean(list, k) {
    var s = 0;
    for (var i = 0; i < list.length; i++) s += list[i][k];
    return list.length ? s / list.length : 0;
  }

  /* What one crown looks like against the grass round it.
     image: {width, height, data: RGBA}. cx, cy, rPx: the crown in that image's pixels.
     Returns null when too little of the crown or its surroundings is in the picture. */
  function crownFeatures(image, cx, cy, rPx) {
    var w = image.width, h = image.height, d = image.data;
    var inner = Math.max(1.5, rPx * 0.75), r0 = Math.max(rPx * 1.5, rPx + 2), r1 = Math.max(rPx * 2.3, r0 + 3);
    var crown = [], ring = [];
    var x0 = Math.max(0, Math.floor(cx - r1)), x1 = Math.min(w - 1, Math.ceil(cx + r1));
    var y0 = Math.max(0, Math.floor(cy - r1)), y1 = Math.min(h - 1, Math.ceil(cy + r1));
    /* Big crowns are thinned to a few hundred samples - plenty for a mean and a spread, and
       quick enough for thousands of trees. */
    var step = Math.max(1, Math.floor(r1 / 14));
    for (var y = y0; y <= y1; y += step) {
      for (var x = x0; x <= x1; x += step) {
        var dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (dist > r1 || (dist > inner && dist < r0)) continue;
        var i = (y * w + x) * 4;
        if (d[i + 3] < 128) continue;
        (dist <= inner ? crown : ring).push(lab(d[i], d[i + 1], d[i + 2]));
      }
    }
    var wantCrown = Math.max(3, Math.PI * inner * inner / (step * step) * 0.5);
    if (crown.length < wantCrown || ring.length < 6) return null;

    /* Texture from the whole crown; colour from its darker three quarters (the foliage, not
       the odd patch of ground showing through); turf from the lighter half of the ring (grass,
       not the next tree along). */
    var Ls = crown.map(function (c) { return c[0]; }), mL = Ls.reduce(function (a, b) { return a + b; }, 0) / Ls.length;
    var texture = Math.sqrt(Ls.reduce(function (a, b) { return a + (b - mL) * (b - mL); }, 0) / Ls.length);
    crown.sort(function (a, b) { return a[0] - b[0]; });
    ring.sort(function (a, b) { return a[0] - b[0]; });
    var leaf = crown.slice(0, Math.max(1, Math.round(crown.length * 0.75)));
    var turf = ring.slice(Math.floor(ring.length * 0.5));
    var L = mean(leaf, 0), A = mean(leaf, 1), B = mean(leaf, 2);
    var tL = mean(turf, 0), tA = mean(turf, 1), tB = mean(turf, 2);
    var C = Math.hypot(A, B), tC = Math.hypot(tA, tB);
    var hue = (Math.atan2(B, A) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    return {
      dark: L - tL,                        // negative: darker than the turf
      relChroma: C / Math.max(tC, 4),      // 1: as vivid as the turf
      hue: hue,                            // ~100 yellow-green, ~130 green, 150+ blue-grey-green
      texture: texture
    };
  }

  /* ------------------------------------------------------------------ scoring */

  function g(x, mu, sigma) { var t = (x - mu) / sigma; return Math.exp(-0.5 * t * t); }

  /* How much each species fits one tree. f: crownFeatures (or null), r: crown radius in m. */
  function scores(f, r, nearWater, lat) {
    var s = {};
    SPECIES.forEach(function (id) { s[id] = 0; });
    var southern = Number.isFinite(lat) && lat < POHUTUKAWA_SOUTH_LAT;
    if (!f) {
      /* Nothing to read - size alone, gently. */
      s["cabbage-tree"] = g(r, 1.6, 0.6) * 0.5;
      s[FALLBACK] = 0.3;
      return s;
    }
    s["radiata-pine"] = g(f.dark, -32, 10) * g(f.relChroma, 0.5, 0.28) * g(r, 5, 2.6) * g(f.texture, 7, 4);
    s["macrocarpa"] = g(f.dark, -36, 8) * g(f.relChroma, 0.42, 0.22) * g(r, 8.5, 3) * g(f.texture, 2.5, 2.5);
    s["pohutukawa"] = g(f.dark, -24, 8) * g(f.relChroma, 0.62, 0.25) * g(r, 8, 3) * g(f.hue, 135, 18) * (southern ? 0.35 : 1);
    s["poplar"] = g(f.dark, -9, 8) * g(f.relChroma, 1.05, 0.3) * g(r, 2.6, 1.2) * g(f.hue, 112, 16);
    s["willow"] = g(f.dark, -8, 9) * g(f.relChroma, 1.0, 0.32) * g(r, 6, 2.6) * g(f.hue, 110, 16) * (nearWater ? 2.5 : 0.3);
    s["eucalyptus"] = g(f.dark, -15, 9) * g(f.relChroma, 0.35, 0.2) * g(r, 6, 3.2) * g(f.texture, 7, 4);
    s["cabbage-tree"] = g(r, 1.7, 0.7) * g(f.dark, -12, 11) * g(f.relChroma, 0.72, 0.32);
    s[FALLBACK] = 0.06 + 0.9 * g(f.dark, -20, 10) * g(f.relChroma, 0.75, 0.3) * g(r, 4.5, 2.6);
    return s;
  }

  /* ------------------------------------------------------------------ water */

  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    var t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
    return Math.hypot(px - ax - dx * t, py - ay - dy * t);
  }
  function inside(ring, x, y) {
    var c = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }
  /* Pixels from (x, y) to the nearest water ring's edge (0 inside one). */
  function waterDistance(rings, x, y) {
    var best = Infinity;
    (rings || []).forEach(function (ring) {
      if (!ring || ring.length < 3) return;
      if (inside(ring, x, y)) { best = 0; return; }
      for (var i = 0; i < ring.length; i++) {
        var a = ring[i], b = ring[(i + 1) % ring.length];
        best = Math.min(best, segDist(x, y, a.x, a.y, b.x, b.y));
      }
    });
    return best;
  }

  /* ------------------------------------------------------------------ the guess */

  /* trees: [{x, y, r}] - x, y in the image's pixels, r the crown radius in metres.
     opts: {image: {width, height, data} | null, pxPerMetre, water: [[{x, y}]] in the same
     pixels, lat}. Returns one species id per tree, in order. */
  function classify(trees, opts) {
    opts = opts || {};
    var ppm = Number(opts.pxPerMetre) || 1, image = opts.image || null;
    var own = trees.map(function (t) {
      var rPx = Math.max(1, t.r * ppm);
      var f = image ? crownFeatures(image, t.x, t.y, rPx) : null;
      var nearWater = (waterDistance(opts.water, t.x, t.y) / ppm) - t.r <= WATER_NEAR_M;
      var s = scores(f, t.r, nearWater, Number(opts.lat));
      var total = SPECIES.reduce(function (a, id) { return a + s[id]; }, 0) || 1;
      SPECIES.forEach(function (id) { s[id] /= total; });
      return s;
    });

    /* Stands: trees within a crown or two of each other (edge to edge under STAND_GAP_M) are
       one stand, joined through a grid so this stays linear in the tree count. */
    var parent = trees.map(function (_, i) { return i; });
    function root(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    /* A cell as wide as the furthest two crowns can be and still touch, so checking the cells
       next door finds every partner. */
    var maxR = trees.reduce(function (m, t) { return Math.max(m, t.r); }, 0);
    var cell = Math.max(1, (2 * maxR + STAND_GAP_M) * ppm), grid = {};
    trees.forEach(function (t, i) {
      var cx = Math.floor(t.x / cell), cy = Math.floor(t.y / cell);
      for (var gx = cx - 1; gx <= cx + 1; gx++) for (var gy = cy - 1; gy <= cy + 1; gy++) {
        (grid[gx + "," + gy] || []).forEach(function (j) {
          var o = trees[j];
          if (Math.hypot(o.x - t.x, o.y - t.y) <= (t.r + o.r + STAND_GAP_M) * ppm) parent[root(i)] = root(j);
        });
      }
      (grid[cx + "," + cy] = grid[cx + "," + cy] || []).push(i);
    });
    var stands = {};
    trees.forEach(function (_, i) {
      var k = root(i), st = stands[k] = stands[k] || { n: 0, sum: {} };
      st.n++;
      SPECIES.forEach(function (id) { st.sum[id] = (st.sum[id] || 0) + own[i][id]; });
    });
    /* A tree that is clearly one species keeps it (a cabbage tree beside a pōhutukawa); a
       borderline one takes its stand's pick, so a shelter belt is one species, not a patchwork. */
    function top2(scoresById) {
      var ids = SPECIES.slice().sort(function (x, y) { return scoresById[y] - scoresById[x]; });
      return { best: ids[0], margin: scoresById[ids[0]] - scoresById[ids[1]] };
    }
    return trees.map(function (t, i) {
      var mine = top2(own[i]), st = stands[root(i)];
      if (st.n < 2 || mine.margin >= CONFIDENT_MARGIN) return mine.best;
      return top2(st.sum).best;
    });
  }

  /* "12 radiata pine, 4 willow" - for a readout. */
  var NAMES = {
    "radiata-pine": "radiata pine", "macrocarpa": "macrocarpa", "poplar": "poplar", "willow": "willow",
    "eucalyptus": "eucalyptus", "pohutukawa": "pōhutukawa", "cabbage-tree": "cabbage tree", "native-broadleaf": "native broadleaf"
  };
  function summary(ids) {
    var counts = {};
    ids.forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
      .map(function (id) { return counts[id] + " " + (NAMES[id] || id); }).join(", ");
  }

  return {
    SPECIES: SPECIES, FALLBACK: FALLBACK, WATER_NEAR_M: WATER_NEAR_M,
    crownFeatures: crownFeatures, scores: scores, waterDistance: waterDistance, classify: classify, summary: summary, lab: lab
  };
});
