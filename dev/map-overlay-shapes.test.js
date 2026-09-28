/* scripts/studio/courses/map-overlay/map-overlay-shapes.js: the shapes the Mapping Overlay
 * places by eye - a fairway around a laid line, a tee behind it, a default round green.
 *
 * Run: node dev/map-overlay-shapes.test.js */
const assert = require("assert");
const path = require("path");
const shapes = require(path.join(__dirname, "..", "scripts", "studio", "courses", "map-overlay", "map-overlay-shapes.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const LAT = 54.62, LNG = -5.85;
const mLat = 1 / 111320, mLng = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
/* A point dx metres east and dy metres north of the origin. */
function at(dx, dy) { return { lat: LAT + dy * mLat, lng: LNG + dx * mLng }; }
function area(ring) {
  let a = 0;
  const pts = ring.map(p => ({ x: (p.lng - LNG) / mLng, y: (p.lat - LAT) / mLat }));
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  return Math.abs(a / 2);
}

test("a straight 300m line becomes a fairway about the chosen width, with corners to drag", () => {
  const ring = shapes.fairwayFromLine([at(0, 0), at(0, 300)], 35);
  assert.ok(ring && ring.length >= 20 && ring.length <= 42, "expected a ring with a corner every ~30m, got " + (ring && ring.length));
  assert.ok(ring.length <= shapes.MAX_POINTS, "must fit the overlay's point cap");
  const a = area(ring);
  assert.ok(a > 300 * 35 * 0.95 && a < 300 * 35 * 1.15, "area " + Math.round(a) + " is not ~" + 300 * 35);
  const xs = ring.map(p => (p.lng - LNG) / mLng);
  assert.ok(Math.abs(Math.max(...xs) - 17.5) < 0.5 && Math.abs(Math.min(...xs) + 17.5) < 0.5, "sides sit half the width out");
});

test("a long dogleg still fits under the point cap", () => {
  const ring = shapes.fairwayFromLine([at(0, 0), at(0, 350), at(250, 550)], 40);
  assert.ok(ring.length <= shapes.MAX_POINTS, "got " + ring.length);
  assert.ok(ring.length >= 30 && ring.length <= 42, "got " + ring.length);
});

test("too short a line, or one point, makes no fairway", () => {
  assert.strictEqual(shapes.fairwayFromLine([at(0, 0)], 35), null);
  assert.strictEqual(shapes.fairwayFromLine([at(0, 0), at(0, 2)], 35), null);
});

test("the tee lands about 20m behind the start of the line, facing down it", () => {
  const tee = shapes.teeBeyondLine([at(0, 0), at(0, 300)], []);
  assert.strictEqual(tee.length, 4);
  const c = shapes.centroid(tee);
  const dy = (c.lat - LAT) / mLat, dx = (c.lng - LNG) / mLng;
  assert.ok(Math.abs(dy + shapes.TEE_BEYOND_M) < 0.5 && Math.abs(dx) < 0.5, "tee centre at " + dx.toFixed(1) + "," + dy.toFixed(1));
  const a = area(tee);
  assert.ok(Math.abs(a - shapes.TEE_LENGTH_M * shapes.TEE_WIDTH_M) < 1, "tee area " + a);
});

test("a line laid green-to-tee is flipped when a green sits by its start", () => {
  const green = shapes.circle(at(0, -10), 14);
  const tee = shapes.teeBeyondLine([at(0, 0), at(0, 300)], [green]);
  const dy = (shapes.centroid(tee).lat - LAT) / mLat;
  assert.ok(Math.abs(dy - (300 + shapes.TEE_BEYOND_M)) < 0.5, "tee should sit beyond the far end, got " + dy.toFixed(1));
});

test("a default green is a round ring of the requested size", () => {
  const ring = shapes.circle(at(0, 0), 14, 16);
  assert.strictEqual(ring.length, 16);
  const a = area(ring);
  assert.ok(a > Math.PI * 14 * 14 * 0.95 && a < Math.PI * 14 * 14, "area " + a);
});

let failed = 0;
tests.forEach(t => {
  try { t.fn(); console.log("  ok  " + t.name); }
  catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.message)); }
});
console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " map overlay shape checks");
process.exit(failed ? 1 : 0);
