/* "What golf courses are near this point?" — the picker's second step.
 *
 * The case that defines the feature is St Andrews Links: eight courses over
 * four clubhouses, of which only two carry "St Andrews" in the name. A search
 * for "st andrews" that returns four of eight looks like it worked, which is
 * why the query term must not reach this half at all.
 *
 * Distances below are real: the Castle Course sits ~1.6km from the Old Course
 * and Craigtoun ~4km, which is what sets the radius. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CORE = path.join(ROOT, "functions", "lib", "gd-courses-near-core.mjs");
const PICKER = path.join(ROOT, "scripts", "inline", "gd-course-picker-search-v2.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* Overpass returns `out tags center`, so a footprint is tags plus a centre. */
function course(id, name, lat, lng, type) {
  return { type: type || "way", id, tags: { name, leisure: "golf_course" }, center: { lat, lon: lng } };
}

const OLD = { lat: 56.3475, lng: -2.8100 };

test("the radius reaches Craigtoun, the furthest St Andrews course", async () => {
  const { COURSES_NEAR_RADIUS_M, coursesFromOverpass } = await import(CORE);
  /* ~4km south-west of the Old Course. If the radius were tightened to a
     conventional 2-3km this course silently vanishes from the list. */
  const craigtoun = coursesFromOverpass({ elements: [course(1, "Craigtoun Course", 56.3200, -2.8500)] }, OLD)[0];
  assert.ok(craigtoun.distanceM > 3000, "expected a real separation, got " + craigtoun.distanceM);
  assert.ok(craigtoun.distanceM < COURSES_NEAR_RADIUS_M,
    "Craigtoun at " + craigtoun.distanceM + "m must fall inside the " + COURSES_NEAR_RADIUS_M + "m radius");
});

test("the query asks for golf courses, never for the search term", async () => {
  const { nearbyCoursesQuery } = await import(CORE);
  const q = nearbyCoursesQuery(OLD.lat, OLD.lng, 5200);
  assert.ok(/leisure"="golf_course/.test(q), "must match the tag most mappers use");
  assert.ok(/golf"="course/.test(q), "must also match the golf schema's own tag");
  assert.ok(/around:5200/.test(q), "radius must reach the query");
  /* The whole mechanism. Craigtoun, Balgove, Jubilee and Eden are not called
     "St Andrews" anything, so a query carrying the term returns half the list
     and looks like it worked. */
  assert.ok(!/andrews/i.test(nearbyCoursesQuery(OLD.lat, OLD.lng, 5200)),
    "the search term must not appear in the nearby query");
  assert.ok(/out tags center/.test(q), "geometry would be megabytes for a name and a point");
});

test("one course tagged as both a way and a relation is one row", async () => {
  const { coursesFromOverpass } = await import(CORE);
  const found = coursesFromOverpass({ elements: [
    course(1, "The Old Course", OLD.lat, OLD.lng, "way"),
    course(2, "The Old Course", OLD.lat, OLD.lng, "relation")
  ] }, OLD);
  assert.strictEqual(found.length, 1, "OSM tags courses both ways; the picker must not show two");
  assert.strictEqual(found[0].osmType, "relation", "the relation describes the whole course");
});

test("an unnamed footprint is dropped rather than shown as 'Course'", async () => {
  const { coursesFromOverpass } = await import(CORE);
  const found = coursesFromOverpass({ elements: [
    { type: "way", id: 9, tags: { leisure: "golf_course" }, center: { lat: OLD.lat, lon: OLD.lng } },
    course(1, "Jubilee Course", 56.3430, -2.8000)
  ] }, OLD);
  assert.deepStrictEqual(found.map((c) => c.name), ["Jubilee Course"]);
});

test("a course we already hold a map for wins over its OSM copy", async () => {
  const { mergeWithLibrary, coursesFromOverpass } = await import(CORE);
  /* Same course, different centre and different wording - a course_maps pin is
     a clubhouse or a first tee, an OSM centre is a polygon centroid. */
  const osm = coursesFromOverpass({ elements: [course(1, "The Old Course", 56.3480, -2.8115)] }, OLD);
  const merged = mergeWithLibrary(osm, [
    { course_id: "old", course_name: "Old Course", course_lat: OLD.lat, course_lng: OLD.lng, hole_count: 18 }
  ], OLD);
  assert.strictEqual(merged.length, 1, "one course must not appear twice, once playable and once not");
  assert.strictEqual(merged[0].courseId, "old");
  assert.strictEqual(merged[0].hasMap, true);
});

test("unmapped neighbours still come back, nearest first", async () => {
  const { mergeWithLibrary, coursesFromOverpass } = await import(CORE);
  const osm = coursesFromOverpass({ elements: [
    course(1, "Craigtoun Course", 56.3200, -2.8500),
    course(2, "Jubilee Course", 56.3430, -2.8000),
    course(3, "Castle Course", 56.3330, -2.7770)
  ] }, OLD);
  const merged = mergeWithLibrary(osm, [], OLD);
  assert.deepStrictEqual(merged.map((c) => c.name), ["Jubilee Course", "Castle Course", "Craigtoun Course"]);
  assert.ok(merged.every((c) => c.hasMap === false && c.courseId === null),
    "nothing unmapped may claim to be playable");
});

/* ---- the client half: which place did you mean? ---- */

/* Brace-matched rather than a fixed span: these functions carry long comments
   and a slice cut mid-token fails as a syntax error that looks like a real
   regression. */
function pickerFn(signature) {
  const src = require("fs").readFileSync(PICKER, "utf8");
  const idx = src.indexOf(signature);
  assert.notStrictEqual(idx, -1, "could not find: " + signature);
  let depth = 0, started = false;
  for (let i = idx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error("unbalanced braces after: " + signature);
}

/* clusterAreas leans on finitePoint/placeLabel/metresBetween from the picker's
   own scope. Everything except placeLabel is pulled from the real source rather
   than stubbed - a hand-written finitePoint stub treated a null coordinate as
   0,0 and clustered a placeless result at Null Island, which is exactly the bug
   the real one already guards against. Only placeLabel is faked, and only
   because the real one reaches for module state. */
function loadClusterAreas() {
  const source = [
    pickerFn("function clusterAreas(courses){"),
    pickerFn("function metresBetween(a,b){"),
    pickerFn("function finitePoint(point){")
  ].join("\n");
  return new Function("placeLabel", "AREA_M", source + "\nreturn clusterAreas;")(
    (c) => [c && c.region, c && c.country].filter(Boolean).join(", "),
    25000
  );
}

test("St Andrews Scotland and St Andrews Iowa are two places to choose", () => {
  const clusterAreas = loadClusterAreas();
  const areas = clusterAreas([
    { name: "The Old Course", lat: 56.3475, lng: -2.8100, region: "Fife", country: "United Kingdom" },
    { name: "Jubilee Course", lat: 56.3430, lng: -2.8000, region: "Fife", country: "United Kingdom" },
    { name: "Castle Course", lat: 56.3330, lng: -2.7770, region: "Fife", country: "United Kingdom" },
    { name: "Saint Andrews Golf Course", lat: 42.0390, lng: -91.6635, region: "Iowa", country: "United States" }
  ]);
  assert.strictEqual(areas.length, 2, "three Scottish results are one place, not three");
  assert.strictEqual(areas[0].label, "Fife, United Kingdom");
  assert.strictEqual(areas[0].count, 3);
  assert.strictEqual(areas[1].label, "Iowa, United States");
});

test("one place asks no question", () => {
  const clusterAreas = loadClusterAreas();
  const areas = clusterAreas([
    { name: "Boulcott's Farm Heritage Golf Club", lat: -41.2100, lng: 174.9200, region: "Wellington", country: "New Zealand" }
  ]);
  assert.strictEqual(areas.length, 1, "a single match must not put a chooser in the way");
});

test("two clubs of the same name in one country stay separate", () => {
  const clusterAreas = loadClusterAreas();
  /* The NZ case, and the reason grouping is by distance rather than by country:
     Auckland and Christchurch would collapse into one "New Zealand" row. */
  const areas = clusterAreas([
    { name: "St Andrews Golf Club", lat: -36.8485, lng: 174.7633, region: "Auckland", country: "New Zealand" },
    { name: "St Andrews Golf Club", lat: -43.5321, lng: 172.6362, region: "Canterbury", country: "New Zealand" }
  ]);
  assert.strictEqual(areas.length, 2);
});

test("a result with no coordinates cannot place itself and is left alone", () => {
  const clusterAreas = loadClusterAreas();
  const areas = clusterAreas([
    { name: "Somewhere", lat: null, lng: null, country: "United Kingdom" },
    { name: "The Old Course", lat: 56.3475, lng: -2.8100, region: "Fife", country: "United Kingdom" }
  ]);
  assert.strictEqual(areas.length, 1, "an unplaceable result must not become its own area");
});

test("the picker never renders a parent, only a distance", () => {
  const src = require("fs").readFileSync(PICKER, "utf8");
  const rows = pickerFn("function nearbyPayloads(list,area){");
  assert.ok(!/facility|parent|belongsTo|clubId/i.test(rows),
    "proximity is a fact we measured; ownership would be a claim we invented");
  assert.ok(/distanceM/.test(src), "the meta line must still carry distance");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed++; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("courses-near failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("courses-near passed: " + tests.length + " checks");
})();
