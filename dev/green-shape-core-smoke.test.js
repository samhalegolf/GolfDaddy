/* functions/lib/gd-green-shape-core.mjs: hermetic smoke test.
 *
 * This is NOT a calibration test. The engine's sharp filter chain was never compared against
 * the Canvas-filter output it was ported from on real course imagery, and now cannot be: the
 * browser engine that was the reference has been deleted (it had no caller left). So the
 * standing caveat is unchanged and now permanent unless someone recalibrates from scratch -
 * do not treat these green polygons as verified.
 *
 * What this DOES prove, hermetically: the engine runs end-to-end against a synthetic image
 * (no external imagery needed), produces a plausible polygon around a bright disc on a dark
 * background, and degrades gracefully on invalid input. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let detect = null;
let sharp = null;

/* A bright circular "green" on a dark "rough" background - enough tonal contrast for the
 * tonal-edge probe to find a ring, without needing real aerial imagery. */
async function syntheticGreenImage(size = 220, greenRadius = 55) {
  const center = size / 2;
  const channels = 4;
  const buffer = Buffer.alloc(size * size * channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * channels;
      const inGreen = Math.hypot(x - center, y - center) <= greenRadius;
      buffer[i] = inGreen ? 70 : 30;
      buffer[i + 1] = inGreen ? 200 : 60;
      buffer[i + 2] = inGreen ? 90 : 35;
      buffer[i + 3] = 255;
    }
  }
  return sharp(buffer, { raw: { width: size, height: size, channels } }).png().toBuffer();
}

test("detect() rejects invalid input without throwing", async () => {
  const result = await detect({});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.rejectionReason, "invalid-input");
});

test("detect() runs end-to-end against a synthetic image and returns a shaped result", async () => {
  const image = await syntheticGreenImage();
  const result = await detect({ image, imageWidth: 220, imageHeight: 220, candidateCentrePx: { x: 110, y: 110 }, mode: "robustTonal" });
  assert.strictEqual(typeof result.ok, "boolean");
  assert.ok(Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1);
  assert.ok(Array.isArray(result.polygonPixels));
  assert.ok(result.diagnostics && result.diagnostics.mode === "robustTonal");
});

test("detect() diagnostics report the requested crop dimensions", async () => {
  const image = await syntheticGreenImage(180, 44);
  const result = await detect({ image, imageWidth: 180, imageHeight: 180, candidateCentrePx: { x: 90, y: 90 } });
  assert.strictEqual(result.diagnostics.width, 180);
  assert.strictEqual(result.diagnostics.height, 180);
});

/* The bug this guards: the sharp port's grayscale() collapsed the filtered image to ONE band,
   while every consumer indexes it through samplePixel's (y*width+x)*4. Past the first quarter
   of the buffer that read off the end and came back undefined, so findTonalEdgeCandidates
   found no edges and buildHealthyBubble fell back to its base bubble. detect() then returned a
   ~19px disc centred on the seed - the SAME disc for a green, a bunker, bare fairway and open
   water - and reported confidence up to 1.00 for it. Nothing failed; the output just stopped
   depending on the picture. */
test("the filtered buffer is RGBA, not a collapsed grayscale band", async () => {
  const core = await import(path.join(root, "functions", "lib", "gd-green-shape-core.mjs"));
  const T = core.__greenShapeCoreTest;
  const W = 64, H = 64;
  const raw = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 40, g: 90, b: 50, alpha: 255 } } })
    .ensureAlpha().raw().toBuffer();
  const filtered = await T.renderFilteredBuffer(raw, W, H, T.GREEN_WAND_MODE_PRESETS.robustTonal.filters);
  assert.strictEqual(filtered.data.length, W * H * 4,
    "every consumer indexes this as RGBA, so it has to BE RGBA");
});

/* The symptom, asserted directly: two visibly different images must not produce the same
   polygon. This is what "uncalibrated" was hiding. */
test("the polygon depends on the image", async () => {
  const W = 200, H = 200;
  const disc = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 30, g: 80, b: 40 } } })
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}"><circle cx="100" cy="100" r="55" fill="#d8cfa8"/></svg>`), top: 0, left: 0 }])
    .png().toBuffer();
  const flat = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 30, g: 80, b: 40 } } }).png().toBuffer();
  const seed = { x: 100, y: 100 };
  const a = await detect({ image: disc, imageWidth: W, imageHeight: H, candidateCentrePx: seed });
  const b = await detect({ image: flat, imageWidth: W, imageHeight: H, candidateCentrePx: seed });
  const radius = r => {
    const p = r.polygonPixels || [];
    if (p.length < 3) return 0;
    const cx = p.reduce((s, q) => s + q.x, 0) / p.length, cy = p.reduce((s, q) => s + q.y, 0) / p.length;
    return p.reduce((s, q) => s + Math.hypot(q.x - cx, q.y - cy), 0) / p.length;
  };
  const ra = radius(a), rb = radius(b);
  assert.ok(ra > 0 && rb > 0, "both runs produced a polygon");
  assert.ok(Math.abs(ra - rb) > 1.5,
    "a disc and a flat field must not yield the same shape (got " + ra.toFixed(2) + "px vs " + rb.toFixed(2) + "px)");
});

(async function run() {
  const mod = await import(path.join(root, "functions", "lib", "gd-green-shape-core.mjs"));
  detect = mod.detect;
  sharp = (await import("sharp")).default;
  let failures = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log("  ok  " + item.name);
    } catch (error) {
      failures += 1;
      console.error("  FAIL  " + item.name + "\n        " + (error && error.stack || error));
    }
  }
  if (failures) {
    console.error("green-shape-core-smoke FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("green-shape-core-smoke passed: " + tests.length + " checks");
})();
