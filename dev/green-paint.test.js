/* Green paint, proven on the real export path.
 *
 * The claim being tested is narrow and easy to fake: that the putting surface is tiered in
 * colours the green already has, low end dark, high end light, WITHOUT flattening the turf
 * underneath. Each of those is a separate assertion here, because a flat tint would pass a
 * naive "did the pixels change" check and fail every one of them.
 *
 * Runs renderHoleSurfaceMercator rather than applyGreenPaint directly, the same way
 * course-visual-export-normalisation.test.js does, so ordering against tone, relief and the
 * contour overlay is covered too.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";
import { renderHoleSurfaceMercator } from "../functions/lib/gd-visual-export-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const greenCore = require(path.join(__dirname, "..", "scripts", "gd-green-contours-core.js"));

const D = 256;
const bounds = { north: -36.7495, west: 174.7500, south: -36.7535, east: 174.7545 };
const midLat = (bounds.north + bounds.south) / 2;
const midLng = (bounds.west + bounds.east) / 2;

/* Turf, not a colour swatch: a slow warm/light drift plus mowing bands, so the palette has a
   real run to find and the test can tell "texture survived" from "texture was painted over". */
function turfCapture() {
  const raw = Buffer.alloc(D * D * 3);
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const drift = (y / D) * 18;   // north-south, while the green falls east-west
      const band = ((Math.floor(y / 9) % 2) ? 6 : -6);
      /* fine, non-repeating grain so the fixture reads like turf rather than a 5-level poster */
      const grain = Math.sin(x * 1.7 + y * 0.9) * 3 + Math.sin(x * 0.31 - y * 2.3) * 2.5;
      const i = (y * D + x) * 3;
      raw[i] = 108 + drift + band + grain;
      raw[i + 1] = 116 + drift * 0.8 + band + grain;
      raw[i + 2] = 96 + drift * 0.7 + band * 0.8 + grain;
    }
  }
  return sharp(raw, { raw: { width: D, height: D, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

/* A green tilted along +lng, fitted through the real fitter so the paint reads the same
   analytic surface the contours do. */
function buildGreenSurface() {
  const W = 64, H = 64;
  const gb = {
    north: midLat + 0.00040, south: midLat - 0.00040,
    west: midLng - 0.00050, east: midLng + 0.00050
  };
  const heights = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) heights[y * W + x] = 40 + (x / (W - 1)) * 2.4;   // 2.4m of fall
  }
  const shape = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    shape.push({ lat: midLat + Math.sin(a) * 0.00030, lng: midLng + Math.cos(a) * 0.00040 });
  }
  const surface = greenCore.fitGreenSurface(heights, {
    width: W, height: H, bounds: gb, metresPerPixel: 1.39
  }, shape);
  assert.ok(surface && surface.fit, "fixture green must fit");
  return { surface, shape };
}

const settingsWith = extra => ({ visualTools: Object.assign({ greenContours: false }, extra || {}) });

async function render(buffer, surface, settings) {
  return renderHoleSurfaceMercator({
    pins: {}, captures: [{ entry: { role: "course-backdrop", bounds, width: D, height: D, stitchLayer: 0, captureZoom: 18 }, buffer }],
    terrain: null, greenSurface: surface, settings, maxDim: D, quality: 96
  });
}

/* Sample the published jpeg at a green-local metres position. */
async function sampler(jpeg, surface, out) {
  const raw = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = raw.info;
  return (mx, my) => {
    const ll = surface.frame.toLatLng(mx, my);
    const px = Math.round(((ll.lng - bounds.west) / (bounds.east - bounds.west)) * width);
    const mercY = lat => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
    const y0 = mercY(bounds.north), y1 = mercY(bounds.south);
    const py = Math.round(((mercY(ll.lat) - y0) / (y1 - y0)) * height);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const o = (py * width + px) * channels;
    return [raw.data[o], raw.data[o + 1], raw.data[o + 2]];
  };
}
const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const results = [];
const check = (name, fn) => results.push({ name, fn });

check("palette is baked, monotonic, and small enough for the index", async () => {
  const { surface } = buildGreenSurface();
  const painted = await render(await turfCapture(), surface, settingsWith());
  const pal = painted.greenPalette;
  assert.ok(pal, "greenPalette must be returned for a fitted green");
  assert.equal(pal.bins, 32);
  assert.equal(pal.lut.length, 96);
  assert.equal(pal.stops.length, 33);
  for (let i = 1; i < pal.stops.length; i++) {
    assert.ok(pal.stops[i] > pal.stops[i - 1], "stops must be strictly increasing");
  }
  assert.ok(pal.samples > 400, "needs a real sample count, got " + pal.samples);
  const bytes = JSON.stringify(pal).length;
  assert.ok(bytes < 1200, "palette must stay index-sized, was " + bytes + " bytes");
  return pal.samples + " px sampled, " + bytes + " bytes";
});

check("low ground darkens and high ground lightens", async () => {
  const { surface } = buildGreenSurface();
  const buf = await turfCapture();
  const off = await render(buf, surface, settingsWith({ greenPaint: false }));
  const on = await render(buf, surface, settingsWith());
  const sOff = await sampler(off.jpeg, surface);
  const sOn = await sampler(on.jpeg, surface);
  /* The fixture falls along +x in green-local metres, so -8m is the low end and +8m the high. */
  const lowOff = sOff(-20, 0), lowOn = sOn(-20, 0);
  const highOff = sOff(20, 0), highOn = sOn(20, 0);
  assert.ok(lowOff && lowOn && highOff && highOn, "sample points must land inside the frame");
  const dLow = luma(lowOn) - luma(lowOff);
  const dHigh = luma(highOn) - luma(highOff);
  /* The claim is that the two ends SEPARATE, and in the right order. Asserting each end's
     absolute move instead would be asserting the fixture's palette width, which is arbitrary. */
  assert.ok(dLow < 0, "low end must move darker, moved " + dLow.toFixed(1));
  assert.ok(dHigh > 0, "high end must move lighter, moved " + dHigh.toFixed(1));
  assert.ok(dHigh - dLow > 3, "tiers must separate the ends, got " + (dHigh - dLow).toFixed(1));
  return "low " + dLow.toFixed(1) + ", high +" + dHigh.toFixed(1) + ", separation " + (dHigh - dLow).toFixed(1);
});

check("mowing texture survives the paint", async () => {
  const { surface } = buildGreenSurface();
  const buf = await turfCapture();
  const off = await render(buf, surface, settingsWith({ greenPaint: false }));
  const on = await render(buf, surface, settingsWith());
  const sOff = await sampler(off.jpeg, surface), sOn = await sampler(on.jpeg, surface);
  /* Band-to-band swing at one spot: a flat fill would erase it, a displacement keeps it. */
  const swing = s => {
    let lo = Infinity, hi = -Infinity;
    for (let dy = -3; dy <= 3; dy += 0.5) {
      const c = s(0, dy); if (!c) continue;
      const L = luma(c); if (L < lo) lo = L; if (L > hi) hi = L;
    }
    return hi - lo;
  };
  const before = swing(sOff), after = swing(sOn);
  assert.ok(after > before * 0.25, "texture swing collapsed: " + before.toFixed(1) + " -> " + after.toFixed(1));
  return "swing " + before.toFixed(1) + " -> " + after.toFixed(1) + " kept";
});

check("nothing outside the green polygon is touched", async () => {
  const { surface } = buildGreenSurface();
  const buf = await turfCapture();
  const off = await render(buf, surface, settingsWith({ greenPaint: false }));
  const on = await render(buf, surface, settingsWith());
  const a = await sharp(off.jpeg).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(on.jpeg).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = a.info;
  let changedOutside = 0, changedInside = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const o = (y * width + x) * channels;
      const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]);
      const ll = { lat: 0, lng: 0 };
      ll.lng = bounds.west + (x / width) * (bounds.east - bounds.west);
      const t = y / height;
      ll.lat = bounds.north + t * (bounds.south - bounds.north);
      const m = surface.frame.toMetres(ll.lat, ll.lng);
      const inside = greenCore.pointInPolygon(m.x, m.y, surface.polygon);
      /* jpeg ringing near the feathered edge is real, so only count a decisive move */
      if (d > 12) { if (inside) changedInside++; else changedOutside++; }
    }
  }
  assert.ok(changedInside > 0, "paint must reach the green");
  assert.ok(changedOutside <= changedInside * 0.08,
    "paint leaked outside: " + changedOutside + " outside vs " + changedInside + " inside");
  return changedInside + " px moved inside, " + changedOutside + " outside";
});

check("greenPaint:false is a real off switch", async () => {
  const { surface } = buildGreenSurface();
  const painted = await render(await turfCapture(), surface, settingsWith({ greenPaint: false }));
  assert.equal(painted.greenPalette, null, "no palette when the tool is off");
  return "off";
});

check("no fitted surface means no paint and no palette", async () => {
  const painted = await render(await turfCapture(), null, settingsWith());
  assert.equal(painted.greenPalette, null);
  return "skipped cleanly";
});

check("spread past the sampled range is reported, not hidden", async () => {
  const { surface } = buildGreenSurface();
  const buf = await turfCapture();
  const tight = await render(buf, surface, settingsWith({ greenPaintSpread: 0 }));
  const wide = await render(buf, surface, settingsWith({ greenPaintSpread: 0.6 }));
  const t = tight.diagnostics.greenPaint, w = wide.diagnostics.greenPaint;
  assert.ok(t && w, "paint diagnostics must be published");
  assert.ok(t.beyondSampledRange === 0, "spread 0 must stay inside the sampled run, got " + t.beyondSampledRange);
  assert.ok(w.beyondSampledRange > t.beyondSampledRange, "spread 0.6 must report reaching past it");
  return "spread 0 -> " + t.beyondSampledRange + ", 0.6 -> " + w.beyondSampledRange;
});

(async () => {
  console.log("green paint\n");
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
