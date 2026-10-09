/* Background growth of the course database: after a player's scan, the ten nearest courses we
 * hold nothing for are queued as low-priority mapping jobs (NEARBY_AUTOMAP_KIND in
 * functions/course-mapper-jobs.mjs).
 *
 * Load-bearing assertions:
 *   - the nearest unmapped courses are queued, at most ten, closest first
 *   - a course we already have a row for, or whose id another course owns, is never queued
 *   - background jobs are never pinged awake - they wait for an idle worker
 *   - the worker takes a player job before any background job, and takes no background job
 *     while a player job is waiting or running
 *   - a background job never queues neighbours of its own
 *   - a player opening a course still waiting in the background queue moves it to the front
 *   - a failed background run does not stop the first player getting their own attempt
 *
 * Supabase and Overpass are stubbed at the fetch layer, so the suite is hermetic. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);
const BASE = "https://stub.supabase.co";

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/* A scanned course at (0,0) and OSM courses spread out to the east, 1 km apart. */
const SOURCE = { course_id: "home-golf-club", course_name: "Home Golf Club", course_lat: 0, course_lng: 0 };
function osmCourse(index) {
  return { type: "way", id: 1000 + index, tags: { leisure: "golf_course", name: "Course " + index }, center: { lat: 0, lon: index * 0.009 } };
}

function stubFetch(world) {
  /* The shared Overpass client caches by query, and every world here asks around the same point. */
  if (overpassCache) overpassCache.clear();
  const calls = { inserts: [], patches: [], pings: [], reads: [] };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.includes("overpass")) return jsonResponse(200, { elements: world.osm || [] });
    if (url.includes("/auth/v1/admin/users/")) {
      const id = decodeURIComponent(url.split("/auth/v1/admin/users/")[1]);
      return (world.users || {})[id] ? jsonResponse(200, world.users[id]) : jsonResponse(404, {});
    }
    if (url.includes("course-mapper-worker-background")) {
      calls.pings.push(JSON.parse(options.body || "{}"));
      return jsonResponse(202, {});
    }
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (method === "POST") {
      const rows = JSON.parse(options.body || "[]");
      calls.inserts.push({ table, rows });
      return jsonResponse(201, rows.map((row, i) => Object.assign({ id: "new-" + i }, row)));
    }
    if (method === "PATCH") {
      calls.patches.push({ table, rest, body: JSON.parse(options.body || "{}") });
      return jsonResponse(200, world.patchedRows ? world.patchedRows(rest) : []);
    }
    calls.reads.push(rest);
    if (table === "course_maps") {
      const id = (rest.match(/course_id=eq\.([^&]+)/) || [])[1];
      const maps = world.maps || [];
      return jsonResponse(200, id ? maps.filter(row => row.course_id === decodeURIComponent(id)) : maps);
    }
    if (table === "course_maps_list") return jsonResponse(200, []);
    if (table === "course_mapper_jobs") return jsonResponse(200, world.jobs ? world.jobs(rest) : []);
    return jsonResponse(200, []);
  };
  return calls;
}

const jobInserts = calls => calls.inserts.filter(insert => insert.table === "course_mapper_jobs").flatMap(insert => insert.rows);

let jobs = null;
let worker = null;
let shape = null;
let overpassCache = null;

test("the ten nearest unmapped courses are queued, closest first, as background jobs", async () => {
  const calls = stubFetch({ maps: [SOURCE], osm: Array.from({ length: 14 }, (_, i) => osmCourse(14 - i)) });
  const outcome = await jobs.enqueueNearbyMapperJobs({ sourceCourseId: SOURCE.course_id });
  const queued = jobInserts(calls);
  assert.strictEqual(queued.length, 10);
  assert.deepStrictEqual(queued.map(row => row.course_id), Array.from({ length: 10 }, (_, i) => "course-" + (i + 1)));
  queued.forEach(row => {
    assert.strictEqual(row.kind, jobs.NEARBY_AUTOMAP_KIND);
    assert.strictEqual(row.requested_by, "nearby:" + SOURCE.course_id);
  });
  assert.strictEqual(calls.pings.length, 0, "background jobs wait for an idle worker");
  assert.deepStrictEqual(outcome.queued.length, 10);
});

test("a course we already hold, or whose id another course owns, is not queued", async () => {
  const mapped = { course_id: "course-1-mapped", course_name: "Course 1", course_lat: 0, course_lng: 0.009 };
  const elsewhere = { course_id: "course-2", course_name: "Course 2", course_lat: 51, course_lng: -1 };
  const calls = stubFetch({ maps: [SOURCE, mapped, elsewhere], osm: [osmCourse(1), osmCourse(2), osmCourse(3)] });
  await jobs.enqueueNearbyMapperJobs({ sourceCourseId: SOURCE.course_id });
  assert.deepStrictEqual(jobInserts(calls).map(row => row.course_id), ["course-3"]);
});

test("a course with a live job is not queued twice", async () => {
  const calls = stubFetch({
    maps: [SOURCE], osm: [osmCourse(1), osmCourse(2)],
    jobs: rest => rest.includes("course_id=eq.course-1") && rest.includes("status=in.(queued,running)") ? [{ id: "live" }] : []
  });
  await jobs.enqueueNearbyMapperJobs({ sourceCourseId: SOURCE.course_id });
  assert.deepStrictEqual(jobInserts(calls).map(row => row.course_id), ["course-2"]);
});

test("a busy Overpass means no neighbours this time, not an error", async () => {
  stubFetch({ maps: [SOURCE] });
  global.fetch = (inner => async (url, options) => String(url).includes("overpass") ? jsonResponse(504, {}) : inner(url, options))(global.fetch);
  const outcome = await jobs.enqueueNearbyMapperJobs({ sourceCourseId: SOURCE.course_id });
  assert.deepStrictEqual(outcome.queued, []);
});

test("the worker takes a player job before any background job", async () => {
  const calls = stubFetch({
    jobs: rest => rest.includes("kind=neq.nearby_automap") && rest.includes("status=eq.queued") ? [{ id: "player-job", kind: "automap" }] : [],
    patchedRows: rest => rest.includes("player-job") ? [{ id: "player-job", kind: "automap" }] : []
  });
  const job = await worker.claimNextJob({ allowNearby: true });
  assert.strictEqual(job.id, "player-job");
  assert.ok(!calls.reads.some(rest => rest.includes("kind=eq.nearby_automap")), "the background queue was not even looked at");
});

test("no background job is taken while a player job is running", async () => {
  const calls = stubFetch({
    jobs: rest => {
      if (rest.includes("status=eq.queued")) return rest.includes("kind=eq.nearby_automap") ? [{ id: "bg" }] : [];
      if (rest.includes("status=in.(queued,running)") && rest.includes("kind=neq.nearby_automap")) return [{ id: "player-running" }];
      return [];
    }
  });
  assert.strictEqual(await worker.claimNextJob({ allowNearby: true }), null);
  assert.strictEqual(calls.patches.length, 0);
});

test("only one background job runs at a time", async () => {
  stubFetch({
    jobs: rest => {
      if (rest.includes("status=eq.queued")) return rest.includes("kind=eq.nearby_automap") ? [{ id: "bg" }] : [];
      if (rest.includes("status=eq.running") && rest.includes("kind=eq.nearby_automap")) return [{ id: "bg-running" }];
      return [];
    }
  });
  assert.strictEqual(await worker.claimNextJob({ allowNearby: true }), null);
});

test("an idle worker takes a background job, unless its time budget is spent", async () => {
  const world = {
    jobs: rest => rest.includes("status=eq.queued") && rest.includes("kind=eq.nearby_automap") ? [{ id: "bg" }] : [],
    patchedRows: () => [{ id: "bg", kind: "nearby_automap" }]
  };
  stubFetch(world);
  assert.strictEqual((await worker.claimNextJob({ allowNearby: true })).id, "bg");
  stubFetch(world);
  assert.strictEqual(await worker.claimNextJob({ allowNearby: false }), null);
});

test("a background job never queues neighbours of its own", async () => {
  const calls = stubFetch({ maps: [SOURCE], osm: [osmCourse(1)] });
  await worker.queueNeighboursAfter({ id: "bg", course_id: SOURCE.course_id, kind: "nearby_automap", requested_by: "nearby:x" });
  assert.strictEqual(jobInserts(calls).length, 0);
  assert.ok(!calls.reads.length, "nothing was even read");
  await worker.queueNeighboursAfter({ id: "p", course_id: SOURCE.course_id, kind: "automap", requested_by: "guest:install-12345678" });
  assert.strictEqual(jobInserts(calls).length, 1, "a player's scan does");
});

test("only a player's scan queues neighbours - never an admin's", async () => {
  const users = { "u-player": { email: "golfer@example.com" }, "u-admin": { email: "SamHaleGolf@gmail.com" } };
  const run = async requestedBy => {
    const calls = stubFetch({ maps: [SOURCE], osm: [osmCourse(1)], users });
    await worker.queueNeighboursAfter({ id: "j", course_id: SOURCE.course_id, kind: "automap", requested_by: requestedBy });
    return jobInserts(calls).length;
  };
  assert.strictEqual(await run("user:u-player"), 1, "a signed-in player");
  assert.strictEqual(await run("guest:install-12345678"), 1, "a guest install");
  assert.strictEqual(await run("user:u-admin"), 0, "an admin's run - a Studio remap, an overlay run - queues nothing");
  assert.strictEqual(await run("user:u-unknown"), 0, "an account that cannot be looked up queues nothing");
  assert.strictEqual(await run(""), 0, "no requester queues nothing");
});

test("a player opening a course waiting in the background queue moves it to the front", async () => {
  const calls = stubFetch({
    patchedRows: rest => rest.includes("kind=eq.nearby_automap") ? [{ id: "bg-1", kind: "automap" }] : []
  });
  assert.strictEqual(await jobs.promoteNearbyJob("course-1", "https://clarity.example"), true);
  const patch = calls.patches.find(p => p.table === "course_mapper_jobs");
  assert.ok(patch.rest.includes("status=eq.queued"), "a running job is left alone");
  assert.strictEqual(patch.body.kind, "automap");
  assert.deepStrictEqual(calls.pings, [{ jobId: "bg-1" }], "and it is woken by its own id");
});

test("a failed background run does not stop a player getting their own attempt", async () => {
  const failedBackground = [{ kind: "nearby_automap", status: "failed", error: "no OSM holes" }];
  assert.strictEqual(shape.deriveCoursePackageState({ map: null, visual: null, visualJobs: [], mapperJobs: failedBackground }), "none");
  const failedPlayer = [{ kind: "automap", status: "failed", error: "no OSM holes" }];
  assert.strictEqual(shape.deriveCoursePackageState({ map: null, visual: null, visualJobs: [], mapperJobs: failedPlayer }), "failed");
});

(async function run() {
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  process.env.SUPABASE_ANON_KEY = "anon-stub";
  jobs = await import(path.join(root, "functions", "course-mapper-jobs.mjs"));
  worker = (await import(path.join(root, "functions", "course-mapper-worker-background.mjs"))).__courseMapperWorkerTest;
  shape = await import(path.join(root, "functions", "lib", "gd-course-package-shape.mjs"));
  overpassCache = (await import(path.join(root, "functions", "lib", "gd-overpass-client.mjs"))).__overpassClientTest.responseCache;
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
    console.error("course-nearby-prefetch FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-nearby-prefetch passed: " + tests.length + " checks");
})();
