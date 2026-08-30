/* course-package.mjs's buildCoursePackageWithTrigger: the one write this read endpoint may
 * cause - enqueueing a mapper job on a "none" state - plus the duplicate-course check that
 * must run before it. Supabase and the worker ping are stubbed at the fetch layer. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const GUEST = "9f7381c2e4a60b5d1c8e4f0a2b6d7e31";

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stubFetch(world) {
  const calls = { mapperJobInserts: [], mapUpserts: [], workerPings: 0 };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.includes("course-mapper-worker-background")) { calls.workerPings += 1; return jsonResponse(202, {}); }
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (table === "course_maps") {
      if (method === "POST") { calls.mapUpserts.push(JSON.parse(options.body || "[]")[0]); return jsonResponse(201, [{}]); }
      if (rest.includes("course_lat=gte")) return jsonResponse(200, world.nearbyMaps || []);
      /* The direct-lookup query always filters by course_id=eq.<id> - match it for real
         rather than returning a fixed fixture regardless of which id was asked for, or a
         lookup for the wrong course silently "succeeds" with someone else's row. */
      const idMatch = rest.match(/course_id=eq\.([^&]+)/);
      const requestedId = idMatch ? decodeURIComponent(idMatch[1]) : null;
      return jsonResponse(200, (world.maps || []).filter(row => row.course_id === requestedId));
    }
    if (table === "course_visuals") return jsonResponse(200, world.visuals || []);
    if (table === "course_visual_jobs") return jsonResponse(200, world.visualJobs || []);
    if (table === "course_mapper_jobs") {
      if (method === "POST") {
        const rows = JSON.parse(options.body || "[]");
        calls.mapperJobInserts.push(rows[0]);
        /* Inserted rows come back on the next read, so a scenario can ask the same question
           twice and get the same answer a real queue would give. Without this every poll of a
           course looks like the first one. */
        world.mapperJobs = [Object.assign({ id: "job-new" }, rows[0])].concat(world.mapperJobs || []);
        return jsonResponse(201, rows.map(r => Object.assign({ id: "job-new" }, r)));
      }
      if (rest.includes("requested_by=eq.")) return jsonResponse(200, world.userJobs || []);
      return jsonResponse(200, world.mapperJobs || []);
    }
    return jsonResponse(200, []);
  };
  return calls;
}

let buildCoursePackageWithTrigger = null;

test("a duplicate course nearby with geometry is returned instead of starting a new mapper job", async () => {
  const calls = stubFetch({
    nearbyMaps: [{ course_id: "pupuke-golf-club", course_name: "Pupuke Golf Club", course_lat: -36.8001, course_lng: 174.7001, objects_json: { g: { type: "green", holeNumber: 1, position: { lat: -36.8, lng: 174.7 } } }, holes_json: {} }],
    maps: [{ course_id: "pupuke-golf-club", published: true, objects_json: { g: { type: "green", holeNumber: 1, position: { lat: -36.8, lng: 174.7 } } }, holes_json: {} }]
  });
  const result = await buildCoursePackageWithTrigger("pupuke-gc", { center: { lat: -36.8, lng: 174.7 }, courseName: "Pupuke GC", userId: "user-1", origin: "https://clarity.example" });
  assert.strictEqual(result.status, "lite-geo-ready");
  assert.strictEqual(result.redirectedFrom, "pupuke-gc");
  assert.deepStrictEqual(calls.mapperJobInserts, [], "a duplicate with geometry must short-circuit before any job is enqueued");
});

test("no duplicate, a located and authenticated caller triggers a mapper job and gets processing back", async () => {
  const calls = stubFetch({ nearbyMaps: [] });
  const result = await buildCoursePackageWithTrigger("brand-new-course", { center: { lat: -36.8, lng: 174.7 }, courseName: "Brand New Course", userId: "user-1", origin: "https://clarity.example" });
  assert.strictEqual(result.status, "processing");
  assert.strictEqual(result.stage, "automap");
  assert.strictEqual(calls.mapperJobInserts.length, 1);
  assert.strictEqual(calls.mapperJobInserts[0].course_id, "brand-new-course");
  assert.strictEqual(calls.workerPings, 1);
  assert.ok(calls.mapUpserts.length >= 1, "a location-only course_maps stub is created so the worker has a center to query around");
});

test("no location means no trigger attempt at all - a plain 'none' comes back", async () => {
  const calls = stubFetch({});
  const result = await buildCoursePackageWithTrigger("brand-new-course", { userId: "user-1", origin: "https://clarity.example" });
  assert.strictEqual(result.status, "none");
  assert.deepStrictEqual(calls.mapperJobInserts, []);
});

test("a located caller with no actor at all does not trigger a job", async () => {
  const calls = stubFetch({ nearbyMaps: [] });
  const result = await buildCoursePackageWithTrigger("brand-new-course", { center: { lat: -36.8, lng: 174.7 } });
  assert.strictEqual(result.status, "none");
  assert.deepStrictEqual(calls.mapperJobInserts, [], "a run has to be attributable to somebody before this read endpoint may cause a write");
});

/* The signed-out first run. Not signing in is the normal state of a new install, and while
   this branch required an account the very first course a player ever opened could not be
   prepared - the package came back "none", the client read that as terminal, and the round
   opened in manual green-tapping. */
test("a signed-out caller with a guest installation id triggers a mapper job and gets processing back", async () => {
  const calls = stubFetch({ nearbyMaps: [] });
  const result = await buildCoursePackageWithTrigger("brand-new-course", { center: { lat: -36.8, lng: 174.7 }, courseName: "Brand New Course", guestId: GUEST, origin: "https://clarity.example" });
  assert.strictEqual(result.status, "processing");
  assert.strictEqual(result.stage, "automap");
  assert.strictEqual(calls.mapperJobInserts.length, 1);
  assert.strictEqual(calls.mapperJobInserts[0].requested_by, "guest:" + GUEST);
  assert.strictEqual(calls.workerPings, 1);
});

test("a guest id that is not a minted install id triggers nothing", async () => {
  const calls = stubFetch({ nearbyMaps: [] });
  const result = await buildCoursePackageWithTrigger("brand-new-course", { center: { lat: -36.8, lng: 174.7 }, guestId: "guest", origin: "https://clarity.example" });
  assert.strictEqual(result.status, "none");
  assert.deepStrictEqual(calls.mapperJobInserts, []);
});

/* Only the first pick of an unmapped course starts anything. Every later poll of the same
   course - which is how the client waits - must find the run that exists. */
test("a second request for a course already being mapped reuses the run instead of starting another", async () => {
  const calls = stubFetch({ nearbyMaps: [], mapperJobs: [] });
  await buildCoursePackageWithTrigger("brand-new-course", { center: { lat: -36.8, lng: 174.7 }, guestId: GUEST, origin: "https://clarity.example" });
  const again = await buildCoursePackageWithTrigger("brand-new-course", { center: { lat: -36.8, lng: 174.7 }, guestId: GUEST, origin: "https://clarity.example" });
  assert.strictEqual(again.status, "processing", "the live run is still the answer");
  assert.strictEqual(calls.mapperJobInserts.length, 1, "one course being mapped means one job, however many times it is asked for");
});

test("a course whose last run failed is NOT re-enqueued by a poll - failed comes back, no insert", async () => {
  /* The 2026-08-18 regression this guards: failed collapsed to "none", so every poll of a
     fast-failing course enqueued another identical job until the per-user rate limit tripped
     and unrelated courses stopped getting jobs at all. */
  const calls = stubFetch({ nearbyMaps: [], mapperJobs: [{ id: "job-1", kind: "automap", status: "failed", error: "no OSM hole geometry within range" }] });
  const result = await buildCoursePackageWithTrigger("doomed-course", { center: { lat: -36.8, lng: 174.7 }, courseName: "Doomed Course", userId: "user-1", origin: "https://clarity.example" });
  assert.strictEqual(result.status, "failed");
  assert.ok(result.reason.includes("no OSM hole geometry"));
  assert.deepStrictEqual(calls.mapperJobInserts, [], "a failed course must not be re-enqueued as a side effect of reading its state");
});

test("a rate-limited caller gets the underlying state back with a trigger error, not a fabricated success", async () => {
  stubFetch({ nearbyMaps: [], userJobs: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }] });
  const result = await buildCoursePackageWithTrigger("brand-new-course", { center: { lat: -36.8, lng: 174.7 }, userId: "user-1", origin: "https://clarity.example" });
  assert.strictEqual(result.triggerError, "rate-limited");
  assert.strictEqual(result.status, "none");
});

(async function run() {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  process.env.SUPABASE_ANON_KEY = "anon-stub";
  const mod = await import(path.join(root, "functions", "course-package.mjs"));
  buildCoursePackageWithTrigger = mod.buildCoursePackageWithTrigger;
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
  global.fetch = realFetch;
  process.env = realEnv;
  if (failures) {
    console.error("course-package-trigger FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-package-trigger passed: " + tests.length + " checks");
})();
