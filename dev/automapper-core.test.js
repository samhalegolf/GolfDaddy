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
let plan = null;

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

/* Nothing bounded a green's stored outline server-side before - only the client decimated,
   so a densely traced green went into course_maps at whatever resolution OSM drew it. */
test("a densely traced green is capped without disturbing an ordinary one", () => {
  const centre = { lat: -36.8, lng: 174.7 };
  const dense = Array.from({ length: 300 }, (_, i) => {
    const a = (i / 300) * Math.PI * 2;
    return { lat: centre.lat + Math.cos(a) * 0.0002, lng: centre.lng + Math.sin(a) * 0.0002 };
  });
  const guide = { hole: 1, points: [{ lat: -36.803, lng: 174.7 }, centre] };
  const green = { id: "g", center: centre, shape: dense, span: 44 };
  const resolved = core.resolveGuidesIntoObjects([guide], "dense", [green]);
  const stored = Object.values(resolved.objects).find(o => o.type === "green");
  assert.ok(stored.shape.length <= core.GREEN_SHAPE_MAX_POINTS,
    "capped at " + core.GREEN_SHAPE_MAX_POINTS + ", got " + stored.shape.length);
  /* Surfaces are capped far harder, because each one is cloned per corridor and greens are
     load-bearing geometry that yardages read. */
  assert.ok(core.SURFACE_SHAPE_MAX_POINTS < core.GREEN_SHAPE_MAX_POINTS);
  /* An ordinary green (Millbrook's run 14-25 points) passes through untouched. */
  const plain = dense.filter((_, i) => i % 15 === 0);
  const ok = core.resolveGuidesIntoObjects([guide], "plain", [{ id: "g2", center: centre, shape: plain, span: 44 }]);
  assert.strictEqual(Object.values(ok.objects).find(o => o.type === "green").shape.length, plain.length);
});

/* ---------- OSM course surfaces --------------------------------------------------------- */

/* A synthetic course rather than the saved fixture: these tests are about which hole a surface
   lands on, and that needs holes at known distances from a bunker placed at a known point. */
const SLAT = 36.0, SLNG = 174.0;
const sPoint = (east, north) => ({
  lat: SLAT + north / 111320,
  lng: SLNG + east / (111320 * Math.cos(SLAT * Math.PI / 180))
});
const sRing = (east, north, r) => [sPoint(east - r, north - r), sPoint(east + r, north - r), sPoint(east + r, north + r), sPoint(east - r, north + r)];
/* Two parallel holes, 80m apart, playing in opposite directions - the layout the plan warned
   nearest-hole assignment gets wrong. */
function surfaceFixture(extra = []) {
  return { elements: [
    { type: "way", id: 1, tags: { golf: "hole", ref: "1" }, geometry: [sPoint(0, 0), sPoint(270, 0)] },
    { type: "way", id: 2, tags: { golf: "green" }, geometry: sRing(270, 0, 12) },
    { type: "way", id: 11, tags: { golf: "hole", ref: "2" }, geometry: [sPoint(270, 80), sPoint(0, 80)] },
    { type: "way", id: 12, tags: { golf: "green" }, geometry: sRing(0, 80, 12) },
    ...extra
  ] };
}
const resolveFixture = (extra = [], existing = []) =>
  core.resolveCourseGeometry(surfaceFixture(extra), "surf", { lat: SLAT, lng: SLNG }, existing, []);

test("parseOsmSurfaces normalises the V1 tags and keeps penalty areas apart from plain water", () => {
  const surfaces = core.parseOsmSurfaces(surfaceFixture([
    { type: "way", id: 20, tags: { golf: "fairway" }, geometry: sRing(140, 0, 40) },
    { type: "way", id: 21, tags: { golf: "bunker" }, geometry: sRing(250, 20, 7) },
    { type: "way", id: 22, tags: { golf: "lateral_water_hazard" }, geometry: sRing(150, 40, 25) },
    { type: "way", id: 23, tags: { natural: "water" }, geometry: sRing(120, 55, 22) }
  ]));
  const byType = t => surfaces.filter(s => s.type === t);
  assert.strictEqual(byType("fairway_area").length, 1);
  assert.strictEqual(byType("bunker").length, 1);
  assert.strictEqual(byType("water").length, 2);
  /* OSM said "hazard" for one and only "water" for the other. Caddy draws both and asserts a
     Rules-of-Golf status for neither beyond what the tagging actually claims. */
  assert.deepStrictEqual(byType("water").map(s => s.hazardClass).sort(), ["penalty_area", "water"]);
  /* greens, tees, hole lines and the course outline are not surfaces. */
  assert.strictEqual(surfaces.some(s => s.osmId === "way/2"), false);
});

test("a surface between two holes is cloned onto both rather than assigned to one", () => {
  const result = resolveFixture([{ type: "way", id: 30, tags: { golf: "bunker" }, geometry: sRing(140, 40, 8) }]);
  const bunkers = Object.values(result.objects).filter(o => o.type === "bunker");
  assert.deepStrictEqual(bunkers.map(b => b.holeNumber).sort(), [1, 2]);
  /* Two records, one physical bunker - traceable through the shared OSM id. */
  assert.deepStrictEqual([...new Set(bunkers.map(b => b.osmId))], ["way/30"]);
  assert.deepStrictEqual([...new Set(bunkers.map(b => b.source))], ["osm_auto_surface"]);
});

/* The dedupe that makes cloning possible. Both clones sit at identical coordinates, so a
   position-only match would find the first and rewrite its holeNumber - leaving one record on
   hole 2 and nothing on hole 1. */
test("clones at identical coordinates do not overwrite each other", () => {
  const objects = [];
  const near = { lat: SLAT, lng: SLNG };
  assert.ok(core.nearestMatchingObject([{ type: "bunker", position: near, holeNumber: 1 }], "bunker", near, 14, 1));
  assert.strictEqual(core.nearestMatchingObject([{ type: "bunker", position: near, holeNumber: 1 }], "bunker", near, 14, 2), null);
  /* Unscoped (tee/green) behaviour is untouched. */
  assert.ok(core.nearestMatchingObject([{ type: "tee", position: near, holeNumber: 1 }], "tee", near, 9));
  assert.strictEqual(objects.length, 0);
});

test("a hand-placed bunker suppresses the OSM one rather than being overwritten by it", () => {
  const manual = [{
    id: "bunker-manual-1", courseId: "surf", type: "bunker", position: sPoint(140, 40),
    shape: sRing(140, 40, 8), holeNumber: null, confirmed: true, source: "gps_tools_drawer"
  }];
  const result = resolveFixture([{ type: "way", id: 30, tags: { golf: "bunker" }, geometry: sRing(140, 40, 8) }], manual);
  const bunkers = Object.values(result.objects).filter(o => o.type === "bunker");
  assert.strictEqual(bunkers.length, 1, "the OSM clones are suppressed, not merged on top of the pin");
  assert.strictEqual(bunkers[0].source, "gps_tools_drawer");
  assert.strictEqual(bunkers[0].holeNumber, null, "and the pin keeps its own hole association");
});

test("a course with no surface tags in OSM still resolves every hole", () => {
  const bare = resolveFixture();
  assert.strictEqual(bare.holesResolved, 2);
  assert.deepStrictEqual(Object.keys(bare.holes).sort(), ["1", "2"]);
  assert.deepStrictEqual(bare.surfaces, { surfaces: 0, cloned: 0 });
  /* Enrichment is enrichment: absence must never make a valid course unusable. */
  assert.strictEqual(Object.values(bare.objects).some(o => core.SURFACE_TYPES.has(o.type)), false);
});

test("surfaces outside a hole's capture corridor are not written onto it", () => {
  const result = resolveFixture([{ type: "way", id: 31, tags: { golf: "bunker" }, geometry: sRing(250, 900, 7) }]);
  assert.strictEqual(Object.values(result.objects).some(o => o.type === "bunker"), false);
});

test("a multipolygon relation contributes one surface per outer ring, not one flattened blob", () => {
  const surfaces = core.parseOsmSurfaces({ elements: [{
    type: "relation", id: 40, tags: { golf: "fairway" },
    members: [
      { type: "way", role: "outer", geometry: sRing(100, 0, 30) },
      { type: "way", role: "outer", geometry: sRing(200, 0, 30) },
      { type: "way", role: "inner", geometry: sRing(100, 0, 5) }
    ]
  }] });
  assert.strictEqual(surfaces.length, 2, "two outer rings, and the inner ring is not a surface");
  assert.deepStrictEqual(surfaces.map(s => s.osmId), ["relation/40", "relation/40#1"]);
  /* Flattening both rings into one point list would have put the centroid between them. */
  surfaces.forEach(s => assert.ok(s.span < 120, "each ring keeps its own extent, got " + Math.round(s.span)));
});

test("grossly mis-tagged geometry is rejected without over-cleaning good geometry", () => {
  const surfaces = core.parseOsmSurfaces({ elements: [
    { type: "way", id: 50, tags: { golf: "bunker" }, geometry: sRing(0, 0, 300) },   // a 600m "bunker"
    { type: "way", id: 51, tags: { golf: "fairway" }, geometry: sRing(0, 0, 5) },    // a 10m "fairway"
    { type: "way", id: 52, tags: { golf: "bunker" }, geometry: sRing(0, 0, 9) }      // an ordinary bunker
  ] });
  assert.deepStrictEqual(surfaces.map(s => s.osmId), ["way/52"]);
});

test("stored surface polygons are simplified so cloning cannot multiply an OSM lake ring", () => {
  const dense = Array.from({ length: 400 }, (_, i) => {
    const a = (i / 400) * Math.PI * 2;
    return sPoint(140 + Math.cos(a) * 30, 40 + Math.sin(a) * 30);
  });
  const result = resolveFixture([{ type: "way", id: 60, tags: { golf: "water_hazard" }, geometry: dense }]);
  const water = Object.values(result.objects).filter(o => o.type === "water");
  assert.ok(water.length >= 1);
  water.forEach(w => assert.ok(w.shape.length <= core.SURFACE_SHAPE_MAX_POINTS,
    "stored ring capped at " + core.SURFACE_SHAPE_MAX_POINTS + ", got " + w.shape.length));
});

/* The reason surfaces are typed fairway_area/bunker/water rather than reusing "fairway".
   packageHoleData matches on tee/green/fairway; a polygon stored as "fairway" would push its
   centroid into the hole's route, into corridorBounds, and shift every capture frame. */
test("surface enrichment does not move a single capture frame", () => {
  const withSurfaces = resolveFixture([
    { type: "way", id: 70, tags: { golf: "fairway" }, geometry: sRing(140, 0, 40) },
    { type: "way", id: 71, tags: { golf: "bunker" }, geometry: sRing(250, 20, 7) },
    { type: "way", id: 72, tags: { golf: "water_hazard" }, geometry: sRing(150, 40, 25) }
  ]);
  assert.ok(withSurfaces.surfaces.cloned > 0, "the fixture really did enrich something");
  const bare = Object.fromEntries(Object.entries(withSurfaces.objects).filter(([, o]) => !core.SURFACE_TYPES.has(o.type)));
  const framesFor = objects => JSON.stringify(
    plan.planCourseCaptures({ courseId: "surf", objects, holes: withSurfaces.holes }, { terrainSource: null })
      .map(item => [item.role, item.holeNumber, item.bounds]));
  assert.strictEqual(framesFor(withSurfaces.objects), framesFor(bare));
});

(async function run() {
  core = await import(path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  plan = await import(path.join(root, "functions", "lib", "gd-visual-plan-core.mjs"));
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
