/* course-mapper-jobs: a player selecting a course with no geometry can start a server-side
 * mapping run, and that is the ONLY thing a player can start - there is no admin-authored
 * recipe path here (AutoMapper takes no authoring input). Modeled directly on
 * dev/course-visual-auto-build.test.js's stub-fetch harness.
 *
 * Load-bearing assertions:
 *   - a caller with NO identity at all - no session, no guest id - reaches no database write
 *   - a signed-out caller WITH a guest installation id may start a normal automap
 *   - a course that already has geometry at the current mapper version is not remapped
 *   - a build already in flight is not duplicated
 *   - the per-actor rate limit holds, tighter for guests than for signed-in players
 *   - a live job wins over the rate limit, so polling and re-picking cost no quota
 *   - "nudge" and "remap" stay admin-only; a guest is never an operator
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
/* A minted installation id, in the shape scripts/gd-guest-identity.js produces. */
const GUEST = "9f7381c2e4a60b5d1c8e4f0a2b6d7e31";

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

test("an automap request with no identity at all is refused before it touches the database", async () => {
  const calls = stubFetch(unmappedCourse());
  const result = await call(post({ courseId: "pupuke", kind: "automap" }, null));
  assert.strictEqual(result.status, 401);
  assert.deepStrictEqual(calls.inserts, [], "no write may happen for a caller with no actor");
  assert.deepStrictEqual(calls.reads, [], "and no read either - the actor is resolved first");
});

test("a malformed guest id is no identity at all", async () => {
  const calls = stubFetch(unmappedCourse());
  const result = await call(post({ courseId: "pupuke", kind: "automap", guestId: "abc" }, null));
  assert.strictEqual(result.status, 401, "too short to be a minted install id");
  assert.deepStrictEqual(calls.inserts, []);
});

/* The first run of this app. No account exists yet, and requiring one before a course could be
   prepared meant that run always ended in the player tapping greens by hand. */
test("a signed-out player with a guest installation id starts a mapping run", async () => {
  const calls = stubFetch(unmappedCourse());
  const result = await call(post({ courseId: "pupuke", kind: "automap", courseLat: -36.78, courseLng: 174.76, guestId: GUEST }, null));
  assert.strictEqual(result.status, 202);
  assert.strictEqual(result.body.state, "queued");
  const row = jobInserts(calls)[0].rows[0];
  assert.strictEqual(row.kind, "automap");
  assert.strictEqual(row.requested_by, "guest:" + GUEST, "provenance says which install asked, and that it was not an account");
  assert.strictEqual(calls.workerPings, 1);
});

test("a verified session always wins over a guest id sent alongside it", async () => {
  const calls = stubFetch(unmappedCourse());
  const result = await call(post({ courseId: "pupuke", kind: "automap", courseLat: -36.78, courseLng: 174.76, guestId: GUEST }, "player-token"));
  assert.strictEqual(result.status, 202);
  assert.strictEqual(jobInserts(calls)[0].rows[0].requested_by, "user:" + PLAYER.id,
    "a signed-in player must not be able to spend the anonymous budget instead of their own");
});

test("a guest is never an operator", async () => {
  const nudged = await call(post({ courseId: "pupuke", kind: "nudge", guestId: GUEST }, null));
  assert.strictEqual(nudged.status, 403, "requeueing a stalled run is an admin action");
  const remapped = await call(post({ courseId: "pupuke", kind: "remap", guestId: GUEST }, null));
  assert.strictEqual(remapped.status, 403, "so is throwing away a course's geometry");
});

test("guests hit a tighter new-scan limit than signed-in players", async () => {
  const { AUTO_RATE_MAX_PER_GUEST, AUTO_RATE_MAX_PER_USER } = (await import(path.join(root, "functions", "course-mapper-jobs.mjs"))).__courseMapperJobsTest;
  assert.ok(AUTO_RATE_MAX_PER_GUEST < AUTO_RATE_MAX_PER_USER, "an anonymous budget that matched a signed-in one would not be a budget");
  const recent = Array.from({ length: AUTO_RATE_MAX_PER_GUEST }, (_, i) => ({ id: "g" + i }));
  const calls = stubFetch(unmappedCourse({ userJobs: recent }));
  const result = await call(post({ courseId: "pupuke", kind: "automap", courseLat: -36.78, courseLng: 174.76, guestId: GUEST }, null));
  assert.strictEqual(result.status, 429);
  assert.deepStrictEqual(jobInserts(calls), [], "no new scan is started once the budget is spent");
});

/* The rule the whole limit rests on: only STARTING a scan costs anything. A player who
   re-picks a course that is already being mapped, or whose app is polling one, must be handed
   the run that exists rather than told to slow down about it. */
test("a live job is reused even by an actor who has spent their budget", async () => {
  const { AUTO_RATE_MAX_PER_GUEST } = (await import(path.join(root, "functions", "course-mapper-jobs.mjs"))).__courseMapperJobsTest;
  const calls = stubFetch(unmappedCourse({
    userJobs: Array.from({ length: AUTO_RATE_MAX_PER_GUEST + 2 }, (_, i) => ({ id: "g" + i })),
    jobs: [{ id: "job-live", kind: "automap", status: "running", updated_at: new Date().toISOString() }]
  }));
  const result = await call(post({ courseId: "pupuke", kind: "automap", courseLat: -36.78, courseLng: 174.76, guestId: GUEST }, null));
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.deduped, true, "the run already in flight is the answer, not a rate-limit refusal");
  assert.deepStrictEqual(jobInserts(calls), []);
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
  assert.strictEqual(row.requested_by, "user:" + PLAYER.id);
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
  /* Read from the module rather than hard-coded: a pinned "v1" silently stopped matching when
     the mapper version moved on, and the assertion below started passing for the wrong reason
     - the request was being refused for having no location, not deduped for being current. */
  const { MAPPER_VERSION } = (await import(path.join(root, "functions", "course-mapper-jobs.mjs"))).__courseMapperJobsTest;
  const calls = stubFetch(unmappedCourse({ maps: [{ course_id: "pupuke", published: true, geometry_version: MAPPER_VERSION, objects_json: { a: {} }, holes_json: {} }] }));
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
