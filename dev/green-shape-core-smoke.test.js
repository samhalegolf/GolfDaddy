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
