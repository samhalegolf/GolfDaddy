/* Green tiers, drawn from the SAME display list as the contour lines.
 *
 * The point of this file is the architecture, not the pixels. gd-green-contours-core.js exists so
 * that "how a green is read" has exactly one implementation and two thin renderers - SVG on the
 * server, canvas on the phone. The tier bands live there too: emitted in green-local metres with
 * colour and alpha already resolved, exactly like runs and arrows, so the export and the phone
 * cannot drift.
 *
 * An earlier version painted tiers into the flattened pixels in the compositor instead. That
 * worked, but it was a third opinion about the green in a third place, it could only ever reach
 * the export, and it had to be told whether the phone was going to paint too. Those tests are
 * gone with it; these assert the display list.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";
import { renderHoleSurfaceMercator, greenContourSvg } from "../functions/lib/gd-visual-export-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const greenCore = require(path.join(__dirname, "..", "scripts", "gd-green-contours-core.js"));

const D = 256;
const bounds = { north: -36.7495, west: 174.7500, south: -36.7535, east: 174.7545 };
const midLat = (bounds.north + bounds.south) / 2;
const midLng = (bounds.west + bounds.east) / 2;
const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function turfCapture() {
  const raw = Buffer.alloc(D * D * 3);
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const drift = (y / D) * 18;
      const band = ((Math.floor(y / 9) % 2) ? 6 : -6);
      const grain = Math.sin(x * 1.7 + y * 0.9) * 3 + Math.sin(x * 0.31 - y * 2.3) * 2.5;
      const i = (y * D + x) * 3;
      raw[i] = 108 + drift + band + grain;
      raw[i + 1] = 116 + drift * 0.8 + band + grain;
      raw[i + 2] = 96 + drift * 0.7 + band * 0.8 + grain;
    }
  }
  return sharp(raw, { raw: { width: D, height: D, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

function buildGreenSurface() {
  const W = 64, H = 64;
  const gb = {
    north: midLat + 0.00040, south: midLat - 0.00040,
    west: midLng - 0.00050, east: midLng + 0.00050
  };
  const heights = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) heights[y * W + x] = 40 + (x / (W - 1)) * 2.4;
  }
  const shape = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    shape.push({ lat: midLat + Math.sin(a) * 0.00030, lng: midLng + Math.cos(a) * 0.00040 });
  }
  const surface = greenCore.fitGreenSurface(heights, { width: W, height: H, bounds: gb, metresPerPixel: 1.39 }, shape);
  assert.ok(surface && surface.fit, "fixture green must fit");
  return surface;
}

/* A palette shaped like real turf: a run from dark olive to pale sand-green. */
function fixturePalette() {
  const rgb = [];
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    const t = i / 3999;
    rgb.push(100 + t * 58, 110 + t * 44, 92 + t * 48);
    n++;
  }
  const pal = greenCore.sampleGreenPalette(rgb, n);
  assert.ok(pal, "fixture palette must build");
  return pal;
}

/* Same shape, far wider run - the case that broke: at spread 0.6 a 72-luma green was pushed
   43 luma past its own ends and went chalky at the top, near-black at the bottom. */
function widePalette() {
  const rgb = [];
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    const t = i / 3999;
    rgb.push(40 + t * 190, 70 + t * 160, 40 + t * 170);
    n++;
  }
  const pal = greenCore.sampleGreenPalette(rgb, n);
  assert.ok(pal, "wide fixture palette must build");
  return pal;
}
const lumaOfLut = (pal, i) => {
  const o = i * 3;
  return 0.2126 * pal.lut[o] + 0.7152 * pal.lut[o + 1] + 0.0722 * pal.lut[o + 2];
};

const results = [];
const check = (name, fn) => results.push({ name, fn });

check("bands come out of the same display list as the lines", async () => {
  const surface = buildGreenSurface();
  const drawing = greenCore.buildGreenDrawing(surface, { palette: fixturePalette() });
  assert.ok(drawing, "drawing must build");
  assert.ok(Array.isArray(drawing.runs) && drawing.runs.length, "lines must still be there");
  assert.ok(Array.isArray(drawing.bands) && drawing.bands.length, "bands must be emitted");
  const b = drawing.bands[0];
  assert.equal(b.quad.length, 4, "a band is four points");
  for (const p of b.quad) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "band points are metres, not pixels");
    assert.ok(Math.abs(p.x) < 200 && Math.abs(p.y) < 200, "green-local metres, so small numbers");
  }
  assert.match(b.colour, /^rgb\(\d+,\d+,\d+\)$/, "colour resolved in the core, like runs");
  assert.ok(b.alpha > 0 && b.alpha <= 1, "alpha resolved in the core");
  return drawing.bands.length + " bands, " + drawing.runs.length + " runs";
});

check("tier colours run dark low to light high", async () => {
  const surface = buildGreenSurface();
  const drawing = greenCore.buildGreenDrawing(surface, { palette: fixturePalette() });
  const byTier = new Map();
  for (const b of drawing.bands) if (!byTier.has(b.tier)) byTier.set(b.tier, b.colour);
  const tiers = [...byTier.keys()].sort((a, b) => a - b);
  assert.ok(tiers.length >= 3, "need several tiers, got " + tiers.length);
  const lum = t => {
    const m = byTier.get(t).match(/(\d+),(\d+),(\d+)/);
    return luma([+m[1], +m[2], +m[3]]);
  };
  const first = lum(tiers[0]), last = lum(tiers[tiers.length - 1]);
  assert.ok(last > first, "high tier must be lighter: " + first.toFixed(1) + " -> " + last.toFixed(1));
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(lum(tiers[i]) >= lum(tiers[i - 1]) - 0.01, "tier colours must not go backwards");
  }
  return tiers.length + " tiers, " + first.toFixed(0) + " -> " + last.toFixed(0) + " luma";
});

check("no palette means no bands, and the lines are unaffected", async () => {
  const surface = buildGreenSurface();
  const withNone = greenCore.buildGreenDrawing(surface, {});
  const withPal = greenCore.buildGreenDrawing(surface, { palette: fixturePalette() });
  assert.equal(withNone.bands.length, 0, "no palette, no bands");
  assert.equal(withNone.runs.length, withPal.runs.length, "bands must not disturb the line work");
  return "lines identical either way (" + withNone.runs.length + " runs)";
});

check("bands fade out at the green edge, like the lines do", async () => {
  const surface = buildGreenSurface();
  const drawing = greenCore.buildGreenDrawing(surface, { palette: fixturePalette() });
  /* classify by the band's CENTRE, which is where the core evaluates the fade */
  const mid = b => ({
    x: (b.quad[0].x + b.quad[1].x) / 2,
    y: (b.quad[0].y + b.quad[2].y) / 2
  });
  const dist = b => { const m = mid(b); return greenCore.distanceToPolygon(m.x, m.y, surface.polygon); };
  const inner = drawing.bands.filter(b => dist(b) > 6);
  const outer = drawing.bands.filter(b => dist(b) < 1.0);
  assert.ok(inner.length && outer.length, "need bands both inside and at the rim");
  const avg = a => a.reduce((s, b) => s + b.alpha, 0) / a.length;
  assert.ok(avg(outer) < avg(inner) * 0.75,
    "rim bands must be fainter: rim " + avg(outer).toFixed(3) + " vs inner " + avg(inner).toFixed(3));
  return "rim " + avg(outer).toFixed(3) + " vs inner " + avg(inner).toFixed(3) + " alpha";
});

check("the server renders bands as fills, under the lines", async () => {
  const surface = buildGreenSurface();
  const project = ll => ({ left: 128 + (ll.lng - midLng) * 40000, top: 128 - (ll.lat - midLat) * 40000 });
  const svg = greenContourSvg(surface, D, D, project, { palette: fixturePalette() });
  assert.ok(svg, "svg must render");
  const text = svg.toString("utf8");
  const firstFill = text.indexOf('fill="rgb(');
  const firstStroke = text.indexOf('stroke="');
  assert.ok(firstFill > 0, "bands must appear as fills");
  assert.ok(firstFill < firstStroke, "bands must be written before the lines, so lines sit on top");
  return (text.match(/fill="rgb\(/g) || []).length + " filled bands in the svg";
});

check("the export publishes a palette and paints no pixels itself", async () => {
  const surface = buildGreenSurface();
  const buf = await turfCapture();
  const render = settings => renderHoleSurfaceMercator({
    pins: {}, captures: [{ entry: { role: "course-backdrop", bounds, width: D, height: D, stitchLayer: 0, captureZoom: 18 }, buffer: buf }],
    terrain: null, greenSurface: surface, settings, maxDim: D, quality: 96
  });
  const on = await render({ visualTools: {} });
  assert.ok(on.greenPalette, "palette must be measured and published");
  assert.equal(on.greenPalette.bins, 32);
  assert.ok(on.greenPalette.samples > 400, "palette needs real samples, got " + on.greenPalette.samples);
  assert.equal(on.diagnostics.greenPaint, undefined, "nothing paints pixels any more");
  const off = await render({ visualTools: { greenPaint: false } });
  assert.equal(off.greenPalette, null, "greenPaint:false stops the measurement too");
  return on.greenPalette.samples + " px sampled, " + JSON.stringify(on.greenPalette).length + " bytes";
});

check("a green that is a sliver of the frame still gets a palette", async () => {
  /* The regression this exists for. A green fills ~40% of a green frame but ~4% of a hole
     frame. Sampling at one fixed working resolution starved the hole frame - the green came
     out ~19px across, under the 400-sample floor - and 15 of 18 hole frames published with no
     palette. The sampler now reads the green's own box at native resolution, so the sample
     count follows the green rather than the frame. */
  const surface = buildGreenSurface();
  const buf = await turfCapture();
  /* Same green, but framed like a whole hole: ~8x the extent, so the green is a sliver. */
  /* Proportioned like the real thing: a 30m green in an 830m hole frame is ~3.6% of the
     width, which at export resolution is ~110px across - plenty of pixels, just a small
     share of the frame. That distinction is exactly what the old sampler lost. */
  const wide = {
    north: midLat + 0.0100, south: midLat - 0.0100,
    west: midLng - 0.0100, east: midLng + 0.0100
  };
  const out = await renderHoleSurfaceMercator({
    pins: {},
    captures: [{ entry: { role: "course-backdrop", bounds: wide, width: D, height: D, stitchLayer: 0, captureZoom: 18 }, buffer: buf }],
    terrain: null, greenSurface: surface, settings: { visualTools: {} }, maxDim: 2048, quality: 92
  });
  assert.ok(out.greenPalette, "a sliver-sized green must still be measured");
  assert.ok(out.greenPalette.samples >= 400,
    "needs a real sample count off a small green, got " + out.greenPalette.samples);
  return out.greenPalette.samples + " px sampled from a green ~" +
    (100 * (0.0008 / 0.020)).toFixed(1) + "% of the frame width";
});

check("extrapolation is capped in absolute luma, not as a share of the run", async () => {
  const surface = buildGreenSurface();
  const narrow = fixturePalette(), wide = widePalette();
  const runOf = p => lumaOfLut(p, (p.bins || p.lut.length / 3) - 1) - lumaOfLut(p, 0);
  const nRun = runOf(narrow), wRun = runOf(wide);
  assert.ok(wRun > nRun * 2.5, "fixtures must differ enough to test the cap");

  const reach = pal => {
    const d = greenCore.buildGreenDrawing(surface, { palette: pal });
    const tiers = new Map();
    for (const b of d.bands) if (!tiers.has(b.tier)) tiers.set(b.tier, b.colour);
    const ls = [...tiers.keys()].sort((a, b) => a - b).map(t => {
      const m = tiers.get(t).match(/(\d+),(\d+),(\d+)/);
      return luma([+m[1], +m[2], +m[3]]);
    });
    /* how far the extreme tier colours sit outside the palette's own sampled ends */
    const lo = lumaOfLut(pal, 0), hi = lumaOfLut(pal, (pal.bins || pal.lut.length / 3) - 1);
    return Math.max(lo - ls[0], ls[ls.length - 1] - hi);
  };
  const cap = greenCore.PAINT_DEFAULTS.maxExtrapLuma;
  const nReach = reach(narrow), wReach = reach(wide);
  assert.ok(nReach <= cap + 1.5, "narrow green must stay within the cap, got " + nReach.toFixed(1));
  assert.ok(wReach <= cap + 1.5, "wide green must be pulled back to the cap, got " + wReach.toFixed(1));
  /* the whole point: without the cap the wide green would reach proportionally further */
  assert.ok(wRun * greenCore.PAINT_DEFAULTS.spread > cap * 1.5,
    "the wide fixture must be one the cap actually bites on");
  return "run " + nRun.toFixed(0) + "/" + wRun.toFixed(0) + " luma -> reach " +
    nReach.toFixed(1) + "/" + wReach.toFixed(1) + " (cap " + cap + ")";
});

check("a green with no fitted surface draws nothing and fails quietly", async () => {
  const buf = await turfCapture();
  const out = await renderHoleSurfaceMercator({
    pins: {}, captures: [{ entry: { role: "course-backdrop", bounds, width: D, height: D, stitchLayer: 0, captureZoom: 18 }, buffer: buf }],
    terrain: null, greenSurface: null, settings: { visualTools: {} }, maxDim: D, quality: 96
  });
  assert.equal(out.greenPalette, null);
  assert.ok(out.jpeg && out.jpeg.length > 0, "the hole still publishes");
  return "skipped cleanly";
});

(async () => {
  console.log("green tiers (display list)\n");
  let failed = 0;
  for (const { name, fn } of results) {
    try {
      const note = await fn();
      console.log("  ok   " + name + (note ? "  (" + note + ")" : ""));
    } catch (error) {
      failed++;
      console.log("  FAIL " + name + "\n       " + (error && error.message));
    }
  }
  console.log("\n" + (results.length - failed) + " passed" + (failed ? ", " + failed + " failed" : ""));
  process.exit(failed ? 1 : 0);
})();
