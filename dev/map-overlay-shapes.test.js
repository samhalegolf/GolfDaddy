/* scripts/studio/courses/map-overlay/map-overlay-shapes.js: the shapes the Mapping Overlay
 * places by eye - a fairway around a laid line, a tee box, a default round green, and two
 * overlapping bunkers merged into one.
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

test("a tee box is the tee's size, its long side facing the green", () => {
  const tee = shapes.teeAt(at(0, 0), at(0, 300));
  assert.strictEqual(tee.length, 4);
  assert.ok(Math.abs(area(tee) - shapes.TEE_LENGTH_M * shapes.TEE_WIDTH_M) < 1, "tee area " + area(tee));
  const ys = tee.map(p => (p.lat - LAT) / mLat);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - shapes.TEE_LENGTH_M) < 0.5, "the long side should run towards the green");
});

test("two overlapping bunkers merge into one outline covering both", () => {
  const a = shapes.circle(at(0, 0), 6, 16), b = shapes.circle(at(8, 0), 6, 16);
  const merged = shapes.mergeOverlapping(a, b);
  assert.ok(merged && merged.length >= 3 && merged.length <= shapes.MAX_POINTS, "got " + (merged && merged.length));
  /* Two r=6 discs 8m apart cover ~201m2; the 16-gons a little less. */
  assert.ok(area(merged) > 190 && area(merged) < 205, "merged area " + area(merged).toFixed(1));
  const xs = merged.map(p => (p.lng - LNG) / mLng);
  assert.ok(Math.min(...xs) < -5.5 && Math.max(...xs) > 13.5, "the outline must reach both ends");
});

test("bunkers that do not overlap are not merged", () => {
  assert.strictEqual(shapes.mergeOverlapping(shapes.circle(at(0, 0), 6), shapes.circle(at(20, 0), 6)), null);
});

test("a bunker inside another merges to the bigger one", () => {
  const merged = shapes.mergeOverlapping(shapes.circle(at(0, 0), 10, 16), shapes.circle(at(1, 0), 3, 16));
  assert.ok(Math.abs(area(merged) - area(shapes.circle(at(0, 0), 10, 16))) < 8, "area " + area(merged).toFixed(1));
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
