/* Rescan of 2026-10-01, three findings:
 *
 *   Fancourt Golf Estate published George Golf Club as its "Course 3". The loops came from
 *   routing, and only containment knew how to set a neighbouring club aside.
 *   Te Arai's North course got the id te-rai-te-arai-links-golf-club-north - the facility's
 *   name spelt out inside its own facility's id.
 *   A facility had no name of its own: the picker guessed its parent row's label from the
 *   words the course names share, which for 황학 / 세종 / 여강 is nothing.
 *
 * Run: node dev/facility-parent-and-neighbours.test.js */

const assert = require("assert");
const path = require("path");
const { replaySophiaGreen, fixture } = require("./lib/sophia-green-replay.js");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* An 18 laid out as one walk: each hole's tee 60m on from the last green. */
function course(idBase, origin) {
  const elements = [];
  let at = { lat: origin.lat, lng: origin.lng };
  for (let n = 1; n <= 18; n++) {
    const start = at;
    const end = { lat: start.lat + 0.0025, lng: start.lng + (n % 2 ? 0.0006 : -0.0006) };
    elements.push({ type: "way", id: idBase + n, tags: { golf: "hole", ref: String(n) }, geometry: [start, end] });
    at = { lat: end.lat - 0.0021, lng: end.lng + 0.0007 };
  }
  return elements;
}

function ring(origin, spanLat, spanLng, tags, id) {
  const pts = [
    { lat: origin.lat - 0.002, lng: origin.lng - 0.002 },
    { lat: origin.lat + spanLat, lng: origin.lng - 0.002 },
    { lat: origin.lat + spanLat, lng: origin.lng + spanLng },
    { lat: origin.lat - 0.002, lng: origin.lng + spanLng },
    { lat: origin.lat - 0.002, lng: origin.lng - 0.002 }
  ];
  return { type: "way", id, tags, geometry: pts };
}

const WEST = { lat: -33.970, lng: 22.405 };
const EAST = { lat: -33.972, lng: 22.425 };
const GEORGE = { lat: -33.960, lng: 22.445 };

test("a neighbouring club is set aside when OSM has drawn no outline around the facility itself", async () => {
  const core = await import("file://" + path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  const payload = { elements: course(1000, WEST).concat(course(2000, EAST), course(3000, GEORGE), [
    ring(GEORGE, 0.008, 0.016, { leisure: "golf_course", name: "George Golf Club" }, 47154781)
  ]) };
  const loops = core.separateLoops(payload, WEST, { facilityName: "Fancourt Golf Estate" });
  assert.ok(loops, "the site still separates");
  assert.strictEqual(loops.length, 2, "Fancourt's two 18s, not George as a third: " + JSON.stringify(loops.map(l => l.awayFromPinM)));
  assert.strictEqual(loops.excluded.length, 1);
  assert.strictEqual(loops.excluded[0].name, "George Golf Club");
  assert.strictEqual(loops.excluded[0].reason, "course-outline-names-another-club");
});

test("a resort course outlined under its own name is kept", async () => {
  const core = await import("file://" + path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  const payload = { elements: course(1000, WEST).concat(course(2000, EAST), course(3000, GEORGE), [
    ring(EAST, 0.008, 0.016, { golf: "course", name: "Coronet 18" }, 9002),
    ring(GEORGE, 0.008, 0.016, { golf: "course", name: "The Hills" }, 9003)
  ]) };
  const loops = core.separateLoops(payload, WEST, { facilityName: "Millbrook Golf Resort" });
  assert.strictEqual(loops.length, 3, "no club designator, no exclusion - losing a real course is the worse mistake");
  assert.deepStrictEqual(loops.excluded, []);
});

test("a club that shares the facility's distinctive name is kept", async () => {
  const core = await import("file://" + path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  const payload = { elements: course(1000, WEST).concat(course(2000, GEORGE), [
    ring(GEORGE, 0.008, 0.016, { leisure: "golf_course", name: "Fancourt Country Club" }, 1)
  ]) };
  const loops = core.separateLoops(payload, WEST, { facilityName: "Fancourt Golf Estate" });
  assert.strictEqual(loops.length, 2);
});

test("an outline run by a different website is another club, whatever it is called", async () => {
  const core = await import("file://" + path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  const payload = { elements: course(1000, WEST).concat(course(2000, EAST), course(3000, GEORGE), [
    ring(WEST, 0.008, 0.016, { leisure: "golf_course", name: "Stadium", website: "https://www.tpc.com/sawgrass" }, 1),
    ring(EAST, 0.008, 0.016, { leisure: "golf_course", name: "Valley", website: "https://tpc.com/sawgrass/valley" }, 2),
    ring(GEORGE, 0.008, 0.016, { leisure: "golf_course", name: "Sawgrass East", website: "https://sawgrasscountryclub.com" }, 3)
  ]) };
  const loops = core.separateLoops(payload, WEST, { facilityName: "TPC Sawgrass" });
  assert.strictEqual(loops.length, 2, "same owner stays, different owner goes");
  assert.strictEqual(loops.excluded[0].reason, "course-outline-run-by-another-owner");
});

test("every course out of one scan carries the facility's name as its parent", async () => {
  const { maps } = await replaySophiaGreen();
  assert.strictEqual(maps.size, 3);
  maps.forEach(row => assert.strictEqual(row.facility_name, fixture.courseName, row.course_id));
});

test("the parent name, once set, survives the pinned course being renamed after one of its courses", async () => {
  const { maps } = await replaySophiaGreen({ pinned: { course_name: "황학(黃鶴)코스", facility_name: "Sophia Green Country Club" } });
  maps.forEach(row => assert.strictEqual(row.facility_name, "Sophia Green Country Club", row.course_id));
});

test("a sibling's id is the facility's id and the course's own part of its name", async () => {
  const worker = await import("file://" + path.join(root, "functions", "course-mapper-worker-background.mjs"));
  const id = worker.__courseMapperWorkerTest.loopCourseId(
    { name: "Te Arai Links Golf Club - North Course", nameSource: "osm-polygon" },
    { courseId: "te-rai", courseName: "Te Arai Links Golf Club" }, 1, new Set(["te-rai"]));
  assert.strictEqual(id, "te-rai-north");
});

(async function run() {
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
    console.error("facility-parent-and-neighbours FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("facility-parent-and-neighbours passed: " + tests.length + " checks");
})();
