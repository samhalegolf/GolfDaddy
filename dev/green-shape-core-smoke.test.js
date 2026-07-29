/* functions/lib/gd-green-shape-core.mjs: hermetic smoke test.
 *
 * This is NOT the browser-parity calibration test the migration plan calls for (comparing
 * this sharp-based port's output against scripts/gd-green-shape-engine.js's Canvas-filter
 * output on real course imagery, with a tolerance) - that needs saved sample aerial images
 * and a way to run the browser engine's canvas path (headless browser or a DOM shim), which
 * this Node-only dev/ suite does not have. Flagged here rather than silently skipped: do not
 * trust this port's green polygons in production until that calibration test exists and
 * passes.
 *
 * What this DOES prove, hermetically: the Node port runs end-to-end against a synthetic
 * image (no external imagery needed), produces a plausible polygon around a bright disc on a
 * dark background, and degrades gracefully on invalid input - the same shape of guarantee
 * dev/green-shape-engine-behavior.test.js gives the browser engine. */

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
