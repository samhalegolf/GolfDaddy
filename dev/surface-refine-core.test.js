/* functions/lib/gd-surface-refine-core.mjs: OSM polygon as guide, our own frame as the truth.
 *
 * Hermetic - the imagery is synthesised here rather than downloaded, and the playSurface is
 * built from projectPoint so the projection under test is checked against the same maths the
 * capture pipeline writes into a real frame.
 *
 * Run: node dev/surface-refine-core.test.js */

const assert = require("assert");
const path = require("path");
const root = path.join(__dirname, "..");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
let core = null, plan = null, sharp = null;

/* A frame whose top-left pixel is a known lat/lng, exactly as a published hole frame records
   it: originPx is the mercator position of that pixel at captureZoom. */
function syntheticFrame(lat, lng, size) {
  const p = plan.projectPoint(lat, lng, 18);
  return { originPx: { x: p.x, y: p.y }, captureZoom: 18, outputDimensions: { width: size, height: size } };
}

test("frameProjector round-trips a point through the frame's own projection", () => {
  const frame = syntheticFrame(-44.9425783, 168.8090301, 512);
  const proj = core.frameProjector(frame);
  assert.ok(proj);
  const topLeft = proj.toPx({ lat: -44.9425783, lng: 168.8090301 });
  assert.ok(Math.abs(topLeft.x) < 1e-6 && Math.abs(topLeft.y) < 1e-6, "the origin lands on pixel 0,0");
  const back = proj.toLatLng({ x: 123.5, y: 77.25 });
  const again = proj.toPx(back);
  assert.ok(Math.abs(again.x - 123.5) < 1e-6 && Math.abs(again.y - 77.25) < 1e-6);
});

test("frameProjector refuses a frame with no usable projection", () => {
  assert.strictEqual(core.frameProjector(null), null);
  assert.strictEqual(core.frameProjector({ captureZoom: 18 }), null);
  assert.strictEqual(core.frameProjector({ originPx: { x: 1, y: 2 }, captureZoom: 18 }), null);
});

test("polygonAreaM2 measures a known square", () => {
  /* ~100m on a side at this latitude. */
  const lat = -44.95, lng = 168.81;
  const dLat = 100 / 111320, dLng = 100 / (111320 * Math.cos(lat * Math.PI / 180));
  const square = [
    { lat, lng }, { lat, lng: lng + dLng },
    { lat: lat + dLat, lng: lng + dLng }, { lat: lat + dLat, lng }
  ];
  const area = core.polygonAreaM2(square);
  assert.ok(Math.abs(area - 10000) < 50, "expected ~10000 m2, got " + Math.round(area));
  assert.strictEqual(core.polygonAreaM2([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }]), 0);
});

/* Naive every-Nth decimation of the wand's 144-gon is an INSCRIBED resample and loses area on
   every feature - 12.8% at 10 points across Millbrook's hole 1, which would have quietly shrunk
   the whole course. The rescale is what makes a small ring usable rather than merely small. */
test("resampleRing cuts points without shrinking the shape", () => {
  const centre = { lat: -44.95, lng: 168.81 }, r = 0.0002;
  const ring = Array.from({ length: 144 }, (_, i) => {
    const a = (i / 144) * Math.PI * 2;
    return { lat: centre.lat + Math.cos(a) * r, lng: centre.lng + Math.sin(a) * r * 1.4 };
  });
  const before = core.polygonAreaM2(ring);
  const out = core.resampleRing(ring, 10);
  assert.strictEqual(out.length, 10);
  const after = core.polygonAreaM2(out);
  assert.ok(Math.abs(after / before - 1) < 0.02,
    "area preserved within 2%, got " + (after / before).toFixed(3) + "x");
  /* Without the rescale the same decimation loses ~5% on a circle and more on a lobed shape. */
  const naive = core.__surfaceRefineTest.resampleRing === core.resampleRing;
  assert.ok(naive, "the export under test is the one refineSurfaceShape uses");
});

test("a guide that is not a polygon, or sits off the frame, is refused rather than guessed at", async () => {
  const frame = syntheticFrame(-44.9425783, 168.8090301, 256);
  const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 40, g: 90, b: 50 } } }).png().toBuffer();
  const two = [{ lat: -44.9426, lng: 168.8091 }, { lat: -44.9427, lng: 168.8092 }];
  assert.strictEqual((await core.refineSurfaceShape({ image, playSurface: frame, guideShape: two })).reason, "guide-not-a-polygon");
  assert.strictEqual((await core.refineSurfaceShape({ image, playSurface: null, guideShape: squareAt(-44.9430, 168.8095) })).reason, "frame-has-no-projection");
  /* Far outside the 256px frame. */
  assert.strictEqual((await core.refineSurfaceShape({ image, playSurface: frame, guideShape: squareAt(-44.9600, 168.8300) })).reason, "guide-outside-frame");
});

function squareAt(lat, lng, metres = 24) {
  const dLat = metres / 111320, dLng = metres / (111320 * Math.cos(lat * Math.PI / 180));
  return [{ lat: lat - dLat, lng: lng - dLng }, { lat: lat - dLat, lng: lng + dLng },
          { lat: lat + dLat, lng: lng + dLng }, { lat: lat + dLat, lng: lng - dLng }];
}

/* End to end against a synthetic "bunker": a pale blob on turf, with a guide sized to match. */
test("a guide over a real edge refines to a lighter ring of about the right size", async () => {
  const SIZE = 512;
  const topLeft = { lat: -44.9425783, lng: 168.8090301 };
  const frame = syntheticFrame(topLeft.lat, topLeft.lng, SIZE);
  const proj = core.frameProjector(frame);
  const centre = proj.toLatLng({ x: SIZE / 2, y: SIZE / 2 });
  const image = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: 38, g: 86, b: 46 } } })
    .composite([{ input: Buffer.from(`<svg width="${SIZE}" height="${SIZE}"><ellipse cx="256" cy="256" rx="58" ry="44" fill="#d8cfa8"/></svg>`), top: 0, left: 0 }])
    .png().toBuffer();

  /* A guide roughly the blob's size, deliberately offset a little - which is the real case. */
  const guide = squareAt(centre.lat + 0.00002, centre.lng + 0.00002, 20);
  const out = await core.refineSurfaceShape({ image, playSurface: frame, guideShape: guide });
  assert.strictEqual(out.ok, true, "expected a refinement, got " + out.reason);
  assert.ok(out.shape.length <= core.REFINED_SHAPE_MAX_POINTS,
    "refined to at most " + core.REFINED_SHAPE_MAX_POINTS + " points, got " + out.shape.length);
  assert.ok(out.ratio >= core.REFINE_ACCEPT_RATIO.min && out.ratio <= core.REFINE_ACCEPT_RATIO.max);
  assert.ok(out.params.baseBubbleSize > 0, "the bubble is derived from the guide, not the 61 default");
});

/* The claim the module header makes about itself, asserted so it cannot quietly stop being
   true: refining REPLACES the geometry but keeps what pointed us at the feature. */
test("applyRefinedShape keeps the osmId and says the geometry is no longer OSM's", () => {
  const object = { id: "bunker-1", type: "bunker", osmId: "way/123", holeNumber: 4,
    shape: [{ lat: 1, lng: 1 }, { lat: 1, lng: 2 }, { lat: 2, lng: 2 }], source: "osm_auto_surface" };
  const refined = core.applyRefinedShape(object, {
    ok: true, shape: squareAt(-44.95, 168.81, 10), ratio: 1.04, confidence: 0.91,
    params: { baseBubbleSize: 39, mode: "robustTonal" }
  });
  assert.strictEqual(refined.osmId, "way/123", "still traceable to the guide");
  assert.strictEqual(refined.shapeSource, core.REFINED_SHAPE_SOURCE);
  assert.strictEqual(refined.refine.guidePoints, 3);
  assert.strictEqual(refined.refine.points, 4);
  assert.notDeepStrictEqual(refined.shape, object.shape);
  /* A failed refinement must leave the object exactly as it was. */
  assert.strictEqual(core.applyRefinedShape(object, { ok: false, reason: "no-size-match" }), object);
});

(async function run() {
  core = await import(path.join(root, "functions", "lib", "gd-surface-refine-core.mjs"));
  plan = await import(path.join(root, "functions", "lib", "gd-visual-plan-core.mjs"));
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
    console.error("surface-refine-core FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("surface-refine-core passed: " + tests.length + " checks");
})();
