/* functions/lib/gd-automapper-core.mjs: direct unit tests against the ported pure
 * query/parse/resolve functions. Uses a saved Overpass response fixture
 * (dev/fixtures/overpass-two-hole-course.json) rather than a live network call, so this test
 * is hermetic and fast - no Overpass dependency, no Supabase dependency. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "overpass-two-hole-course.json"), "utf8"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let core = null;

test("osmQueryScope builds an around-radius selector when no bbox is given", () => {
  const scope = core.osmQueryScope({}, { lat: -36.8, lng: 174.7 });
  assert.strictEqual(scope.mode, "around");
  assert.ok(scope.selector.includes("around:1400,-36.8,174.7"));
});

test("osmQueryScope prefers an explicit bbox frame over a radius", () => {
  const scope = core.osmQueryScope({ osmFrame: { south: -36.81, west: 174.69, north: -36.79, east: 174.71 } });
  assert.strictEqual(scope.mode, "bbox");
  assert.ok(scope.selector.startsWith("("));
});

test("osmGuideQuery includes every golf feature selector", () => {
  const query = core.osmGuideQuery({ selector: "(around:1400,-36.8,174.7)" });
  assert.ok(query.includes('"golf"="hole"'));
  assert.ok(query.includes('"golf"="green"'));
  assert.ok(query.includes('"golf"="fairway"'));
  assert.ok(query.includes("out geom tags;"));
});

test("parseOsmGuideBundle extracts hole guides and green shapes from a fixture payload", () => {
  const bundle = core.parseOsmGuideBundle(fixture);
  assert.strictEqual(bundle.guides.length, 2, "two hole ways in the fixture");
  assert.strictEqual(bundle.guides.find(g => g.hole === 1).points.length, 3);
  assert.strictEqual(bundle.greens.length, 1, "one green polygon, for hole 1");
  assert.strictEqual(bundle.greens[0].ref, 1);
});

test("bestOsmGreenForGuide matches the hole-1 guide to the hole-1 green within range", () => {
  const bundle = core.parseOsmGuideBundle(fixture);
  const guide1 = bundle.guides.find(g => g.hole === 1);
  const match = core.bestOsmGreenForGuide(guide1, bundle.greens);
  assert.ok(match, "a green should be matched within OSM_AUTO_GREEN_MATCH_RADIUS_M");
  assert.strictEqual(match.endpointIndex, 1, "the green sits at the far end of the guide, not the tee end");
});

test("resolveCourseGeometry produces objects and holes for both fixture holes", () => {
  const result = core.resolveCourseGeometry(fixture, "pupuke", { lat: -36.8, lng: 174.702 });
  assert.strictEqual(result.holesResolved, 2);
  assert.strictEqual(Object.keys(result.holes).length, 2, "both holes get a confirmed green record");
  const objects = Object.values(result.objects);
  const greens = objects.filter(o => o.type === "green");
  const tees = objects.filter(o => o.type === "tee");
  assert.strictEqual(greens.length, 2);
  assert.strictEqual(tees.length, 2);
  assert.ok(objects.every(o => o.courseId === "pupuke"));
  const hole1Green = greens.find(g => g.holeNumber === 1);
  assert.strictEqual(hole1Green.source, "osm_auto_green_polygon", "hole 1 has a real OSM green polygon");
  const hole2Green = greens.find(g => g.holeNumber === 2);
  assert.strictEqual(hole2Green.source, "osm_auto_green_estimate", "hole 2 falls back to an estimated circle - no green way for ref=2");
});

test("resolveCourseGeometry is idempotent - running it twice does not duplicate objects", () => {
  const first = core.resolveCourseGeometry(fixture, "pupuke", { lat: -36.8, lng: 174.702 });
  const second = core.resolveCourseGeometry(fixture, "pupuke", { lat: -36.8, lng: 174.702 });
  assert.strictEqual(Object.keys(first.objects).length, Object.keys(second.objects).length);
});

test("dedupeCourseObjects-style matching: nearestMatchingObject finds an object within its type's radius", () => {
  const objects = [{ id: "green-1", type: "green", position: { lat: -36.8012, lng: 174.7020 } }];
  const match = core.nearestMatchingObject(objects, "green", { lat: -36.8012, lng: 174.70201 });
  assert.strictEqual(match.id, "green-1");
  const noMatch = core.nearestMatchingObject(objects, "green", { lat: -36.9, lng: 174.9 });
  assert.strictEqual(noMatch, null);
});

test("courseMatchesIdentity matches on courseId first, then normalised name", () => {
  const course = { courseId: "pupuke-golf-club", courseName: "Pupuke Golf Club" };
  assert.ok(core.courseMatchesIdentity(course, "pupuke-golf-club", ""));
  assert.ok(core.courseMatchesIdentity(course, "", "Pupuke Golf Club"));
  assert.ok(!core.courseMatchesIdentity(course, "different-course", "Different Course"));
});

test("chooseAutoMapGuides picks the longer guide when two candidates for the same hole tie on distance", () => {
  const guides = [
    { hole: 1, points: [{ lat: -36.80, lng: 174.70 }, { lat: -36.8001, lng: 174.7001 }] },
    { hole: 1, points: [{ lat: -36.80, lng: 174.70 }, { lat: -36.8005, lng: 174.7005 }] }
  ];
  const chosen = core.chooseAutoMapGuides(guides, { lat: -36.80, lng: 174.70 });
  assert.strictEqual(chosen.length, 1);
  assert.strictEqual(core.guideLength(chosen[0].points) > 0, true);
});

(async function run() {
  core = await import(path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  let failures = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log("  ok  " + item.name);
    } catch (error) {
      failures += 1;
      console.error("  FAIL  " + item.name + "\n        " + (error && error.message || error));
    }
  }
  if (failures) {
    console.error("automapper-core FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("automapper-core passed: " + tests.length + " checks");
})();
