/* Green contours: the fit, the confidence gate, and the wiring into the export overlay.
 *
 * Runs against the real Jacks Point elevation in dev/green-slope-preview/data when it is
 * present, and skips those cases rather than failing when it is not - that directory is
 * gitignored, so CI has synthetic coverage and a developer who has run fetch-green-data.mjs
 * gets the real thing as well.
 *
 *   node dev/green-contours-wiring.test.js
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { decodeElevation, terrainRgbFromHeights } from "../functions/lib/gd-relief-core.mjs";
import greenCore from "../scripts/gd-green-contours-core.js";
const {
  fitGreenSurface, buildGreenDrawing, contourPaths, chainSegments, smoothPolyline,
  metricFrame, pointInPolygon, distanceToPolygon, arrowWings, CONTOUR_DEFAULTS
} = greenCore;

/* The SVG renderer lives in the export core because projection does; the test rebuilds the
   same few lines so it can assert on real markup without importing sharp's whole module. */
function renderSvg(surface, W, H, project, options) {
  const drawing = buildGreenDrawing(surface, options);
  if (!drawing) return null;
  const toPx = (m) => project(surface.frame.toLatLng(m.x, m.y));
  const f1 = (n) => Number(n).toFixed(1);
  const parts = [];
  for (const run of drawing.runs) {
    const px = run.points.map(toPx).filter(Boolean);
    if (px.length < 2) continue;
    const d = "M" + px.map(p => f1(p.x) + " " + f1(p.y)).join("L");
    if (run.haloWidthPx > 0) parts.push('<path d="' + d + '" stroke="' + run.haloColour + '" stroke-opacity="' + run.haloAlpha.toFixed(3) + '" stroke-width="' + run.haloWidthPx.toFixed(2) + '"/>');
    parts.push('<path d="' + d + '" stroke="' + run.colour + '" stroke-opacity="' + run.alpha.toFixed(3) + '" stroke-width="' + run.widthPx.toFixed(2) + '"/>');
  }
  for (const a of drawing.arrows) {
    const tail = toPx(a.tail), head = toPx(a.head);
    if (!tail || !head) continue;
    const w = arrowWings(tail, head);
    const d = "M" + f1(tail.x) + " " + f1(tail.y) + "L" + f1(head.x) + " " + f1(head.y) +
              "M" + f1(w[0].x) + " " + f1(w[0].y) + "L" + f1(head.x) + " " + f1(head.y) + "L" + f1(w[1].x) + " " + f1(w[1].y);
    parts.push('<path d="' + d + '" stroke="' + a.haloColour + '" stroke-opacity="' + a.haloAlpha.toFixed(3) + '" stroke-width="' + a.haloWidthPx.toFixed(2) + '"/>');
    parts.push('<path d="' + d + '" stroke="' + a.colour + '" stroke-opacity="' + a.alpha.toFixed(3) + '" stroke-width="' + a.widthPx.toFixed(2) + '"/>');
  }
  if (!parts.length) return null;
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '"><g fill="none" stroke-linecap="round" stroke-linejoin="round">' + parts.join("") + '</g></svg>');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "green-slope-preview", "data");

let passed = 0, skipped = 0;
function ok(name) { passed++; console.log("  ok   " + name); }
function skip(name, why) { skipped++; console.log("  skip " + name + " (" + why + ")"); }

/* ---------- synthetic green: a known tilt, so the answer is checkable ---------------------- */

const ORIGIN = { lat: -45.08, lng: 168.7375 };
const FRAME = metricFrame(ORIGIN.lat, ORIGIN.lng);

/* A 34m green as a rounded polygon, and a surface that falls a known 3% due east with a gentle
   crown on it - steep enough to earn arrows, smooth enough to fit. */
function syntheticGreen(radiusM = 17) {
  const shape = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const r = radiusM * (0.82 + 0.18 * Math.cos(a * 2));
    const ll = FRAME.toLatLng(Math.cos(a) * r, Math.sin(a) * r);
    shape.push(ll);
  }
  return shape;
}
const trueHeight = (x, y) => 100 - 0.03 * x - 0.004 * (x * x + y * y) * 0.05;

/* Bake that surface into a terrain-RGB raster the way a real DEM crop arrives, quantisation
   and all, so the fit is tested against the same 0.1m step it faces in production. */
async function syntheticRaster(mppM = 1.69, halfSpanM = 34) {
  const size = Math.ceil((halfSpanM * 2) / mppM);
  const heights = new Float32Array(size * size);
  const mPerLat = 111320, mPerLng = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
  const north = ORIGIN.lat + halfSpanM / mPerLat, south = ORIGIN.lat - halfSpanM / mPerLat;
  const west = ORIGIN.lng - halfSpanM / mPerLng, east = ORIGIN.lng + halfSpanM / mPerLng;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = -halfSpanM + (i + 0.5) * mppM;
      const y = halfSpanM - (j + 0.5) * mppM;
      heights[j * size + i] = trueHeight(x, y);
    }
  }
  /* Round-trip through the real packing so quantisation is genuine, not simulated. */
  const raw = terrainRgbFromHeights(heights, size, size);
  const decoded = decodeElevation(raw, size, size, 3, "terrain-rgb");
  return {
    heights: decoded.heights,
    raster: { width: size, height: size, bounds: { north, south, east, west }, metresPerPixel: mppM }
  };
}

/* A projector standing in for the export core's mercProject: linear over this tiny window. */
function fakeProject(bounds, width, height) {
  return (pt) => {
    if (!pt) return null;
    const fx = (pt.lng - bounds.west) / (bounds.east - bounds.west);
    const fy = (bounds.north - pt.lat) / (bounds.north - bounds.south);
    return { x: fx * width, y: fy * height };
  };
}

async function run() {
  console.log("green contours\n");

  /* ---- the fit recovers a known slope ---- */
  {
    const { heights, raster } = await syntheticRaster();
    const shape = syntheticGreen();
    const surface = fitGreenSurface(heights, raster, shape);
    assert.ok(surface, "fit should converge on a clean synthetic green");
    const s = surface.summary;
    /* Truth at the centre is 3% falling east; the crown adds a little across the green. */
    assert.ok(Math.abs(s.meanSlopePercent - 3.0) < 1.2,
      "mean slope " + s.meanSlopePercent.toFixed(2) + "% should be near the 3% built in");
    assert.ok(s.fallBearing > 45 && s.fallBearing < 135,
      "fall bearing " + s.fallBearing.toFixed(0) + " should point east-ish");
    assert.equal(s.confidence, "good");
    ok("fit recovers a known 3% east fall through terrain-RGB quantisation");
  }

  /* ---- the confidence gate refuses a surface with no detail ---- */
  {
    /* A perfectly planar surface with no quantisation is what upsampled coarse DEM looks like:
       it fits beautifully and knows nothing. The gate must catch it. */
    const mpp = 1.69, size = 40;
    const heights = new Float32Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) heights[j * size + i] = 100 - 0.02 * i * mpp;
    const mPerLat = 111320, mPerLng = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
    const half = (size * mpp) / 2;
    const raster = {
      width: size, height: size, metresPerPixel: mpp,
      bounds: {
        north: ORIGIN.lat + half / mPerLat, south: ORIGIN.lat - half / mPerLat,
        west: ORIGIN.lng - half / mPerLng, east: ORIGIN.lng + half / mPerLng
      }
    };
    const surface = fitGreenSurface(heights, raster, syntheticGreen(15));
    assert.ok(surface, "fit itself should still converge");
    assert.equal(surface.summary.confidence, "low",
      "a residual far below quantisation must be refused, not drawn");
    assert.match(surface.summary.reason, /below quantisation/);
    ok("confidence gate refuses upsampled coarse DEM (residual under quantisation)");
  }

  /* ---- chaining and smoothing produce continuous lines, not sticks ---- */
  {
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, level: 0.15 },
      { a: { x: 1, y: 0 }, b: { x: 2, y: 0 }, level: 0.15 },
      { a: { x: 2, y: 0 }, b: { x: 3, y: 0 }, level: 0.15 },
      { a: { x: 9, y: 9 }, b: { x: 9, y: 8 }, level: 0.30 }
    ];
    const chains = chainSegments(segs);
    assert.equal(chains.length, 2, "three touching segments plus one loner make two chains");
    const long = chains.find(c => c.points.length === 4);
    assert.ok(long, "the three touching segments must join into one 4-point line");
    const smoothed = smoothPolyline(long.points, { passes: 2, closed: false });
    assert.ok(smoothed.length > long.points.length, "Chaikin adds points");
    assert.deepEqual(smoothed[0], long.points[0], "open lines keep their endpoints");
    ok("marching-squares segments chain into continuous smoothed polylines");
  }

  /* ---- nothing is drawn outside the green, and nothing reaches its edge ---- */
  {
    const { heights, raster } = await syntheticRaster();
    const shape = syntheticGreen();
    const surface = fitGreenSurface(heights, raster, shape);
    const paths = contourPaths(surface.fit, surface.polygon, { interval: CONTOUR_DEFAULTS.intervalM, cell: 0.35 });
    assert.ok(paths.length > 3, "a 34m green with this fall should carry several contours");
    let outside = 0;
    for (const c of paths) for (const p of c.points) if (!pointInPolygon(p.x, p.y, surface.polygon)) outside++;
    /* Chaikin can pull a smoothed point a few cm across a concave boundary; the fade covers it,
       but a real leak would be thousands of points, not a handful. */
    const total = paths.reduce((n, c) => n + c.points.length, 0);
    assert.ok(outside / total < 0.02, "contour points must lie inside the green (" + outside + "/" + total + " outside)");
    ok("contours stay inside the green polygon");
  }

  /* ---- the overlay renders, and fades before the boundary so no outline shows ---- */
  {
    const { heights, raster } = await syntheticRaster();
    const shape = syntheticGreen();
    const surface = fitGreenSurface(heights, raster, shape);
    const W = 900, H = 900;
    const project = fakeProject(raster.bounds, W, H);
    const svg = renderSvg(surface, W, H, project);
    assert.ok(svg && svg.length > 0, "overlay should render");

    const text = svg.toString("utf8");
    assert.ok(!/feGaussianBlur|<mask/.test(text),
      "the fade must be drawn, not masked - no filter primitives to depend on");
    /* Every stroke-opacity must be a real number and none may be full strength at the rim. */
    const alphas = [...text.matchAll(/stroke-opacity="([\d.]+)"/g)].map(m => Number(m[1]));
    assert.ok(alphas.length > 20, "expected many per-run opacities, got " + alphas.length);
    assert.ok(alphas.every(a => a >= 0 && a <= 1), "opacities must be in range");

    /* The load-bearing property: rasterise and confirm the drawing dies out before the green
       edge, so the outline itself is never visible as a border. */
    const png = await sharp(svg).png().toBuffer();
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mPerLat = 111320, mPerLng = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
    let inkNearEdge = 0, inkWellInside = 0;
    for (let y = 0; y < info.height; y += 2) {
      for (let x = 0; x < info.width; x += 2) {
        const alpha = data[(y * info.width + x) * info.channels + info.channels - 1];
        if (alpha < 8) continue;
        const lng = raster.bounds.west + (x / info.width) * (raster.bounds.east - raster.bounds.west);
        const lat = raster.bounds.north - (y / info.height) * (raster.bounds.north - raster.bounds.south);
        const m = { x: (lng - ORIGIN.lng) * mPerLng, y: (lat - ORIGIN.lat) * mPerLat };
        if (!pointInPolygon(m.x, m.y, surface.polygon)) { inkNearEdge++; continue; }
        const d = distanceToPolygon(m.x, m.y, surface.polygon);
        if (d < 0.6) inkNearEdge++;
        else if (d > 4) inkWellInside++;
      }
    }
    assert.ok(inkWellInside > 200, "expected substantial ink in the body of the green, got " + inkWellInside);
    assert.ok(inkNearEdge / Math.max(1, inkWellInside) < 0.05,
      "ink must fade out before the green edge (" + inkNearEdge + " near-edge vs " + inkWellInside + " inside)");
    ok("overlay fades to nothing before the green edge - the outline never shows");
  }

  /* ---- the display list is the contract both platforms draw from ---- */
  {
    const { heights, raster } = await syntheticRaster();
    const surface = fitGreenSurface(heights, raster, syntheticGreen());
    const drawing = buildGreenDrawing(surface, {});
    assert.ok(drawing && drawing.runs.length > 20, "expected a populated run list");
    assert.ok(drawing.arrows.length > 0, "expected arrows on a 3% green");

    for (const r of drawing.runs) {
      assert.ok(Array.isArray(r.points) && r.points.length >= 2, "each run is a polyline");
      assert.ok(r.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)), "points are finite metres");
      assert.ok(r.alpha > 0 && r.alpha <= 1, "alpha resolved in range");
      assert.ok(r.widthPx > 0, "width is a pixel width");
      assert.ok(/^(#|rgb\()/.test(r.colour), "colour is renderable by SVG and canvas alike");
    }
    for (const a of drawing.arrows) {
      assert.ok(Number.isFinite(a.tail.x) && Number.isFinite(a.head.x), "arrow ends are metres");
      assert.ok(a.alpha > 0 && a.alpha <= 1);
    }
    /* Nothing in the list carries pixels-of-a-particular-frame: the whole point is that the
       phone can re-project it at any zoom. */
    assert.ok(drawing.runs.every(r => r.points.every(p => Math.abs(p.x) < 200 && Math.abs(p.y) < 200)),
      "coordinates are green-local metres, not frame pixels");
    ok("display list is platform-neutral metres with colour and alpha resolved");
  }

  /* ---- the same surface renders at wildly different scales ---- */
  {
    const { heights, raster } = await syntheticRaster();
    const surface = fitGreenSurface(heights, raster, syntheticGreen());
    /* 77px is what the published hole frame gives a green; ~900px is what green focus gives it
       on a phone. The display list must serve both without being rebuilt differently. */
    const small = renderSvg(surface, 77, 77, fakeProject(raster.bounds, 77, 77));
    const large = renderSvg(surface, 900, 900, fakeProject(raster.bounds, 900, 900));
    assert.ok(small && large, "both scales should render");
    assert.ok(large.length > small.length, "the larger frame carries more path detail");
    ok("one display list renders at both hole-frame and green-focus scale");
  }

  /* ---- the one exposed knob actually gates arrows ---- */
  {
    const { heights, raster } = await syntheticRaster();
    const surface = fitGreenSurface(heights, raster, syntheticGreen());
    const project = fakeProject(raster.bounds, 900, 900);
    const countArrows = (svg) => (svg.toString("utf8").match(/M[\d.]+ [\d.]+L[\d.]+ [\d.]+M/g) || []).length;
    const loose = renderSvg(surface, 900, 900, project, { arrowMinSlopePercent: 0.5 });
    const strict = renderSvg(surface, 900, 900, project, { arrowMinSlopePercent: 9 });
    assert.ok(countArrows(loose) > 0, "a 3% green should earn arrows at a 0.5% threshold");
    assert.ok(countArrows(strict) < countArrows(loose),
      "raising the threshold must remove arrows (" + countArrows(loose) + " -> " + countArrows(strict) + ")");
    ok("arrowMinSlopePercent gates arrows without touching the contours");
  }

  /* ---- real Jacks Point greens, if the preview data has been fetched ---- */
  for (const hole of [1, 6, 8, 9, 17]) {
    let meta, buf;
    try {
      meta = JSON.parse(await readFile(path.join(DATA, "h" + hole + ".meta.json"), "utf8"));
      buf = await readFile(path.join(DATA, "h" + hole + ".elevation.png"));
    } catch {
      skip("real h" + hole, "run dev/green-slope-preview/fetch-green-data.mjs");
      continue;
    }
    const em = meta.playSurface && meta.playSurface.elevation;
    const shape = meta.playSurface && meta.playSurface.anchorPins && meta.playSurface.anchorPins.greenShape;
    if (!em || !shape) { skip("real h" + hole, "no elevation or green polygon"); continue; }

    const raw = await sharp(buf, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
    const decoded = decodeElevation(raw.data, raw.info.width, raw.info.height, raw.info.channels, em.encoding);
    const surface = fitGreenSurface(decoded.heights, {
      width: raw.info.width, height: raw.info.height, bounds: em.bounds, metresPerPixel: em.metresPerPixel
    }, shape);
    assert.ok(surface, "h" + hole + " should fit");
    const s = surface.summary;
    assert.equal(s.confidence !== "low", true,
      "h" + hole + " must pass the gate, got " + s.confidence + ": " + s.reason);
    /* The measurements recorded in the module header - a regression here means the fit changed. */
    assert.ok(s.residualRatio > 1 && s.residualRatio < 6,
      "h" + hole + " residual ratio " + s.residualRatio.toFixed(1) + "x should sit between 1 and 6");
    const svg = renderSvg(surface, 1200, 1200, fakeProject(em.bounds, 1200, 1200));
    assert.ok(svg && svg.length > 0, "h" + hole + " should produce an overlay");
    ok("real h" + hole + ": " + s.sampleCount + " samples, " + s.meanSlopePercent.toFixed(2) + "% fall, " +
       s.residualRms.toFixed(3) + "m residual (" + s.residualRatio.toFixed(1) + "x) -> " + s.confidence);
  }

  console.log("\n" + passed + " passed" + (skipped ? ", " + skipped + " skipped" : ""));
}

run().catch(e => { console.error("\nFAILED: " + (e && e.message || e)); process.exit(1); });
