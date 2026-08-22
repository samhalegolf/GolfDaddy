/* Shadow lift.
 *
 * The floor/ceiling pair are output levels: they remap EVERY tone into a band, and
 * the mean-pinning gamma makes either end move the whole image. Shadow lift is the
 * thresholded control that band cannot express: pixels landing darker than the
 * threshold are raised toward it, everything else is untouched, and strength 0 is
 * exact identity so every recipe and baked frame from before the field existed
 * renders byte-identically.
 *
 * It lives in three places that must agree: the engine (studio bakes), the generated
 * client (byte-parity is dev/visual-engine-client.test.js's job), and the server
 * export core (published frames). This test lifts the engine's and the export
 * core's toneCurveLut and drives both.
 *
 * Run: node dev/shadow-lift.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function liftEngineToneCurve() {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-visual-engine.js"), "utf8");
  const start = src.indexOf("function toneCurveLut(stats,settings){");
  const end = src.indexOf("  /* Measure once, then a single pass", start);
  assert.ok(start > -1 && end > start, "engine toneCurveLut not found");
  // eslint-disable-next-line no-new-func
  return new Function(
    "function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v));}\n"
    + "function finite(v){var n=Number(v);return Number.isFinite(n)?n:null;}\n"
    + src.slice(start, end) + "\nreturn toneCurveLut;")();
}

function liftExportToneCurve() {
  const src = fs.readFileSync(path.join(ROOT, "functions", "lib", "gd-visual-export-core.mjs"), "utf8");
  const start = src.indexOf("function toneCurveLut(stats, settings) {");
  const end = src.indexOf("/* Range guardrail", start);
  assert.ok(start > -1 && end > start, "export core toneCurveLut not found");
  // eslint-disable-next-line no-new-func
  return new Function(
    "function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v));}\n"
    + "function num(v,fb){var n=Number(v);return Number.isFinite(n)?n:fb;}\n"
    + src.slice(start, end) + "\nreturn toneCurveLut;")();
}

const engineCurve = liftEngineToneCurve();
const exportCurve = liftExportToneCurve();
const STATS = { luma: { p1: 10, p99: 90, mean: 40 } };
const lighting = (extra) => ({ lighting: Object.assign({ brightnessTarget: 52, shadowFloor: 14, highlightCeiling: 92, contrastTarget: 1 }, extra) });

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log("  ok   " + name); }
  catch (error) { failures.push({ name, error }); console.log("  FAIL " + name); }
}

test("strength 0 is exact identity - old recipes render byte-identically", () => {
  const before = engineCurve(STATS, lighting({})).lut;
  const zero = engineCurve(STATS, lighting({ shadowLiftStrength: 0, shadowLiftThreshold: 45 })).lut;
  assert.deepStrictEqual(zero, before, "declaring the fields at strength 0 must change nothing");
});

test("pixels below the threshold are lifted toward it; above it, untouched", () => {
  const T = 40, S = 0.6;
  const plain = engineCurve(STATS, lighting({})).lut;
  const lifted = engineCurve(STATS, lighting({ shadowLiftStrength: S, shadowLiftThreshold: T })).lut;
  for (let i = 0; i <= 100; i++) {
    if (plain[i] >= T) {
      assert.strictEqual(lifted[i], plain[i], "L=" + i + " landed at " + plain[i] + " (not dark) and must be untouched");
    } else {
      const expected = T * S + plain[i] * (1 - S);
      assert.ok(Math.abs(lifted[i] - expected) < 1e-9, "L=" + i + " must move toward the threshold by exactly the strength");
      assert.ok(lifted[i] > plain[i] && lifted[i] < T, "lifted, but never past the threshold");
    }
  }
});

test("strength 1 pins everything dark AT the threshold, and no further", () => {
  const lifted = engineCurve(STATS, lighting({ shadowLiftStrength: 1, shadowLiftThreshold: 35 })).lut;
  const plain = engineCurve(STATS, lighting({})).lut;
  for (let i = 0; i <= 100; i++) {
    assert.strictEqual(lifted[i], plain[i] < 35 ? 35 : plain[i]);
  }
});

test("the curve stays monotone - lifting shadows never reorders tones", () => {
  const lifted = engineCurve(STATS, lighting({ shadowLiftStrength: 0.8, shadowLiftThreshold: 45 })).lut;
  for (let i = 1; i <= 100; i++) assert.ok(lifted[i] >= lifted[i - 1], "non-decreasing at " + i);
});

test("midtones and highlights do NOT move - unlike the floor/ceiling band", () => {
  /* The original complaint: floor/ceiling moved the whole image. The lift must not. */
  const plain = engineCurve(STATS, lighting({})).lut;
  const lifted = engineCurve(STATS, lighting({ shadowLiftStrength: 1, shadowLiftThreshold: 30 })).lut;
  [40, 60, 85].forEach((L) => {
    assert.strictEqual(lifted[L], plain[L], "input L=" + L + " is not dark and must not move");
  });
});

test("the degenerate flat-source branch lifts the same way", () => {
  const flat = { luma: { p1: 20, p99: 21, mean: 20 } };
  const lifted = engineCurve(flat, lighting({ brightnessTarget: 25, shadowLiftStrength: 0.5, shadowLiftThreshold: 40 }));
  assert.strictEqual(lifted.degenerateRange, true);
  /* input 5 shifts to 10, lands below 40, lifts halfway toward it: 25. */
  assert.ok(Math.abs(lifted.lut[5] - (40 * 0.5 + 10 * 0.5)) < 1e-9);
});

test("engine and server export core produce identical LUTs", () => {
  [{}, { shadowLiftStrength: 0.6, shadowLiftThreshold: 40 }, { shadowLiftStrength: 1, shadowLiftThreshold: 20 },
   { shadowLiftStrength: 0.3, shadowLiftThreshold: 60, contrastTarget: 1.5, brightnessTarget: 64 }].forEach((extra) => {
    const a = engineCurve(STATS, lighting(extra)).lut.map((v) => +v.toFixed(9));
    const b = exportCurve(STATS, lighting(extra)).lut.map((v) => +v.toFixed(9));
    assert.deepStrictEqual(a, b, "published frames must carry the same lift the studio previewed: " + JSON.stringify(extra));
  });
});

test("the normalisation cache key includes the lift fields", () => {
  /* The cache is keyed per (source, target-fields). A field the key omits makes a
     changed recipe hit the cache and quietly render the OLD pixels while the frame's
     overrideHash claims the new ones - the one lie the truth model cannot catch,
     because the frame metadata is honest about the recipe and wrong about the pixels. */
  const src = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-visual-engine.js"), "utf8");
  const keyFn = src.slice(src.indexOf("function normalisationCacheKey("), src.indexOf("function cacheNormalisedSurface("));
  assert.ok(keyFn.includes("shadowLiftStrength") && keyFn.includes("shadowLiftThreshold"),
    "every field toneCurveLut reads must be part of the cache key");
});

test("the studio dock, recipe form and truth chips know the new fields", () => {
  const studio = fs.readFileSync(path.join(ROOT, "scripts", "studio", "gd-admin-course-db.js"), "utf8");
  assert.ok(studio.includes('"gdCourseVisualShadowLift"') && studio.includes('"gdCourseVisualShadowDark"'), "sliders are registered controls");
  assert.ok(studio.includes("shadowLiftStrength:num(\"gdCourseVisualShadowLift\"") && studio.includes("shadowLiftThreshold:num(\"gdCourseVisualShadowDark\""), "form read carries both fields");
  assert.ok(studio.includes("lighting:{brightnessTarget:52,contrastTarget:1,shadowLiftStrength:0}"), "Reset turns the lift off");
  const truth = require(path.join(ROOT, "scripts", "studio", "gd-studio-preview-truth.js"));
  const chips = truth.ingredientStates({
    current: { lighting: { shadowLiftStrength: 0.5, shadowLiftThreshold: 30 } },
    displayed: { lighting: { shadowLiftStrength: 0.5, shadowLiftThreshold: 30 } },
    pipeline: { state: "idle" }
  });
  assert.strictEqual(chips.find((c) => c.id === "shadowlift").state, "confirmed");
  const changing = truth.ingredientStates({
    current: { lighting: { shadowLiftStrength: 0.5, shadowLiftThreshold: 30 } },
    displayed: { lighting: { shadowLiftStrength: 0.5, shadowLiftThreshold: 45 } },
    pipeline: { state: "rendering" }
  });
  assert.strictEqual(changing.find((c) => c.id === "shadowlift").state, "applying",
    "changing only the threshold must un-confirm the chip - it changes the picture");
});

console.log("\n" + passed + "/" + (passed + failures.length) + " passed");
if (failures.length) {
  failures.forEach((f) => console.error("\n" + f.name + "\n" + (f.error && f.error.stack || f.error)));
  process.exit(1);
}
console.log("shadow-lift passed");
