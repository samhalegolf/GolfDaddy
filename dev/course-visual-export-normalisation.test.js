/* Source-aware recipe normalisation, proven on the actual server export path.

   The recipe model is a TARGET, not a filter: measure the real source pixels, then apply only
   the correction needed to move them toward the recipe's targets (brightnessTarget, shadowFloor,
   highlightCeiling, turf hue/saturation/brightness band). Before this file, the server
   (functions/lib/gd-visual-export-core.mjs) only ever applied a flat multiplier derived from
   settings alone - the same brightnessTarget produced the same output regardless of whether the
   source was dark or blown out, and shadowFloor/highlightCeiling were never even read.

   This mirrors dev/course-visual-engine.test.js's pixel-level assertions (Tests 1-6 there,
   at the pure-function level) but exercises them through the REAL Sharp render pipeline
   (renderHoleSurfaceMercator / renderOverview), the same way dev/terrain-relief.test.js proves
   Terrain on the real pipeline instead of a stub. */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";
import { renderHoleSurfaceMercator, renderOverview } from "../functions/lib/gd-visual-export-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The browser engine is a UMD module that reaches for localStorage/dispatchEvent at load time,
// same stub dev/course-visual-engine.test.js installs before requiring it.
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} };
global.dispatchEvent = function () {};
global.CustomEvent = function CustomEvent(type, init) { return { type, detail: init && init.detail }; };
const engine = require(path.join(__dirname, "..", "scripts", "gd-course-visual-engine.js"));

const D = 256;
const bounds = { north: -36.7495, west: 174.7500, south: -36.7535, east: 174.7545 };

function solidCapture(rgb) {
  return sharp({ create: { width: D, height: D, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg({ quality: 95 }).toBuffer();
}
function gradientCapture(build) {
  const raw = Buffer.alloc(D * D * 3);
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const [r, g, b] = build(x / D, y / D);
      const i = (y * D + x) * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  return sharp(raw, { raw: { width: D, height: D, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}
function captureFor(buffer) {
  return [{ entry: { role: "course-backdrop", bounds, width: D, height: D, stitchLayer: 0, captureZoom: 18 }, buffer }];
}
async function render(buffer, settings, extra) {
  return renderHoleSurfaceMercator(Object.assign({ pins: {}, captures: captureFor(buffer), terrain: null, settings, maxDim: D, quality: 92 }, extra || {}));
}
async function meanLuma(jpeg) {
  const stats = await sharp(jpeg).stats();
  return (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3 / 255 * 100;
}

// ---- 1. Brightness target is source-aware: dark lifts, bright drops, both converge -----------
{
  const dark = await solidCapture([28, 36, 30]);
  const bright = await solidCapture([215, 228, 210]);
  const settings = { lighting: { brightnessTarget: 52 } };
  const darkOut = await render(dark, settings);
  const brightOut = await render(bright, settings);
  const darkMean = await meanLuma(darkOut.jpeg);
  const brightMean = await meanLuma(brightOut.jpeg);
  assert.ok(darkOut.diagnostics.tone.measuredMean < brightOut.diagnostics.tone.measuredMean - 20, "sanity: the two sources really do start far apart");
  assert.ok(darkMean > darkOut.diagnostics.tone.measuredMean + 10, "dark source got brighter, got " + darkOut.diagnostics.tone.measuredMean.toFixed(1) + " -> " + darkMean.toFixed(1));
  assert.ok(brightMean < brightOut.diagnostics.tone.measuredMean - 10, "bright source got darker, got " + brightOut.diagnostics.tone.measuredMean.toFixed(1) + " -> " + brightMean.toFixed(1));
  assert.ok(Math.abs(darkMean - 52) < 15, "dark source converges near the target, got " + darkMean.toFixed(1));
  assert.ok(Math.abs(brightMean - 52) < 15, "bright source converges near the target, got " + brightMean.toFixed(1));
  assert.ok(Math.abs(darkMean - brightMean) < 15, "two very different sources land close together, got " + darkMean.toFixed(1) + " vs " + brightMean.toFixed(1));
  console.log("1. brightnessTarget is source-aware: dark %s->%s, bright %s->%s (target 52)",
    darkOut.diagnostics.tone.measuredMean.toFixed(1), darkMean.toFixed(1), brightOut.diagnostics.tone.measuredMean.toFixed(1), brightMean.toFixed(1));
}

// ---- 2. A source already near the target changes minimally ------------------------------------
{
  const near = await solidCapture([128, 134, 122]);
  const settings = { lighting: { brightnessTarget: 52 } };
  const out = await render(near, settings);
  const before = out.diagnostics.tone.measuredMean;
  const after = await meanLuma(out.jpeg);
  assert.ok(Math.abs(before - 52) < 12, "sanity: fixture starts reasonably near the target");
  assert.ok(Math.abs(after - before) < 12, "an already-close source is not aggressively re-graded, got " + before.toFixed(1) + " -> " + after.toFixed(1));
  console.log("2. near-target source barely moves: %s -> %s", before.toFixed(1), after.toFixed(1));
}

// ---- 3 & 4. Turf inside range is left alone; turf outside range is pulled in ------------------
{
  const goodTurf = await solidCapture([82, 185, 70]); // hue ~114, sat ~45 - already inside natural's band
  const dryTurf = await solidCapture([170, 160, 60]); // hue ~55 - outside hueMin (86), inside the wider measurement band
  const natural = engine.getPreset("clarity-course-natural-v1");
  const goodOut = await render(goodTurf, natural);
  const dryOut = await render(dryTurf, natural);
  assert.ok(goodOut.diagnostics.turf.applied, "turf pixels were found in the already-good fixture");
  assert.ok(dryOut.diagnostics.turf.applied, "turf pixels were found in the out-of-range fixture");
  const goodHueBefore = goodOut.diagnostics.before.turf.hue.mean, goodHueAfter = goodOut.diagnostics.after.turf.hue.mean;
  assert.ok(Math.abs(goodHueAfter - goodHueBefore) < 3, "turf already inside the range is left essentially untouched, moved " + Math.abs(goodHueAfter - goodHueBefore).toFixed(2) + " deg");
  const dryHueBefore = dryOut.diagnostics.before.turf.hue.mean, dryHueAfter = dryOut.diagnostics.after.turf.hue.mean;
  assert.ok(dryHueBefore < natural.turf.hueMin - 5, "sanity: the dry fixture really does start outside the hue band, got " + dryHueBefore.toFixed(1));
  assert.ok(dryHueAfter > dryHueBefore + 10, "out-of-range turf hue is pulled materially toward the target, got " + dryHueBefore.toFixed(1) + " -> " + dryHueAfter.toFixed(1));
  assert.ok(dryHueAfter >= natural.turf.hueMin - 6, "and lands inside (or right at the edge of) the authored band, got " + dryHueAfter.toFixed(1));
  console.log("3/4. turf-in-range moved %s deg, turf-out-of-range moved %s deg (%s -> %s)",
    Math.abs(goodHueAfter - goodHueBefore).toFixed(2), (dryHueAfter - dryHueBefore).toFixed(1), dryHueBefore.toFixed(1), dryHueAfter.toFixed(1));
}

// ---- 5. targetPull is monotonic --------------------------------------------------------------
{
  const dryTurf = await solidCapture([170, 160, 60]);
  const pullDistance = async (pull) => {
    const out = await render(dryTurf, { turf: { targetPull: pull } });
    return Math.abs(out.diagnostics.after.turf.hue.mean - out.diagnostics.before.turf.hue.mean);
  };
  const d0 = await pullDistance(0), d05 = await pullDistance(0.5), d1 = await pullDistance(1);
  assert.ok(d0 < 1, "targetPull 0 applies no correction, moved " + d0.toFixed(2) + " deg");
  assert.ok(d05 > d0 + 3, "targetPull 0.5 corrects more than 0, got " + d0.toFixed(1) + " -> " + d05.toFixed(1));
  assert.ok(d1 > d05 + 3, "targetPull 1 corrects more than 0.5, got " + d05.toFixed(1) + " -> " + d1.toFixed(1));
  console.log("5. targetPull is monotonic: 0 -> %s deg, 0.5 -> %s deg, 1 -> %s deg", d0.toFixed(2), d05.toFixed(2), d1.toFixed(2));
}

// ---- 6. shadowFloor / highlightCeiling genuinely change the tonal mapping ---------------------
// A flat solid colour has no range to remap (toneCurveLut's degenerate-range shortcut just
// shifts it onto brightnessTarget, by design - that's the "target, not filter" model working),
// so this needs an actual gradient to show the floor/ceiling reshaping the output's spread.
{
  const grad = (u, v) => { const n = 20 + v * 180; return [Math.round(n), Math.round(n * 1.02), Math.round(n * 0.96)]; };
  const buf = await gradientCapture(grad);
  const low = await render(buf, { lighting: { shadowFloor: 5, highlightCeiling: 55 } });
  const high = await render(buf, { lighting: { shadowFloor: 35, highlightCeiling: 95 } });
  assert.notEqual(low.diagnostics.tone.shadowFloor, high.diagnostics.tone.shadowFloor, "shadowFloor is threaded through, not defaulted away");
  assert.ok(Math.abs(low.diagnostics.after.luma.p1 - high.diagnostics.after.luma.p1) > 10, "a lower shadow floor produces a measurably darker output floor, got " + low.diagnostics.after.luma.p1.toFixed(1) + " vs " + high.diagnostics.after.luma.p1.toFixed(1));
  assert.ok(Math.abs(low.diagnostics.after.luma.p99 - high.diagnostics.after.luma.p99) > 10, "a lower highlight ceiling produces a measurably darker output ceiling, got " + low.diagnostics.after.luma.p99.toFixed(1) + " vs " + high.diagnostics.after.luma.p99.toFixed(1));
  console.log("6. shadowFloor/highlightCeiling reshape the output range: floor/ceil 5/55 -> [%s..%s], 35/95 -> [%s..%s]",
    low.diagnostics.after.luma.p1.toFixed(1), low.diagnostics.after.luma.p99.toFixed(1), high.diagnostics.after.luma.p1.toFixed(1), high.diagnostics.after.luma.p99.toFixed(1));
}

// ---- 7. Preview/publish parity: browser engine math vs the real server pipeline ---------------
{
  const grad = (u, v) => { const n = 30 + v * 26; return [Math.round(n * 0.62), Math.round(n), Math.round(n * 0.66)]; };
  const natural = engine.getPreset("clarity-course-natural-v1");

  // Browser side: the exact pure functions the Studio preview will run once wired to real pixels.
  const w = 64, h = 64;
  const browserPixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = grad(x / w, y / h);
    const i = (y * w + x) * 4;
    browserPixels[i] = r; browserPixels[i + 1] = g; browserPixels[i + 2] = b; browserPixels[i + 3] = 255;
  }
  const browserPlan = engine.normaliseSurfacePixels(browserPixels, natural);

  // Server side: the same gradient, run through the real Sharp export pipeline.
  const serverBuf = await gradientCapture(grad);
  const serverOut = await render(serverBuf, natural);

  const meanDelta = Math.abs(browserPlan.after.luma.mean - serverOut.diagnostics.after.luma.mean);
  const hueDelta = Math.abs(browserPlan.after.turf.hue.mean - serverOut.diagnostics.after.turf.hue.mean);
  const satDelta = Math.abs(browserPlan.after.turf.saturation.p50 - serverOut.diagnostics.after.turf.saturation.p50);
  assert.ok(meanDelta < 10, "browser and server land on close mean luminance, delta " + meanDelta.toFixed(2));
  assert.ok(hueDelta < 12, "browser and server land on close turf hue, delta " + hueDelta.toFixed(2));
  assert.ok(satDelta < 15, "browser and server land on close turf saturation, delta " + satDelta.toFixed(2));
  console.log("7. preview/publish parity: mean delta %s, turf hue delta %s, turf sat delta %s",
    meanDelta.toFixed(2), hueDelta.toFixed(2), satDelta.toFixed(2));
}

// ---- 8. Terrain stays additive on top of the normalised base -----------------------------------
{
  const base = await solidCapture([90, 140, 80]);
  const enc = (hgt) => { const v = Math.round((hgt + 10000) / 0.1); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
  const demRaw = Buffer.alloc(D * D * 3);
  for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
    const dx = (x - D / 2) * 1.9, dy = (y - D / 2) * 1.9;
    const hgt = 40 + 9 * Math.exp(-(dx * dx + dy * dy) / 8000);
    const [a, b, c] = enc(hgt);
    const i = (y * D + x) * 3; demRaw[i] = a; demRaw[i + 1] = b; demRaw[i + 2] = c;
  }
  const { reliefFromTerrainRgb } = await import("../functions/lib/gd-relief-core.mjs");
  const demPng = await sharp(demRaw, { raw: { width: D, height: D, channels: 3 } }).png().toBuffer();
  const relief = await reliefFromTerrainRgb(demPng, { latitude: -36.752, zoom: 16 });
  const terrain = { entry: { role: "terrain-reference", bounds, width: relief.width, height: relief.height }, buffer: relief.png };
  const settings = { lighting: { brightnessTarget: 52 }, visualTools: { holeTerrainStrength: 1.2 } };

  const off = await render(base, settings, { terrain: null });
  const on = await render(base, Object.assign({}, settings), { terrain });
  assert.equal(off.diagnostics.tone.measuredMean, on.diagnostics.tone.measuredMean, "the measured SOURCE stats do not depend on whether terrain runs - measurement happens before relief");
  const offBuf = await sharp(off.jpeg).raw().toBuffer();
  const onBuf = await sharp(on.jpeg).raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < offBuf.length; i += 997) diff += Math.abs(offBuf[i] - onBuf[i]);
  assert.ok(diff > 0, "terrain still visibly changes the rendered pixels on top of the normalised base");
  console.log("8. terrain stays additive: identical source measurement, relief still moves pixels (sampled diff %s)", diff);
}

// ---- 9. Mow lines and Floodlight still render, still after normalisation ----------------------
{
  const base = await solidCapture([90, 140, 80]);
  const pins = { tee: { lat: bounds.south + 0.001, lng: bounds.west + 0.001 }, green: { lat: bounds.north - 0.001, lng: bounds.east - 0.001 }, route: [], greenShape: [] };

  const noMow = await render(base, { mowingVisibility: "Unknown" });
  const withMow = await render(base, { mowingVisibility: "Prominent" });
  const noMowBuf = await sharp(noMow.jpeg).raw().toBuffer();
  const withMowBuf = await sharp(withMow.jpeg).raw().toBuffer();
  let mowDiff = 0;
  for (let i = 0; i < noMowBuf.length; i += 401) mowDiff += Math.abs(noMowBuf[i] - withMowBuf[i]);
  assert.ok(mowDiff > 0, "mow lines still render on top of the normalised base");

  const noFlood = await render(base, { floodlight: { enabled: false } }, { pins });
  const withFlood = await render(base, { floodlight: { enabled: true, ambientLevel: 15, litLevel: 75 } }, { pins });
  const noFloodMean = await meanLuma(noFlood.jpeg), withFloodMean = await meanLuma(withFlood.jpeg);
  assert.ok(Math.abs(noFloodMean - withFloodMean) > 2, "floodlight still visibly relights the frame, got " + noFloodMean.toFixed(1) + " vs " + withFloodMean.toFixed(1));
  console.log("9. overlays still render after normalisation: mow diff %s, floodlight %s vs %s", mowDiff, noFloodMean.toFixed(1), withFloodMean.toFixed(1));
}

// ---- 10. renderOverview gets the same treatment -------------------------------------------------
{
  const dark = await solidCapture([28, 36, 30]);
  const bright = await solidCapture([215, 228, 210]);
  const settings = { lighting: { brightnessTarget: 52 } };
  const darkOut = await renderOverview({ backdrop: { buffer: dark }, terrain: null, settings, width: D });
  const brightOut = await renderOverview({ backdrop: { buffer: bright }, terrain: null, settings, width: D });
  const darkMean = await meanLuma(darkOut.jpeg), brightMean = await meanLuma(brightOut.jpeg);
  assert.ok(darkOut.diagnostics && brightOut.diagnostics, "renderOverview returns normalisation diagnostics too");
  assert.ok(Math.abs(darkMean - brightMean) < 15, "renderOverview converges dark and bright sources toward the same target, got " + darkMean.toFixed(1) + " vs " + brightMean.toFixed(1));
  console.log("10. renderOverview is source-aware too: dark -> %s, bright -> %s", darkMean.toFixed(1), brightMean.toFixed(1));
}

// ---- 11. Natural remains a processed preset, not raw --------------------------------------------
{
  const natural = engine.getPreset("clarity-course-natural-v1");
  const filter = engine.__test.filterForSettings(natural);
  assert.equal(engine.__test.isSourceModeSettings(natural), false, "Natural must remain a processed preset");
  assert.ok(filter.saturation !== 1 || filter.brightness !== 1 || filter.contrast !== 1,
    "Natural still carries authored treatment, not identity");
  console.log("11. Natural stays processed: sat %s, bright %s, contrast %s", filter.saturation, filter.brightness, filter.contrast);
}

// ---- 12. Raw Source is a true identity output ---------------------------------------------------
{
  const source = await solidCapture([92, 131, 84]);
  const rawSettings = { effectToggles: { turf: false, lighting: false, floodlight: false, terrain: false, mowing: false }, sourceMode: true };
  const out = await render(source, rawSettings);
  const sourceMean = await meanLuma(source);
  const outMean = await meanLuma(out.jpeg);
  assert.equal(out.diagnostics.sourceMode, true, "raw render is marked as source mode");
  assert.ok(Math.abs(outMean - sourceMean) < 2.5, "raw output stays at source luminance, got " + sourceMean.toFixed(1) + " -> " + outMean.toFixed(1));
  console.log("12. Raw Source stays near identity: %s -> %s", sourceMean.toFixed(1), outMean.toFixed(1));
}

// ---- 13. All toggles OFF auto-resolves to Raw Source --------------------------------------------
{
  const source = await solidCapture([92, 131, 84]);
  const explicitRaw = await render(source, { effectToggles: { turf: false, lighting: false, floodlight: false, terrain: false, mowing: false }, sourceMode: true });
  const allOff = await render(source, { effectToggles: { turf: false, lighting: false, floodlight: false, terrain: false, mowing: false } });
  const rawBuf = await sharp(explicitRaw.jpeg).raw().toBuffer();
  const offBuf = await sharp(allOff.jpeg).raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < rawBuf.length; i += 503) diff += Math.abs(rawBuf[i] - offBuf[i]);
  assert.equal(allOff.diagnostics.sourceMode, true, "all toggles off auto-enters source mode");
  assert.ok(diff < 40, "all toggles off matches explicit raw closely, sampled diff " + diff);
  console.log("13. All-off matches Raw Source: sampled diff %s", diff);
}

// ---- 14. Turf OFF skips turf targeting even when the preset would change it ---------------------
{
  const dryTurf = await solidCapture([170, 160, 60]);
  const natural = engine.getPreset("clarity-course-natural-v1");
  const off = await render(dryTurf, Object.assign({}, natural, { effectToggles: { turf: false, lighting: true, floodlight: false, terrain: false, mowing: false } }));
  const beforeHue = off.diagnostics.before.turf.hue.mean;
  const afterHue = off.diagnostics.after.turf.hue.mean;
  assert.equal(off.diagnostics.turf.applied, false, "turf diagnostics report the pass as disabled");
  assert.ok(Math.abs(afterHue - beforeHue) < 2, "turf off leaves hue alone, got " + beforeHue.toFixed(1) + " -> " + afterHue.toFixed(1));
  console.log("14. Turf OFF leaves hue unchanged: %s -> %s", beforeHue.toFixed(1), afterHue.toFixed(1));
}

// ---- 15. Lighting OFF leaves luminance unchanged -------------------------------------------------
{
  const dark = await solidCapture([28, 36, 30]);
  const settings = {
    lighting: { brightnessTarget: 80, contrastTarget: 1.6, shadowLiftStrength: 0.6 },
    mowingVisibility: "Unknown",
    effectToggles: { turf: false, lighting: false, floodlight: false, terrain: false, mowing: true }
  };
  const out = await render(dark, settings);
  const sourceMean = await meanLuma(dark);
  const outMean = await meanLuma(out.jpeg);
  assert.equal(out.diagnostics.tone.applied, false, "lighting diagnostics report the pass as disabled");
  assert.ok(Math.abs(outMean - sourceMean) < 2.5, "lighting off leaves source luminance alone, got " + sourceMean.toFixed(1) + " -> " + outMean.toFixed(1));
  console.log("15. Lighting OFF leaves luminance unchanged: %s -> %s", sourceMean.toFixed(1), outMean.toFixed(1));
}

// ---- 16. Terrain OFF isolates the base colour treatment -----------------------------------------
{
  const base = await solidCapture([90, 140, 80]);
  const enc = (hgt) => { const v = Math.round((hgt + 10000) / 0.1); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
  const demRaw = Buffer.alloc(D * D * 3);
  for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
    const dx = (x - D / 2) * 1.9, dy = (y - D / 2) * 1.9;
    const hgt = 40 + 9 * Math.exp(-(dx * dx + dy * dy) / 8000);
    const [a, b, c] = enc(hgt);
    const i = (y * D + x) * 3; demRaw[i] = a; demRaw[i + 1] = b; demRaw[i + 2] = c;
  }
  const { reliefFromTerrainRgb } = await import("../functions/lib/gd-relief-core.mjs");
  const demPng = await sharp(demRaw, { raw: { width: D, height: D, channels: 3 } }).png().toBuffer();
  const relief = await reliefFromTerrainRgb(demPng, { latitude: -36.752, zoom: 16 });
  const terrain = { entry: { role: "terrain-reference", bounds, width: relief.width, height: relief.height }, buffer: relief.png };
  const natural = engine.getPreset("clarity-course-natural-v1");
  const off = await render(base, Object.assign({}, natural, { effectToggles: { turf: true, lighting: true, floodlight: false, terrain: false, mowing: false } }), { terrain });
  const on = await render(base, Object.assign({}, natural, { effectToggles: { turf: true, lighting: true, floodlight: false, terrain: true, mowing: false } }), { terrain });
  const offBuf = await sharp(off.jpeg).raw().toBuffer();
  const onBuf = await sharp(on.jpeg).raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < offBuf.length; i += 997) diff += Math.abs(offBuf[i] - onBuf[i]);
  assert.ok(diff > 0, "terrain on still changes pixels relative to terrain off");
  assert.ok(off.diagnostics.sourceMode !== true, "terrain-off test remains in the normal recipe pipeline");
  console.log("16. Terrain OFF isolates the base treatment: sampled diff to Terrain ON %s", diff);
}

console.log("course-visual-export-normalisation passed");
