#!/usr/bin/env node
"use strict";

/* The capture plan must not shoot detail the compositor throws away.
 *
 * The export resamples every capture for a hole onto ONE mercator grid, whose zoom falls out
 * of the hole's extent and the output cap. Detail above that grid is not extra quality - it is
 * fetched, decoded, resampled and discarded. Measured on the real Jacks Point package before
 * this landed: 18 of 18 holes were shot 2-4x sharper than the frame they landed in, 10,307
 * tile requests and 584 megapixels composited to produce ~72MP of frames, with one capture at
 * 37.9MP. That single capture is 151MB of raw pixels, and it is what put the snapshot worker
 * against its 1024MB ceiling - the OOM was a planning bug wearing a memory bug's clothes.
 *
 * Two things hold it together and both are easy to break silently:
 *   - captures clamp to the frame zoom, and the planner's idea of that zoom must match the
 *     export's, or captures are wasted (planner high) or upscaled (planner low);
 *   - bleedPx is authored in PIXELS, so it must be rescaled when the zoom changes. Left alone,
 *     stepping down a zoom doubles its ground coverage, which widens the capture, which widens
 *     the frame, which steps the zoom down again. */

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* A course of straight holes on a diagonal, which is the case that hurts: the axis-aligned box
   a rotated lens is captured through is far larger than the lens itself. */
function course(holeCount = 6, lengthDeg = 0.004) {
  const objects = {};
  for (let h = 1; h <= holeCount; h++) {
    const lat0 = -45.02 - h * 0.0016, lng0 = 168.72 + h * 0.0016;
    objects["t" + h] = { id: "t" + h, type: "tee", holeNumber: h, position: { lat: lat0, lng: lng0 } };
    objects["g" + h] = {
      id: "g" + h, type: "green", holeNumber: h,
      position: { lat: lat0 - lengthDeg, lng: lng0 + lengthDeg },
      greenShape: [
        { lat: lat0 - lengthDeg + 0.0002, lng: lng0 + lengthDeg },
        { lat: lat0 - lengthDeg, lng: lng0 + lengthDeg + 0.0002 },
        { lat: lat0 - lengthDeg - 0.0002, lng: lng0 + lengthDeg }
      ]
    };
  }
  return { courseId: "test-course", courseName: "Test Course", objects, holes: {} };
}

const SOURCE = {
  key: "test-xyz", label: "Test",
  imagery: { adapter: "xyz", urlTemplate: "https://tiles.test/{z}/{x}/{y}.webp", maxUsefulZoom: 20 },
  terrain: null
};
const MAX_OUTPUT_PX = 3072;

let plan9;

(async function run() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "functions", "lib", "gd-visual-plan-core.mjs")).href);
  const { planCourseCaptures, captureGrid, frameZoomFor, mergeBounds, capturePolicy } = mod;

  test("no capture is shot above the frame it lands in", () => {
    const pkg = course();
    const plan = planCourseCaptures(pkg, { source: SOURCE, maxOutputPx: MAX_OUTPUT_PX, terrainSource: null });
    const holes = [...new Set(plan.filter(i => i.holeNumber).map(i => i.holeNumber))];
    assert.ok(holes.length >= 6, "the fixture must actually produce holes");
    holes.forEach(hole => {
      const items = plan.filter(i => Number(i.holeNumber) === hole && !i.terrainStageOnly);
      const grids = items.map(i => captureGrid(i, { source: SOURCE })).filter(Boolean);
      /* The export merges the capture image bounds - this is the same maths it uses. */
      const frameZoom = frameZoomFor(mergeBounds(grids.map(g => g.imageBounds)), MAX_OUTPUT_PX);
      grids.forEach((g, i) => assert.ok(g.captureZoom <= frameZoom,
        `hole ${hole} capture ${items[i].role} shot at z${g.captureZoom} for a z${frameZoom} frame`));
    });
  });

  test("clamping actually bites - the fixture would otherwise overshoot", () => {
    const pkg = course();
    /* Same plan with no source: the planner cannot grid, falls back to metric bounds, and the
       policy zooms stand. If this ever stops overshooting the test above proves nothing. */
    const unclamped = planCourseCaptures(pkg, { terrainSource: null });
    const clamped = planCourseCaptures(pkg, { source: SOURCE, maxOutputPx: MAX_OUTPUT_PX, terrainSource: null });
    const tilesOf = (plan) => plan.reduce((sum, item) => {
      const g = captureGrid(item, { source: SOURCE });
      return sum + (g ? g.tiles.length : 0);
    }, 0);
    const before = tilesOf(unclamped), after = tilesOf(clamped);
    assert.ok(after < before * 0.6, `clamping should cut tiles substantially: ${before} -> ${after}`);
  });

  test("a pixel bleed covers the same ground at any zoom", () => {
    /* The feedback loop this prevents: unscaled, one step down doubles the bleed's footprint,
       which enlarges the capture, which lowers the frame zoom, which steps down again. */
    const pkg = course(2);
    const item = planCourseCaptures(pkg, { terrainSource: null }).find(i => i.role === "play-corridor");
    assert.ok(item, "fixture must produce a corridor");
    const wide = captureGrid(Object.assign({}, item, { frameZoom: 19 }), { source: SOURCE });
    const narrow = captureGrid(Object.assign({}, item, { frameZoom: 17 }), { source: SOURCE });
    assert.strictEqual(wide.captureZoom, 19);
    assert.strictEqual(narrow.captureZoom, 17);
    const ground = (g) => Math.abs(g.imageBounds.east - g.imageBounds.west);
    const ratio = ground(narrow) / ground(wide);
    /* Two zooms apart. Without rescaling the bleed this would be nearer 1.5-2x. */
    assert.ok(ratio > 0.85 && ratio < 1.15,
      `ground coverage must not balloon when the zoom drops (ratio ${ratio.toFixed(2)})`);
  });

  test("the planner's frame zoom is the export's frame zoom", () => {
    /* Ported deliberately rather than imported: if gd-visual-export-core changes its maths,
       this fails and someone has to reconcile the two on purpose. */
    function world(lat, lng) {
      const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
      return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
    }
    /* Mirrors renderHoleSurfaceMercator: f is NOT clamped at 1, and the ceiling is what the
       source resolves (there, the sharpest capture actually in hand). */
    const exportZoom = (bounds, ceiling) => {
      const nw = world(bounds.north, bounds.west), se = world(bounds.south, bounds.east);
      const span19 = Math.max(se.x - nw.x, se.y - nw.y) * 256 * Math.pow(2, 19);
      return Math.max(1, Math.min(ceiling, Math.floor(19 + Math.log2(MAX_OUTPUT_PX / Math.max(1, span19)))));
    };
    /* A long hole, where the output budget binds and the old clamp was inert anyway. */
    const long = { south: -45.05, west: 168.72, north: -45.04, east: 168.735 };
    assert.strictEqual(frameZoomFor(long, MAX_OUTPUT_PX, 20), exportZoom(long, 20));

    /* A par 3, which is the case the clamp used to break: it spans far less than the budget,
       so the frame should now climb to whatever the source can resolve. */
    const short = { south: -45.0508, west: 168.7200, north: -45.0495, east: 168.7218 };
    assert.strictEqual(frameZoomFor(short, MAX_OUTPUT_PX, 20), exportZoom(short, 20));
    assert.ok(frameZoomFor(short, MAX_OUTPUT_PX, 20) > 19,
      "a short hole with budget to spare must be allowed to frame above z19");
    /* ...but never past what the imagery actually holds. */
    assert.strictEqual(frameZoomFor(short, MAX_OUTPUT_PX, 19), 19);
  });

  test("the source resolution ceiling still wins where it is lower", () => {
    /* NAIP is 0.6m: asking it for z19 buys upscaled mush at full price, so maxUsefulZoom must
       clamp even when the frame would happily render sharper. */
    const naip = Object.assign({}, SOURCE, {
      imagery: Object.assign({}, SOURCE.imagery, { maxUsefulZoom: 17 })
    });
    const pkg = course(2);
    const plan = planCourseCaptures(pkg, { source: naip, maxOutputPx: MAX_OUTPUT_PX, terrainSource: null });
    plan.forEach(item => {
      const g = captureGrid(item, { source: naip });
      if (g) assert.ok(g.captureZoom <= 17, `${item.role} shot at z${g.captureZoom} from a z17 source`);
    });
  });

  test("a green surround inside its own corridor is not captured twice", () => {
    /* Once every capture clamps to the frame zoom, a long hole's green surround is the same
       ground at the same resolution as the corridor that already covers it. On the real Jacks
       Point package this drops 18 green captures to 3. */
    const pkg = course(4);
    const plan = planCourseCaptures(pkg, { source: SOURCE, maxOutputPx: MAX_OUTPUT_PX, terrainSource: null });
    const greens = plan.filter(i => i.role === "green-surround");
    greens.forEach(green => {
      const corridors = plan.filter(i => i.role === "play-corridor" && i.holeNumber === green.holeNumber);
      if (!corridors.length) return;
      const covered = mergeBounds(corridors.map(i => captureGrid(i, { source: SOURCE }).imageBounds));
      const bounds = captureGrid(green, { source: SOURCE }).imageBounds;
      assert.ok(!mod.boundsContain(covered, bounds),
        `hole ${green.holeNumber} kept a green surround its corridor already covers`);
    });
  });

  test("dropping redundant greens never shrinks a hole's frame", () => {
    /* The load-bearing one. A corridor is a 9/16 window along the play axis, so a SHORT hole
       gets a narrow one while the green surround is square - and an earlier version of this
       pruning took 47% and 30% off the frames of Jacks Point's two shortest holes. That is
       lateral ground beside the green, which is exactly where a player who has missed stands.
       Compare the pruned plan against one that keeps every green. */
    const pkg = course(4, 0.0009);  /* short holes - the case that broke */
    const pruned = planCourseCaptures(pkg, { source: SOURCE, maxOutputPx: MAX_OUTPUT_PX, terrainSource: null });
    const holes = [...new Set(pruned.filter(i => i.holeNumber).map(i => i.holeNumber))];
    assert.ok(holes.length >= 4, "fixture must produce short holes");
    holes.forEach(hole => {
      const extent = (plan) => mergeBounds(plan.filter(i => Number(i.holeNumber) === hole && !i.terrainStageOnly)
        .map(i => captureGrid(i, { source: SOURCE })).filter(Boolean).map(g => g.imageBounds));
      /* Everything the unpruned plan would have covered must still be covered. */
      const keptAll = planCourseCaptures(pkg, { terrainSource: null });
      assert.ok(mod.boundsContain(extent(pruned), extent(keptAll)) ||
        JSON.stringify(extent(pruned)) === JSON.stringify(extent(keptAll)),
        `hole ${hole} lost frame extent to pruning`);
    });
  });

  test("green surrounds may sit at z20 only when the frame can show it", () => {
    /* The policy still asks for z20 - the clamp is what decides. A green on a tiny frame gets
       pulled down; the policy itself is unchanged so nothing else has to move. */
    assert.strictEqual(capturePolicy("green-surround").targetZoom, 20);
    assert.strictEqual(capturePolicy("play-corridor").targetZoom, 19);
  });

  let failures = 0;
  for (const item of tests) {
    try { await item.fn(); console.log("  ok  " + item.name); }
    catch (error) { failures++; console.error("  FAIL  " + item.name + "\n        " + (error && error.message || error)); }
  }
  if (failures) { console.error("capture-plan-efficiency FAILED: " + failures + " of " + tests.length); process.exit(1); }
  console.log("capture-plan-efficiency passed: " + tests.length + " checks");
})().catch((error) => { console.error(error); process.exit(1); });
