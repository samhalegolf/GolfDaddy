/*
 * Green slope lines on a Clarity 3D Mesh live frame.
 *
 * The live frame's elevation is not the bake's: /api/live-terrain-frame resamples the source DEM
 * onto the frame's own grid (gd-live-terrain-core). The green contour fit has a confidence gate
 * that refuses an upsampled coarse DEM, and a resample could in principle smooth a fine one into
 * looking like that. This runs a realistic green through the real chain - DEM samples at the
 * source's own zoom, quantised to terrain-RGB's 0.1m, resampled onto the live window, encoded
 * and decoded again, fitted by the real gd-green-contours-core - and pins both answers:
 *   - fine elevation (LINZ-like, z17 ~1m): the gate passes and there are lines to draw;
 *   - the global terrain tiles (z13, ~15m): the gate refuses and nothing is drawn.
 *
 * Run: node dev/live-green-contours.test.mjs
 */
import assert from "node:assert";
import { createRequire } from "node:module";
import { demPlan, resampleToWindow } from "../functions/lib/gd-live-terrain-core.mjs";
import { terrainRgbFromHeights, metresPerPixel } from "../functions/lib/gd-relief-core.mjs";

const require = createRequire(import.meta.url);
const lt = require("../app/js/live-terrain.js");
const core = require("../scripts/gd-green-contours-core.js");

/* A ~32m green, 16 points round, on a hole at Auckland's latitude. */
const GREEN = { lat: -36.9167, lng: 174.7394 };
const greenShape = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2;
  return { lat: GREEN.lat + Math.sin(a) * 16 / 111320, lng: GREEN.lng + Math.cos(a) * 14 / (111320 * Math.cos(GREEN.lat * Math.PI / 180)) };
});
const HOLE = { tee: { lat: -36.9134, lng: 174.7409 }, green: GREEN, greenShape, route: [] };

/* The ground: a 2.5% fall to the south-west, a gentle crown on the green, a few metres of
   rise across the hole. Metres east/north of the green. */
const M_PER_DEG = 111320, COS = Math.cos(GREEN.lat * Math.PI / 180);
function groundAt(lat, lng) {
  const east = (lng - GREEN.lng) * M_PER_DEG * COS, north = (lat - GREEN.lat) * M_PER_DEG;
  return 40 + 0.025 * (east * 0.6 + north * 0.8) + 0.25 * Math.exp(-(east * east + north * north) / 150)
    + 0.0004 * north * north;
}
function latLngAt(px, py, z) {
  const scale = 256 * Math.pow(2, z);
  const n = Math.PI * (1 - (2 * py) / scale);
  return { lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI, lng: (px / scale) * 360 - 180 };
}

/* What a DEM at `zoom` would hand the endpoint: one sample per pixel centre, quantised to 0.1m. */
function sourceDem(plan) {
  const { left, top, width, height } = plan.fetch;
  const out = new Float32Array(width * height);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const ll = latLngAt(left + i + 0.5, top + j + 0.5, plan.demZoom);
    out[j * width + i] = Math.round(groundAt(ll.lat, ll.lng) * 10) / 10;
  }
  return out;
}

/* The endpoint's answer, as the phone decodes it: terrain-RGB bytes back to heights. */
function liveElevation(win, zoom) {
  const plan = demPlan(win, zoom);
  const heights = resampleToWindow(sourceDem(plan), plan.fetch.width, plan.fetch.height, plan);
  const rgb = terrainRgbFromHeights(heights, plan.grid.width, plan.grid.height);
  const decoded = new Float32Array(plan.grid.width * plan.grid.height);
  for (let i = 0, p = 0; i < decoded.length; i++, p += 3) decoded[i] = -10000 + (rgb[p] * 65536 + rgb[p + 1] * 256 + rgb[p + 2]) * 0.1;
  return { heights: decoded, width: plan.grid.width, height: plan.grid.height };
}

/* nativeM: the source's stated resolution (gd-imagery-sources nativeResolutionM). */
function fitOn(zoom, nativeM) {
  const win = lt.frameWindow(HOLE);
  const elev = liveElevation(win, zoom);
  /* What live-terrain-frame.mjs sends as X-Elevation-Sample-M. */
  const sampleM = Math.max(metresPerPixel(GREEN.lat, demPlan(win, zoom).demZoom), nativeM);
  const meta = lt.surfaceMeta(win, { url: "blob:e", width: elev.width, height: elev.height, min: 0, max: 0, sampleM });
  const surface = core.fitGreenSurface(elev.heights, {
    width: elev.width, height: elev.height,
    bounds: meta.elevation.bounds, metresPerPixel: meta.elevation.metresPerPixel
  }, greenShape);
  return { surface, summary: surface && surface.summary, mpp: meta.elevation.metresPerPixel,
    readable: lt.greenReadable(meta.elevation), sampleM };
}

let passed = 0;
function ok(name, cond, detail) { assert.ok(cond, name + " - " + JSON.stringify(detail)); passed++; console.log("ok  - " + name); }

const fine = fitOn(17, 1);
ok("fine elevation through the live frame is readable and passes the fit's gate",
  fine.readable && fine.surface && fine.summary && fine.summary.confidence !== "low",
  fine.summary && { confidence: fine.summary.confidence, reason: fine.summary.reason, mpp: fine.mpp });
ok("and reads the fall the ground really has", Math.abs(fine.summary.meanSlopePercent - 2.5) < 1.2,
  { slope: fine.summary.meanSlopePercent });
const drawing = core.buildGreenDrawing(fine.surface, {});
ok("and has lines to draw", drawing && drawing.runs.length > 0, drawing && { runs: drawing.runs.length, arrows: drawing.arrows.length });
console.log("      fine: " + fine.summary.confidence + ", " + fine.summary.meanSlopePercent.toFixed(2) + "% fall, "
  + fine.mpp.toFixed(2) + "m per sample");

/* The global tiles: resampled onto the fine grid they can slip past the fit's own detector
   (re-quantising puts back the noise it looks for), which is exactly why the live frame says
   how far apart its real samples are. */
const coarse = fitOn(13, 10);
ok("the global terrain tiles draw no green lines - their samples are ~" + coarse.sampleM.toFixed(0) + "m apart",
  !coarse.readable, { sampleM: coarse.sampleM, fit: coarse.summary && coarse.summary.confidence });
ok("a published bake, which does not state its spacing, is left to the fit's own gate as before",
  lt.greenReadable({ path: "frames/h1.elevation.png" }) === true, null);

console.log("\nlive-green-contours: " + passed + " passed");
