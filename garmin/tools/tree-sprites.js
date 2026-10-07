#!/usr/bin/env node
/* The tree sprites both watches stamp over a hole map - drawn here, from code, so they are our
 * own art and can be retuned and regenerated in seconds.
 *
 *   node garmin/tools/tree-sprites.js
 *
 * Writes:
 *   garmin/resources-trees/drawables/trees/{amoled,mip}/<type>_<size>.png  + trees.xml
 *   garmin/source/Maps/GarminTreeSpriteIds.mc (the resource ids, as tables)
 *   ios/App/ClarityCaddyWatch/Assets.xcassets/tree_<type>.imageset
 *
 * Types follow scripts/gd-watch-map-core.js TREE_TYPES (the tree list's type field). A crown is
 * a bumpy dome - big lobes for the silhouette, each covered in small leaf clumps - lit from the
 * top-left, with a darker rim and a shadow cast down-right. Pine is stacked tiers of branch
 * tips. Rendered at 8x and downsampled to each size.
 *
 * Every PNG is its nominal crown size plus a shadow pad on the right and bottom: draw it at
 * (centre - size/2) and the crown lands centred. Garmin draws them 1:1 (no runtime scaling), so
 * it gets five sizes; Apple Watch scales one large sprite.
 *
 * MIP: binary alpha, every pixel one of Garmin's 64 colours (each channel 00/55/AA/FF) - the
 * 64-colour screens snap anything else, and soft greens snap to grey. A per-type ramp of four
 * tones is picked by how lit each pixel is, and the shadow is solid black.
 */
const fs = require("fs");
const path = require("path");
const sharp = require(path.join(__dirname, "../../node_modules/sharp"));

const ROOT = path.join(__dirname, "../..");
const GARMIN_DIR = path.join(ROOT, "garmin/resources-trees/drawables");
const APPLE_DIR = path.join(ROOT, "ios/App/ClarityCaddyWatch/Assets.xcassets");
const TYPES = ["round", "broadleaf", "pine", "yellow_green"]; // gd-watch-map-core.js TREE_TYPES
const GARMIN_SIZES = [8, 12, 16, 22, 28];
const APPLE_SIZE = 96;
const SUPERSAMPLE = 8;
/* Shadow pad, as a fraction of the crown size. Mirrored in GarminTreeSprites.mc and
   HoleMapView.swift's TreeSprites. */
const PAD_FRACTION = 0.14;
const pad = size => Math.max(1, Math.round(size * PAD_FRACTION));

/* AMOLED / Apple tones, dark to light. */
const STYLE = {
  round:        { seed: 11, lobes: 9, ring: 0.52, lobeR: [0.34, 0.44], tones: [0x173210, 0x264b17, 0x3c711f, 0x62972f, 0x89b14a] },
  broadleaf:    { seed: 23, lobes: 6, ring: 0.50, lobeR: [0.40, 0.50], tones: [0x162f12, 0x24491a, 0x376824, 0x568a32, 0x7ba74b] },
  pine:         { seed: 37, pine: true,                              tones: [0x0c2212, 0x15341b, 0x224d29, 0x336836, 0x50834a] },
  yellow_green: { seed: 53, lobes: 8, ring: 0.52, lobeR: [0.34, 0.44], tones: [0x323c0d, 0x536410, 0x809018, 0xa4af29, 0xc1c464] }
};
const MIP_RAMP = {
  round:        [0x000000, 0x005500, 0x00aa00, 0x55aa00],
  broadleaf:    [0x000000, 0x005500, 0x00aa00, 0x55aa00],
  pine:         [0x000000, 0x000000, 0x005500, 0x00aa00],
  yellow_green: [0x555500, 0x555500, 0xaaaa00, 0xaaff00]
};
const SHADOW_ALPHA = 105;
const LIGHT = (() => { const v = [-0.55, -0.65, 0.52], n = Math.hypot(...v); return v.map(x => x / n); })();
const rgb = h => [h >> 16, (h >> 8) & 255, h & 255];
const random = seed => () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

/* The crown's height field over unit space (radius 1): {h, nx, ny, nz, d} or null outside. */
function crown(style) {
  const r = random(style.seed);
  if (style.pine) {
    const tiers = [];
    for (let k = 0; k < 5; k++) tiers.push({ R: 1 - k * 0.19, arms: 11 - k, phase: r() * 6.28, z: k * 0.22, ox: -0.03 * k, oy: -0.04 * k });
    return (x, y) => {
      let best = null;
      tiers.forEach((t, k) => {
        const dx = x - t.ox, dy = y - t.oy, a = Math.atan2(dy, dx), d = Math.hypot(dx, dy);
        const edge = t.R * (0.7 + 0.3 * Math.pow(Math.abs(Math.cos((a + t.phase) * t.arms / 2)), 0.5));
        if (d > edge) return;
        const h = t.z + (1 - d / edge) * 0.25, ridge = 0.6 * Math.sin((a + t.phase) * t.arms);
        const nx = Math.cos(a) * 0.9 - Math.sin(a) * ridge, ny = Math.sin(a) * 0.9 + Math.cos(a) * ridge, n = Math.hypot(nx, ny, 1);
        if (!best || h > best.h) best = { h, nx: nx / n, ny: ny / n, nz: 1 / n, d: (d / t.R) * (k === 0 ? 1 : 0.5) };
      });
      return best;
    };
  }
  const big = [{ x: 0, y: 0, r: 0.55 }], lobes = [];
  for (let i = 0; i < style.lobes; i++) {
    const a = (i / style.lobes) * 6.283 + r() * 0.5, d = style.ring * (0.8 + 0.35 * r());
    big.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: style.lobeR[0] + (style.lobeR[1] - style.lobeR[0]) * r() });
  }
  big.forEach(b => {
    lobes.push({ x: b.x, y: b.y, r: b.r * 0.92, base: 0 });
    const clumps = Math.round(6 + 10 * b.r);
    for (let k = 0; k < clumps; k++) {
      const a = r() * 6.283, d = b.r * Math.sqrt(r()) * 0.85, cr = b.r * (0.22 + 0.16 * r());
      lobes.push({ x: b.x + Math.cos(a) * d, y: b.y + Math.sin(a) * d, r: cr, base: Math.sqrt(Math.max(0, b.r * b.r - d * d)) * 0.85 - cr * 0.6 });
    }
  });
  let extent = 0;
  lobes.forEach(l => { extent = Math.max(extent, Math.hypot(l.x, l.y) + l.r); });
  lobes.forEach(l => { l.x /= extent; l.y /= extent; l.r /= extent; l.base /= extent; });
  return (x, y) => {
    let best = null;
    for (const l of lobes) {
      const dx = x - l.x, dy = y - l.y, q = l.r * l.r - dx * dx - dy * dy;
      if (q <= 0) continue;
      const z = Math.sqrt(q), h = z + l.base;
      if (!best || h > best.h) best = { h, nx: dx / l.r, ny: dy / l.r, nz: z / l.r, d: Math.hypot(x, y) };
    }
    return best;
  };
}

/* One sprite, supersampled, then downsampled: RGBA buffer of (size + pad)^2. */
async function render(type, size) {
  const style = STYLE[type], P = pad(size), W = (size + P) * SUPERSAMPLE, R = (size * SUPERSAMPLE) / 2;
  const f = crown(style), tones = style.tones.map(rgb), cast = P * SUPERSAMPLE * 0.9;
  const big = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, c = f((x - R) / R, (y - R) / R);
    if (c) {
      const lit = (c.nx * LIGHT[0] + c.ny * LIGHT[1] + c.nz * LIGHT[2]) * 0.85 + c.h * 0.25 - (c.d > 0.9 ? 0.25 : 0);
      const k = Math.max(0, Math.min(tones.length - 1.001, (lit + 0.15) * (tones.length - 1)));
      const i = Math.floor(k), t = k - i, A = tones[i], B = tones[i + 1];
      for (let ch = 0; ch < 3; ch++) big[o + ch] = A[ch] + (B[ch] - A[ch]) * t;
      big[o + 3] = 255;
    } else if (f((x - R - cast) / R, (y - R - cast) / R)) {
      big[o + 3] = SHADOW_ALPHA;
    }
  }
  const out = size + P;
  const small = await sharp(big, { raw: { width: W, height: W, channels: 4 } }).resize(out, out, { kernel: "lanczos3" }).raw().toBuffer();
  return { small, out };
}

function toMip(type, small, out) {
  const tones = STYLE[type].tones.map(rgb), lum = c => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const lo = lum(tones[0]), hi = lum(tones[tones.length - 1]), ramp = MIP_RAMP[type].map(rgb);
  const mip = Buffer.alloc(out * out * 4);
  for (let i = 0; i < out * out; i++) {
    const a = small[4 * i + 3];
    if (a < 100) continue;
    let colour = [0, 0, 0];
    if (a > 160) {
      const l = lum([small[4 * i], small[4 * i + 1], small[4 * i + 2]].map(v => (v * 255) / a));
      colour = ramp[Math.max(0, Math.min(3, Math.floor(((l - lo) / (hi - lo)) * 4.2)))];
    }
    mip.set([colour[0], colour[1], colour[2], 255], 4 * i);
  }
  return mip;
}

const png = (buffer, size, file) => sharp(buffer, { raw: { width: size, height: size, channels: 4 } }).png().toFile(file);

(async () => {
  const trees = path.join(GARMIN_DIR, "trees");
  for (const set of ["amoled", "mip"]) fs.mkdirSync(path.join(trees, set), { recursive: true });
  const xml = ['<drawables>', '    <!-- GENERATED by garmin/tools/tree-sprites.js - do not edit. A = AMOLED, M = MIP (64 colours); index = TREE_TYPES. -->'];
  for (let t = 0; t < TYPES.length; t++) for (const size of GARMIN_SIZES) {
    const { small, out } = await render(TYPES[t], size);
    const name = TYPES[t] + "_" + size + ".png";
    await png(small, out, path.join(trees, "amoled", name));
    await png(toMip(TYPES[t], small, out), out, path.join(trees, "mip", name));
    xml.push(`    <bitmap id="TreeA${t}_${size}" filename="trees/amoled/${name}" dithering="none"/>`);
    xml.push(`    <bitmap id="TreeM${t}_${size}" filename="trees/mip/${name}" dithering="none"/>`);
  }
  xml.push("</drawables>", "");
  fs.writeFileSync(path.join(GARMIN_DIR, "trees.xml"), xml.join("\n"));
  const table = set => "[\n" + TYPES.map((type, t) => "        [" + GARMIN_SIZES.map(size => `Rez.Drawables.Tree${set}${t}_${size}`).join(", ") + "]").join(",\n") + "\n    ]";
  fs.writeFileSync(path.join(ROOT, "garmin/source/Maps/GarminTreeSpriteIds.mc"), [
    "// GENERATED by garmin/tools/tree-sprites.js - do not edit.",
    "using Toybox.WatchUi;",
    "",
    "// The tree sprite resources, [type][size] - type is TREE_TYPES (" + TYPES.join(", ") + "),",
    "// size indexes SIZES. PAD_FRACTION is the shadow pad beyond the nominal crown size.",
    "module GarminTreeSpriteIds {",
    "    const SIZES = [" + GARMIN_SIZES.join(", ") + "];",
    "    const PAD_FRACTION = " + PAD_FRACTION + ";",
    "    function amoled() {",
    "        return " + table("A") + ";",
    "    }",
    "    function mip() {",
    "        return " + table("M") + ";",
    "    }",
    "}",
    ""
  ].join("\n"));

  for (const type of TYPES) {
    const dir = path.join(APPLE_DIR, "tree_" + type + ".imageset");
    fs.mkdirSync(dir, { recursive: true });
    const { small, out } = await render(type, APPLE_SIZE);
    await png(small, out, path.join(dir, "tree_" + type + ".png"));
    fs.writeFileSync(path.join(dir, "Contents.json"), JSON.stringify({
      images: [{ filename: "tree_" + type + ".png", idiom: "universal" }],
      info: { author: "xcode", version: 1 }
    }, null, 2) + "\n");
  }
  console.log("tree sprites: " + TYPES.length * GARMIN_SIZES.length * 2 + " Garmin bitmaps, " + TYPES.length + " Apple Watch images");
})();
