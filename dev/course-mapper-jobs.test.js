/* course-mapper-jobs: a player selecting a course with no geometry can start a server-side
 * mapping run, and that is the ONLY thing a player can start - there is no admin-authored
 * recipe path here (AutoMapper takes no authoring input). Modeled directly on
 * dev/course-visual-auto-build.test.js's stub-fetch harness.
 *
 * Load-bearing assertions:
 *   - an anonymous caller reaches no database write at all
 *   - a course that already has geometry at the current mapper version is not remapped
 *   - a build already in flight is not duplicated
 *   - the per-user rate limit holds
 *   - "nudge" is admin-only, "automap" is open to any signed-in player
 *
 * Supabase is stubbed at the fetch layer, so the suite is hermetic. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const BASE = "https://stub.supabase.co";
const PLAYER = { id: "user-player-1", email: "player@example.com" };
const ADMIN = { id: "user-admin-1", email: "samhalegolf@gmail.com" };

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function stubFetch(world) {
  const calls = { inserts: [], reads: [], workerPings: 0, patches: [] };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();

    if (url.includes("/auth/v1/user")) {
      const token = String((options.headers && options.headers.Authorization) || "").replace(/^Bearer /, "");
      const user = world.sessions && world.sessions[token];
      return user ? jsonResponse(200, user) : jsonResponse(401, { error: "bad token" });
    }
    if (url.includes("course-mapper-worker-background")) {
      calls.workerPings += 1;
      return jsonResponse(202, {});
    }

    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (method === "POST") {
      const rows = JSON.parse(options.body || "[]");
      calls.inserts.push({ table, rows });
      return jsonResponse(201, rows.map((row, i) => Object.assign({ id: "mapper-job-new-" + i }, row)));
    }
    if (method === "PATCH") {
      calls.patches.push({ table, rest });
      return jsonResponse(200, world.patchedRows || []);
    }
    calls.reads.push(rest);
    if (table === "course_maps") return jsonResponse(200, world.maps || []);
    if (table === "course_mapper_jobs") {
      if (rest.includes("requested_by=eq.")) return jsonResponse(200, world.userJobs || []);
      return jsonResponse(200, world.jobs || []);
    }
    return jsonResponse(200, []);
  };
  return calls;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function post(body, token) {
  return {
    method: "POST",
    url: "https://clarity.example/api/course-mapper-jobs",
    headers: { get: (name) => (String(name).toLowerCase() === "authorization" && token ? "Bearer " + token : null) },
    json: async () => body
  };
}

function get(courseId) {
  return {
    method: "GET",
    url: "https://clarity.example/api/course-mapper-jobs?courseId=" + encodeURIComponent(courseId),
    headers: { get: () => null }
  };
}

let handler = null;
async function call(request) {
  const response = await handler(request);
  return { status: response.status, body: JSON.parse(await response.text()) };
}

function unmappedCourse(overrides = {}) {
  return Object.assign({
    sessions: { "player-token": PLAYER, "admin-token": ADMIN },
    maps: [],
    jobs: [],
    userJobs: []
  }, overrides);
}

const jobInserts = (calls) => calls.inserts.filter(insert => insert.table === "course_mapper_jobs");

test("an anonymous automap request is refused before it touches the database", async () => {
  const calls = stubFetch(unmappedCourse());
  const result = await call(post({ courseId: "pupuke", kind: "automap" }, null));
  assert.strictEqual(result.status, 401);
  assert.deepStrictEqual(calls.inserts, [], "no write may happen for an unauthenticated caller");
  assert.deepStrictEqual(calls.reads, [], "and no read either - identity is checked first");
});

test("a signed-in player starts a mapping run on an unmapped course", async () => {
  const calls = stubFetch(unmappedCourse());
  /* Coordinates travel with the request because the real caller always has them: the picker
     reaches this through /api/course-package, which returns "none" without a centre. This
     test used to omit them and still expect a queued job - the behaviour that let
     kelvin-heights-road queue a run that could only fail on "has no known location". */
  const result = await call(post({ courseId: "pupuke", kind: "automap", courseLat: -36.78, courseLng: 174.76 }, "player-token"));
  assert.strictEqual(result.status, 202);
  assert.strictEqual(result.body.state, "queued");
  const inserted = jobInserts(calls);
  assert.strictEqual(inserted.length, 1);
  const row = inserted[0].rows[0];
  assert.strictEqual(row.kind, "automap");
  assert.strictEqual(row.course_id, "pupuke");
  assert.strictEqual(row.requested_by, "auto:" + PLAYER.id);
  assert.ok(row.mapper_version, "mapper_version travels with the job so it can be compared later");
  assert.strictEqual(calls.workerPings, 1, "the worker is woken rather than left to the sweeper");
});

test("nudge is admin-only", async () => {
  const calls = stubFetch(unmappedCourse());
  const result = await call(post({ courseId: "pupuke", kind: "nudge" }, "player-token"));
  assert.strictEqual(result.status, 403);
  assert.deepStrictEqual(calls.inserts, []);
});

test("an admin may nudge a stalled run", async () => {
  const stalledAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  stubFetch(unmappedCourse({ jobs: [{ id: "job-stuck", kind: "automap", status: "running", updated_at: stalledAt }] }));
  const result = await call(post({ courseId: "pupuke", kind: "nudge" }, "admin-token"));
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.nudged, true);
});

test("a course whose geometry is already current is not remapped", async () => {
  const { MAPPER_VERSION } = require(path.join(root, "functions", "course-mapper-jobs.mjs")).__courseMapperJobsTest || {};
  const calls = stubFetch(unmappedCourse({ maps: [{ course_id: "pupuke", published: true, geometry_version: "v1", objects_json: { a: {} }, holes_json: {} }] }));
  const result = await call(post({ courseId: "pupuke", kind: "automap" }, "player-token"));
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.state, "geometry-ready");
  assert.deepStrictEqual(jobInserts(calls), [], "geometry at the current mapper version must not be redone");
});

test("a build already in flight is not duplicated", async () => {
  const calls = stubFetch(unmappedCourse({ jobs: [{ id: "job-live", kind: "automap", status: "running" }] }));
  const result = await call(post({ courseId: "pupuke", kind: "automap" }, "player-token"));
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.state, "running");
  assert.deepStrictEqual(jobInserts(calls), []);
});

test("a player who has started several mapping runs recently is rate limited", async () => {
  const calls = stubFetch(unmappedCourse({ userJobs: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }] }));
  const result = await call(post({ courseId: "pupuke", kind: "automap" }, "player-token"));
  assert.strictEqual(result.status, 429);
  assert.deepStrictEqual(jobInserts(calls), []);
});

test("a courseLat/courseLng in the enqueue payload upserts a location-only course_maps stub", async () => {
  const calls = stubFetch(unmappedCourse());
  await call(post({ courseId: "pupuke", kind: "automap", courseLat: -36.8, courseLng: 174.7, courseName: "Pupuke" }, "player-token"));
  const mapWrites = calls.inserts.filter(insert => insert.table === "course_maps");
  assert.strictEqual(mapWrites.length, 1);
  const row = mapWrites[0].rows[0];
  assert.strictEqual(row.id, "published::pupuke");
  assert.strictEqual(row.course_lat, -36.8);
  assert.strictEqual(row.course_lng, 174.7);
  assert.ok(!("objects_json" in row), "the location upsert must never touch geometry columns");
});

test("no courseLat/courseLng in the payload means no course_maps write at all", async () => {
  const calls = stubFetch(unmappedCourse());
  await call(post({ courseId: "pupuke", kind: "automap" }, "player-token"));
  assert.deepStrictEqual(calls.inserts.filter(insert => insert.table === "course_maps"), []);
});

test("a course with no coordinates anywhere is refused rather than queued to fail", async () => {
  const calls = stubFetch(unmappedCourse());
  const result = await call(post({ courseId: "kelvin-heights-road", kind: "automap" }, "player-token"));
  assert.strictEqual(result.status, 422);
  assert.match(String(result.body.error || ""), /no location/);
  assert.strictEqual(jobInserts(calls).length, 0, "nothing is queued that the worker could only fail");
  assert.strictEqual(calls.workerPings, 0, "and the worker is not woken for it");
});

test("a stored centre is enough on its own to start a run", async () => {
  const calls = stubFetch(unmappedCourse({
    maps: [{ course_id: "pupuke", published: true, course_lat: -36.78, course_lng: 174.76, objects_json: {}, holes_json: {} }]
  }));
  const result = await call(post({ courseId: "pupuke", kind: "automap" }, "player-token"));
  assert.strictEqual(result.status, 202);
  assert.strictEqual(jobInserts(calls).length, 1);
});

test("the status read is public and derives the mapping state", async () => {
  stubFetch(unmappedCourse());
  const none = await call(get("pupuke"));
  assert.strictEqual(none.status, 200);
  assert.strictEqual(none.body.state, "none");

  stubFetch(unmappedCourse({ jobs: [{ id: "j1", kind: "automap", status: "running" }] }));
  const running = await call(get("pupuke"));
  assert.strictEqual(running.body.state, "running");

  stubFetch(unmappedCourse({ maps: [{ course_id: "pupuke", published: true, geometry_version: "v1", objects_json: { a: {} }, holes_json: { 1: {} } }] }));
  const ready = await call(get("pupuke"));
  assert.strictEqual(ready.body.state, "geometry-ready");
  assert.strictEqual(ready.body.hasGeometry, true);

  stubFetch(unmappedCourse({ jobs: [{ id: "j1", kind: "automap", status: "failed", error: "no OSM data in range" }] }));
  const failed = await call(get("pupuke"));
  assert.strictEqual(failed.body.state, "failed");
  assert.ok(String(failed.body.lastError).includes("no OSM data"));
});

(async function run() {
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  process.env.SUPABASE_ANON_KEY = "anon-stub";
  handler = (await import(path.join(root, "functions", "course-mapper-jobs.mjs"))).default;
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
  global.fetch = realFetch;
  process.env = realEnv;
  if (failures) {
    console.error("course-mapper-jobs FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-mapper-jobs passed: " + tests.length + " checks");
})();
