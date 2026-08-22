/* Shadow lift = surround fill.
 *
 * V1 lifted only luminance, which turns a deep shadow into BRIGHT BLACK - the hue and
 * saturation are still shadow, just lit. What the operator means by "lift" is that
 * shadowed ground should look like the ground AROUND it. So the mechanic is spatial:
 * a coarse colour field is built from the non-shadow pixels (holes filled from their
 * rims), and each dark pixel blends toward the field colour at its own position -
 * hue, saturation and luminance together, deeper shadows pulling harder.
 *
 * Two implementations must agree: the engine (studio bakes, and the generated client
 * via byte-parity) and the server export core (published frames). This drives both
 * with real pixel buffers.
 *
 * Run: node dev/shadow-lift.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} };
global.dispatchEvent = function () {};
global.CustomEvent = function CustomEvent(type, init) { return { type, detail: init && init.detail }; };
const engine = require(path.join(ROOT, "scripts", "gd-course-visual-engine.js"));

/* The export core's normaliseSurfaceBuffer is internal - lift it textually, with its
   own helpers, exactly as it ships. */
function liftExportNormalise() {
  const src = fs.readFileSync(path.join(ROOT, "functions", "lib", "gd-visual-export-core.mjs"), "utf8");
  const start = src.indexOf("function rgbToHsl(r, g, b) {");
  const end = src.indexOf("function world(pt) {");
  assert.ok(start > -1 && end > start, "export core region not found");
  // eslint-disable-next-line no-new-func
  return new Function(
    "function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v));}\n"
    + "function num(v,fb){var n=Number(v);return Number.isFinite(n)?n:fb;}\n"
    + src.slice(start, end)
    + "\nreturn normaliseSurfaceBuffer;")();
}
const exportNormalise = liftExportNormalise();

/* A 96x96 green field with a 24x24 deep-shadow square in the middle. Deterministic
   per-pixel noise matters: a two-tone image puts the bright value AT the p99 the tone
   curve stretches to the ceiling, which bleaches it white and proves nothing. Real
   captures have spread. */
const W = 96, H = 96;
const GREEN = [82, 138, 66], DARK = [16, 19, 14];
const noise = (x, y, amp) => Math.round((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1) * amp);
function makeField(channels) {
  const buf = new Uint8ClampedArray(W * H * channels);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inShadow = x >= 36 && x < 60 && y >= 36 && y < 60;
    const c = inShadow ? DARK : GREEN;
    const n = inShadow ? noise(x, y, 6) : noise(x, y, 24);
    const i = (y * W + x) * channels;
    buf[i] = Math.max(0, c[0] + n); buf[i + 1] = Math.max(0, c[1] + n); buf[i + 2] = Math.max(0, c[2] + n);
    if (channels === 4) buf[i + 3] = 255;
  }
  return buf;
}
/* Preset-like recipe so the tone curve behaves as it does on real captures. */
const SETTINGS = (lift) => ({
  turf: { targetPull: 0 },
  lighting: Object.assign({ brightnessTarget: 52, shadowFloor: 14, highlightCeiling: 92, contrastTarget: 1 }, lift)
});
const px = (buf, x, y, channels) => { const i = (y * W + x) * channels; return [buf[i], buf[i + 1], buf[i + 2]]; };
const hue = (rgb) => {
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log("  ok   " + name); }
  catch (error) { failures.push({ name, error }); console.log("  FAIL " + name); }
}

test("strength 0 is exact identity", () => {
  const a = makeField(4), b = makeField(4);
  engine.normaliseSurfacePixels(a, SETTINGS({}), { width: W, height: H });
  engine.normaliseSurfacePixels(b, SETTINGS({ shadowLiftStrength: 0, shadowLiftThreshold: 45 }), { width: W, height: H });
  assert.deepStrictEqual(Array.from(b), Array.from(a));
});

test("a lifted shadow takes on the SURROUNDING COLOUR, not just brightness", () => {
  const toneOnly = makeField(4);
  engine.normaliseSurfacePixels(toneOnly, SETTINGS({}), { width: W, height: H });
  const buf = makeField(4);
  const plan = engine.normaliseSurfacePixels(buf, SETTINGS({ shadowLiftStrength: 1, shadowLiftThreshold: 40 }), { width: W, height: H });
  assert.strictEqual(plan.shadowFill.applied, true);
  assert.strictEqual(plan.shadowFill.model, "surround-fill");
  const centre = px(buf, 48, 48, 4);
  const centreBefore = px(toneOnly, 48, 48, 4);
  const surround = px(buf, 10, 10, 4);
  const chroma = (rgb) => Math.max(...rgb) - Math.min(...rgb);
  /* The old lift produced bright black here: luminance up, chroma still shadow-flat.
     The fill must produce actual colour - chroma several times the murk's, hue in the
     surround's family, green dominant. */
  assert.ok(chroma(centre) > Math.max(25, chroma(centreBefore) * 2),
    "chroma must rise toward turf (" + chroma(centreBefore) + " -> " + chroma(centre) + ")");
  assert.ok(Math.abs(hue(centre) - hue(surround)) < 20, "hue must land near the surround's, got " + hue(centre).toFixed(0) + " vs " + hue(surround).toFixed(0));
  assert.ok(centre[1] > centre[0] && centre[1] > centre[2], "green channel must dominate, like the surround");
});

test("every pixel at or above the threshold is untouched by the fill", () => {
  const a = makeField(4), b = makeField(4);
  engine.normaliseSurfacePixels(a, SETTINGS({}), { width: W, height: H });
  engine.normaliseSurfacePixels(b, SETTINGS({ shadowLiftStrength: 1, shadowLiftThreshold: 40 }), { width: W, height: H });
  let checked = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const l = (Math.max(a[i], a[i + 1], a[i + 2]) + Math.min(a[i], a[i + 1], a[i + 2])) / 2 / 255 * 100;
    if (l < 40) continue;
    checked++;
    assert.ok(a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2],
      "pixel at " + x + "," + y + " (L=" + l.toFixed(1) + ") must not move");
  }
  assert.ok(checked > W * H * 0.5, "the invariant must actually cover most of the image");
});

test("deeper shadows pull harder than near-threshold ones", () => {
  const channels = 4;
  const buf = new Uint8ClampedArray(W * H * channels);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * channels;
    let c = GREEN, amp = 24;
    if (x >= 30 && x < 45 && y >= 40 && y < 56) { c = [12, 14, 10]; amp = 4; }       // deep
    else if (x >= 55 && x < 70 && y >= 40 && y < 56) { c = [60, 66, 56]; amp = 4; }  // just under the threshold
    const n = noise(x, y, amp);
    buf[i] = Math.max(0, c[0] + n); buf[i + 1] = Math.max(0, c[1] + n); buf[i + 2] = Math.max(0, c[2] + n); buf[i + 3] = 255;
  }
  const before = Uint8ClampedArray.from(buf);
  engine.normaliseSurfacePixels(buf, SETTINGS({ shadowLiftStrength: 1, shadowLiftThreshold: 35 }), { width: W, height: H });
  const delta = (x, y) => {
    const i = (y * W + x) * channels;
    return Math.abs(buf[i] - before[i]) + Math.abs(buf[i + 1] - before[i + 1]) + Math.abs(buf[i + 2] - before[i + 2]);
  };
  assert.ok(delta(37, 48) > delta(62, 48) + 30,
    "deep shadow must move much more than a barely-dark pixel (" + delta(37, 48) + " vs " + delta(62, 48) + ")");
});

test("an all-dark image has nothing to borrow from and is left alone", () => {
  const channels = 4;
  const buf = new Uint8ClampedArray(W * H * channels);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 15; buf[i + 1] = 18; buf[i + 2] = 13; buf[i + 3] = 255; }
  const control = Uint8ClampedArray.from(buf);
  const plan = engine.normaliseSurfacePixels(buf, SETTINGS({ shadowLiftStrength: 1, shadowLiftThreshold: 55 }), { width: W, height: H });
  engine.normaliseSurfacePixels(control, SETTINGS({}), { width: W, height: H });
  assert.strictEqual(plan.shadowFill.applied, false);
  assert.strictEqual(plan.shadowFill.reason, "everything-dark");
  assert.deepStrictEqual(Array.from(buf), Array.from(control), "no fill source means no change beyond the tone curve");
});

test("engine and server export core fill identically", () => {
  const a = makeField(3);
  const b = makeField(4);
  const settings = SETTINGS({ shadowLiftStrength: 0.7, shadowLiftThreshold: 40 });
  const planA = exportNormalise(a, W, H, 3, settings);
  const planB = engine.normaliseSurfacePixels(b, settings, { width: W, height: H });
  assert.strictEqual(planA.shadowFill.applied, true);
  assert.strictEqual(planB.shadowFill.applied, true);
  assert.strictEqual(planA.shadowFill.cell, planB.shadowFill.cell);
  let maxDiff = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ia = (y * W + x) * 3, ib = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(a[ia + c] - b[ib + c]));
  }
  assert.ok(maxDiff <= 1, "published frames must carry the same fill the studio previewed (max channel diff " + maxDiff + ")");
});

test("the normalisation cache key includes the lift fields", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-visual-engine.js"), "utf8");
  const keyFn = src.slice(src.indexOf("function normalisationCacheKey("), src.indexOf("function cacheNormalisedSurface("));
  assert.ok(keyFn.includes("shadowLiftStrength") && keyFn.includes("shadowLiftThreshold"),
    "a field the key omits makes a changed recipe render the OLD pixels under a new hash");
});

test("the studio dock, recipe form and truth chips know the fields", () => {
  const studio = fs.readFileSync(path.join(ROOT, "scripts", "studio", "gd-admin-course-db.js"), "utf8");
  assert.ok(studio.includes('"gdCourseVisualShadowLift"') && studio.includes('"gdCourseVisualShadowDark"'));
  assert.ok(studio.includes("shadowLiftStrength:num(\"gdCourseVisualShadowLift\"") && studio.includes("shadowLiftThreshold:num(\"gdCourseVisualShadowDark\""));
  assert.ok(studio.includes("lighting:{brightnessTarget:52,contrastTarget:1,shadowLiftStrength:0}"), "Reset turns the lift off");
  const truth = require(path.join(ROOT, "scripts", "studio", "gd-studio-preview-truth.js"));
  const chips = truth.ingredientStates({
    current: { lighting: { shadowLiftStrength: 0.5, shadowLiftThreshold: 30 } },
    displayed: { lighting: { shadowLiftStrength: 0.5, shadowLiftThreshold: 30 } },
    pipeline: { state: "idle" }
  });
  assert.strictEqual(chips.find((c) => c.id === "shadowlift").state, "confirmed");
});

console.log("\n" + passed + "/" + (passed + failures.length) + " passed");
if (failures.length) {
  failures.forEach((f) => console.error("\n" + f.name + "\n" + (f.error && f.error.stack || f.error)));
  process.exit(1);
}
console.log("shadow-lift passed");
