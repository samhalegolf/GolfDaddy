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

test("osmGuideQuery includes the course footprint selectors", () => {
  const query = core.osmGuideQuery({ selector: "(around:1400,-36.8,174.7)" });
  assert.ok(query.includes('"leisure"="golf_course"'));
  assert.ok(query.includes('"golf"="course"'));
});

test("courseFootprintFrame derives a padded bbox from the course polygon, null without one", () => {
  const payload = { elements: [{ type: "way", id: 1, tags: { leisure: "golf_course" }, geometry: [
    { lat: -36.336, lon: 174.769 }, { lat: -36.354, lon: 174.769 }, { lat: -36.354, lon: 174.784 }, { lat: -36.336, lon: 174.784 }
  ] }] };
  const frame = core.courseFootprintFrame(payload);
  assert.ok(frame, "footprint polygon should yield a frame");
  assert.ok(frame.south < -36.354 && frame.north > -36.336, "frame is padded beyond the polygon");
  assert.ok(frame.west < 174.769 && frame.east > 174.784);
  assert.strictEqual(core.courseFootprintFrame({ elements: [] }), null);
});

test("scopeContainsFrame: a long thin course footprint escapes the default 1400m circle", () => {
  const scope = core.osmQueryScope({}, { lat: -36.33609, lng: 174.77174 });
  const omahaLike = { south: -36.3545, west: 174.7690, north: -36.3320, east: 174.7850 };
  assert.strictEqual(core.scopeContainsFrame(scope, omahaLike), false, "southern loop lies outside the circle - must requery");
  const tight = { south: -36.340, west: 174.770, north: -36.333, east: 174.776 };
  assert.strictEqual(core.scopeContainsFrame(scope, tight), true, "a compact course needs no second query");
  const bbox = core.osmQueryScope({ osmFrame: omahaLike });
  assert.strictEqual(core.scopeContainsFrame(bbox, tight), true);
});

test("osmCourseHoleCountTag reads holes=N from the course polygon", () => {
  const payload = { elements: [{ type: "way", tags: { leisure: "golf_course", holes: "18" }, geometry: [] }] };
  assert.strictEqual(core.osmCourseHoleCountTag(payload), 18);
  assert.strictEqual(core.osmCourseHoleCountTag({ elements: [] }), null);
});

test("one green polygon cannot be claimed by two guides - the loser gets an estimated circle", () => {
  /* Omaha Beach regression: hole 5 has no OSM green, its guide ends within 95m of hole 6's
     green, and the old per-guide matching let hole 5 claim it before hole 6's own guide
     re-claimed it via the dedupe - flipping the green to hole 6 and leaving hole 5 with no
     green at all. */
  const green = { id: "way-9", ref: null, center: { lat: -36.8, lng: 174.7 }, span: 30, shape: [
    { lat: -36.8001, lng: 174.6999 }, { lat: -36.8001, lng: 174.7001 }, { lat: -36.7999, lng: 174.7001 }, { lat: -36.7999, lng: 174.6999 }
  ] };
  const guide5 = { hole: 5, points: [{ lat: -36.796, lng: 174.699 }, { lat: -36.7998, lng: 174.6999 }] };
  const guide6 = { hole: 6, points: [{ lat: -36.796, lng: 174.7 }, { lat: -36.80001, lng: 174.70001 }] };
  const result = core.resolveGuidesIntoObjects([guide5, guide6], "omaha-like", [green]);
  assert.ok(result.holes[5], "hole 5 keeps a green record");
  assert.ok(result.holes[6], "hole 6 keeps a green record");
  assert.strictEqual(result.holes[6].greenSource, "osm_auto_green_polygon", "the nearer guide keeps the real polygon");
  assert.strictEqual(result.holes[5].greenSource, "osm_auto_green_estimate", "the loser falls back to a circle at its own guide end");
  assert.strictEqual(result.polygons, 1);
  assert.strictEqual(result.fallbacks, 1);
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
  /* A point plus a pad is a valid box.
 *
 * osmScopeFrame deliberately builds a zero-area frame at the course centre for the
 * radius to inflate. expandOsmFrame used to normalise before padding, and
 * normalizedOsmFrame rejects zero-area boxes - so it answered null for every
 * around-scope, and both widen paths silently did nothing: the long-standing
 * wider-retry and the multi-course widen. Te Arai looked like a query-bounds problem
 * for two scans because of it. */
test("an around-scope can be expanded into a wider frame", () => {
  const centre = { lat: -36.1866611, lng: 174.6594658 };
  const scope = core.osmQueryScope({}, centre);
  assert.strictEqual(scope.radiusM, 1400);

  const frame = core.osmScopeFrame(scope, centre);
  assert.ok(frame, "an around-scope must yield a frame, not null");

  const wider = core.expandOsmFrame(frame, 1833);
  assert.ok(wider, "and that frame must expand");
  const halfHeight = Math.round((wider.north - centre.lat) * 111320);
  assert.ok(halfHeight > 3000, "the wider frame really is wider, got " + halfHeight + "m");

  /* Expanding by nothing cannot rescue a zero-area frame - there is nothing to give. */
  assert.strictEqual(core.expandOsmFrame({ south: 1, north: 1, west: 2, east: 2 }, 0), null);
  assert.strictEqual(core.expandOsmFrame(null, 500), null);
  assert.strictEqual(core.expandOsmFrame({ south: "x", north: 1, west: 2, east: 3 }, 500), null);
});

console.log("automapper-core passed: " + tests.length + " checks");
})();
