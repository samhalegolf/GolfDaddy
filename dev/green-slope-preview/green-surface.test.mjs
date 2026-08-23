/* Does a green slope read survive the DEM we actually have?

   This is the go/no-go for the whole green-map idea, and it is answerable without any imagery:
   build a green whose slope is KNOWN, sample it exactly the way Jacks Point's published
   elevation samples it (1.687 m/px, heights quantised to 0.1m by terrain-RGB), fit, and ask
   how far the recovered fall is from the truth.

   Run: node dev/green-slope-preview/green-surface.test.mjs */

import assert from "node:assert/strict";
import { fitSurface, flowLines, summarise, compassName, pointInPolygon } from "./green-surface.mjs";

let checks = 0;
const ok = (label) => { console.log("  ok  " + label); checks++; };

/* ---------- a green with known truth ------------------------------------------------------- */

/* Jacks Point h1 measures about 33m x 32m. This one falls back-to-front and slightly left,
   crowns a little through the middle, and carries a soft tier across the back - the shapes a
   real green makes. The cubic term is there on purpose: an order-3 fit cannot represent it
   perfectly, so the test is measuring recovery of a surface that is NOT in the model's span,
   which is the honest case. */
const TRUTH = {
  fallX: -0.018,          // 1.8% down toward the west
  fallY: -0.021,          // 2.1% down toward the south  => ~2.77% total, bearing ~200 deg
  crown: 0.0009,
  tier: 0.35
};
function trueHeight(x, y) {
  return 350
    + TRUTH.fallX * x
    + TRUTH.fallY * y
    - TRUTH.crown * (x * x + y * y)
    + TRUTH.tier * Math.tanh((y - 8) / 3.2)
    + 0.02 * Math.sin(x / 4) * Math.cos(y / 5);
}
/* Analytic gradient of the truth, so the target is the surface's ACTUAL mean fall rather than
   just its linear terms. The tier alone contributes a large mean dz/dy - comparing against
   fallX/fallY would be scoring the fit against a slope the test surface does not have. */
function trueGradient(x, y) {
  const sech2 = 1 - Math.pow(Math.tanh((y - 8) / 3.2), 2);
  return {
    dx: TRUTH.fallX - 2 * TRUTH.crown * x + 0.02 * (1 / 4) * Math.cos(x / 4) * Math.cos(y / 5),
    dy: TRUTH.fallY - 2 * TRUTH.crown * y + TRUTH.tier * (1 / 3.2) * sech2 - 0.02 * (1 / 5) * Math.sin(x / 4) * Math.sin(y / 5)
  };
}

/* A rounded green outline, ~33m x 32m, centred on the origin. */
const POLYGON = Array.from({ length: 48 }, (_, i) => {
  const a = (i / 48) * Math.PI * 2;
  return { x: Math.cos(a) * (16.5 + 1.6 * Math.cos(3 * a)), y: Math.sin(a) * (16 + 1.2 * Math.sin(2 * a)) };
});

/* Mean true fall over the green interior, sampled the same way summarise() samples the fit. */
const truth = (() => {
  let sx = 0, sy = 0, n = 0;
  for (let y = -18; y <= 18; y += 0.5) {
    for (let x = -18; x <= 18; x += 0.5) {
      if (!pointInPolygon(x, y, POLYGON)) continue;
      const g = trueGradient(x, y);
      sx += g.dx; sy += g.dy; n++;
    }
  }
  const dx = sx / n, dy = sy / n;
  return {
    percent: Math.hypot(dx, dy) * 100,
    bearing: (((Math.atan2(-dx, -dy) * 180) / Math.PI) + 360) % 360
  };
})();
const trueSlopePercent = truth.percent;
const trueBearing = truth.bearing;

/* Sample the truth on a lattice, quantised the way terrain-RGB quantises. `smooth` models a
   coarse source upsampled to a fine grid: no quantisation texture, because the detail was
   never there. */
function sampleGreen({ spacing, quantise = 0.1, collar = 7, smooth = false }) {
  const samples = [];
  for (let y = -26; y <= 26; y += spacing) {
    for (let x = -26; x <= 26; x += spacing) {
      const inside = pointInPolygon(x, y, POLYGON);
      const near = Math.hypot(x, y) < 16.5 + collar;
      if (!inside && !near) continue;
      let z = trueHeight(x, y);
      if (smooth) z = 350 + TRUTH.fallX * x + TRUTH.fallY * y;      // detail-free
      else if (quantise) z = Math.round(z / quantise) * quantise;
      samples.push({ x, y, z });
    }
  }
  return samples;
}

/* ---------- 1. today's sampling: Jacks Point's published elevation -------------------------- */

const TODAY_SPACING = 1.687;   // metresPerPixel from jacks-point h1.jpg.json, captureZoom 16
const today = sampleGreen({ spacing: TODAY_SPACING });
const fitToday = fitSurface(today, { order: 3, scale: 20 });
assert.ok(fitToday, "fit must converge on today's sampling");

const sumToday = summarise(fitToday, POLYGON, { metresPerSample: TODAY_SPACING });
const bearingErrToday = Math.abs(((sumToday.fallBearing - trueBearing + 540) % 360) - 180);
const slopeErrToday = Math.abs(sumToday.meanSlopePercent - trueSlopePercent);

console.log(`\n1. today's DEM  (${TODAY_SPACING}m spacing, 0.1m quantisation, ${fitToday.sampleCount} samples)`);
console.log(`   true fall  ${trueSlopePercent.toFixed(2)}%  bearing ${trueBearing.toFixed(0)} (${compassName(trueBearing)})`);
console.log(`   recovered  ${sumToday.meanSlopePercent.toFixed(2)}%  bearing ${sumToday.fallBearing.toFixed(0)} (${compassName(sumToday.fallBearing)})`);
console.log(`   error      ${slopeErrToday.toFixed(2)} pts of slope, ${bearingErrToday.toFixed(1)} degrees`);
console.log(`   residual   ${fitToday.residualRms.toFixed(3)}m (${sumToday.residualRatio.toFixed(1)}x quantisation) -> ${sumToday.confidence}`);

assert.ok(bearingErrToday < 12, `fall direction must be within 12 degrees, got ${bearingErrToday.toFixed(1)}`);
ok(`fall direction recovered to ${bearingErrToday.toFixed(1)} degrees at today's sampling`);
assert.ok(slopeErrToday < 0.6, `slope magnitude must be within 0.6 points, got ${slopeErrToday.toFixed(2)}`);
ok(`slope magnitude recovered to ${slopeErrToday.toFixed(2)} points`);

/* ---------- 2. the naive method, for contrast ---------------------------------------------- */

/* What a normal slope raster does: difference neighbouring pixels. Same data, no fit. */
function naiveSlopeAtCentre(spacing) {
  const q = v => Math.round(v / 0.1) * 0.1;
  const dzdx = (q(trueHeight(spacing, 0)) - q(trueHeight(-spacing, 0))) / (2 * spacing);
  const dzdy = (q(trueHeight(0, spacing)) - q(trueHeight(0, -spacing))) / (2 * spacing);
  const bearing = (((Math.atan2(-dzdx, -dzdy) * 180) / Math.PI) + 360) % 360;
  return { percent: Math.hypot(dzdx, dzdy) * 100, bearing };
}
const naive = naiveSlopeAtCentre(TODAY_SPACING);
const naiveBearingErr = Math.abs(((naive.bearing - trueBearing + 540) % 360) - 180);
console.log(`\n2. naive neighbour differencing on the same data`);
console.log(`   recovered  ${naive.percent.toFixed(2)}%  bearing ${naive.bearing.toFixed(0)} (${compassName(naive.bearing)})`);
console.log(`   error      ${naiveBearingErr.toFixed(1)} degrees  <- this is why the surface is fitted`);
assert.ok(naiveBearingErr > bearingErrToday, "the fit must beat neighbour differencing");
ok(`fitting beats differencing by ${(naiveBearingErr - bearingErrToday).toFixed(0)} degrees of bearing error`);

/* ---------- 3. the proposed green-scoped z17 capture ---------------------------------------- */

const NATIVE_SPACING = 0.95;   // z17 at NZ latitudes - native for the 1m LiDAR
const native = sampleGreen({ spacing: NATIVE_SPACING });
const fitNative = fitSurface(native, { order: 3, scale: 20 });
const sumNative = summarise(fitNative, POLYGON, { metresPerSample: NATIVE_SPACING });
const bearingErrNative = Math.abs(((sumNative.fallBearing - trueBearing + 540) % 360) - 180);

console.log(`\n3. proposed green-scoped z17 capture (${NATIVE_SPACING}m spacing, ${fitNative.sampleCount} samples)`);
console.log(`   recovered  ${sumNative.meanSlopePercent.toFixed(2)}%  bearing ${sumNative.fallBearing.toFixed(0)} (${compassName(sumNative.fallBearing)})`);
console.log(`   error      ${bearingErrNative.toFixed(1)} degrees   residual ${fitNative.residualRms.toFixed(3)}m -> ${sumNative.confidence}`);
assert.ok(fitNative.sampleCount > fitToday.sampleCount * 2.5, "z17 must roughly triple the sample count");
ok(`z17 lifts samples from ${fitToday.sampleCount} to ${fitNative.sampleCount}`);

/* ---------- 4. the confidence gate must refuse bad inputs ----------------------------------- */

const smooth = sampleGreen({ spacing: NATIVE_SPACING, smooth: true });
const fitSmooth = fitSurface(smooth, { order: 3, scale: 20 });
const sumSmooth = summarise(fitSmooth, POLYGON, { metresPerSample: NATIVE_SPACING });
console.log(`\n4. coarse DEM upsampled to a fine grid (the 8m LINZ / 10m 3DEP fallback tier)`);
console.log(`   residual ${fitSmooth.residualRms.toFixed(4)}m -> ${sumSmooth.confidence}: ${sumSmooth.reason}`);
assert.strictEqual(sumSmooth.confidence, "low", "a detail-free source must be refused");
ok("a coarse source upsampled to a fine grid is refused rather than drawn");

const tiny = sampleGreen({ spacing: 6 });
const fitTiny = fitSurface(tiny, { order: 3, scale: 20 });
const sumTiny = fitTiny ? summarise(fitTiny, POLYGON, { metresPerSample: 6 }) : null;
assert.ok(!fitTiny || sumTiny.confidence === "low", "too few samples must be refused");
ok("a green with too few samples is refused rather than drawn");

/* ---------- 5. flow lines behave --------------------------------------------------------- */

const lines = flowLines(fitToday, POLYGON);
assert.ok(lines.length > 20, `expected a useful number of flow lines, got ${lines.length}`);
const meanBearing = lines.reduce((a, l) => a + l.bearing, 0) / lines.length;
const flowErr = Math.abs(((meanBearing - trueBearing + 540) % 360) - 180);
assert.ok(flowErr < 15, `flow lines must run downhill, off by ${flowErr.toFixed(1)} degrees`);
ok(`${lines.length} flow lines, mean heading within ${flowErr.toFixed(1)} degrees of true fall`);

/* Determinism: two renders of one green must not disagree about where the flow is. */
const again = flowLines(fitToday, POLYGON);
assert.deepStrictEqual(lines.map(l => l.points.length), again.map(l => l.points.length));
ok("flow lines are deterministic across runs");

/* A flat green must grow almost nothing - the layer has to be absent where there is nothing
   to say, or it reads as decoration. */
const flatFit = fitSurface(
  sampleGreen({ spacing: NATIVE_SPACING }).map(s => ({ ...s, z: 350 + 0.0005 * s.x })),
  { order: 3, scale: 20 }
);
const flatLines = flowLines(flatFit, POLYGON);
assert.ok(flatLines.length === 0, `a flat green must draw no flow lines, got ${flatLines.length}`);
ok("a flat green draws no flow lines at all");

console.log(`\ngreen-surface passed: ${checks} checks`);
