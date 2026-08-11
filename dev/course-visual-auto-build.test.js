/* course-visual-jobs: a player selecting an unbuilt course can start its build, and that is
 * the ONLY thing a player can start.
 *
 * The automatic cloud-frames route needs a signed-in player - not an admin - to kick off a
 * course scan when no frames exist. Before this the endpoint was admin-only, so the automatic
 * route had no way in. Widening it is the moment to be careful: the app surface is a consumer
 * of frames, never an author of them, and the recipe field is the authoring surface. So the
 * load-bearing assertions here are negative:
 *
 *   - an anonymous caller reaches no database write at all,
 *   - a signed-in non-admin cannot enqueue an export, which is what carries a recipe,
 *   - and a recipe smuggled into an "auto" body is stored as null regardless.
 *
 * The rest covers the cheap guards that stop one tap becoming a repeated 6.6k-tile course
 * scan: frames already published, a build already in flight, no published geometry, and the
 * per-user rate limit. Supabase is stubbed at the fetch layer, so the suite is hermetic. */

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

/* One stub for every outbound call the handler makes. `world` describes the database as the
   test wants it; `calls` records what the handler did to it. */
function stubFetch(world) {
  const calls = { inserts: [], reads: [], workerPings: 0 };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();

    if (url.includes("/auth/v1/user")) {
      const token = String((options.headers && options.headers.Authorization) || "").replace(/^Bearer /, "");
      const user = world.sessions && world.sessions[token];
      return user ? jsonResponse(200, user) : jsonResponse(401, { error: "bad token" });
    }
    if (url.includes("course-visual-worker-background")) {
      calls.workerPings += 1;
      return jsonResponse(202, {});
    }

    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (method === "POST") {
      const rows = JSON.parse(options.body || "[]");
      calls.inserts.push({ table, rows });
      return jsonResponse(201, rows.map((row, i) => Object.assign({ id: "job-new-" + i }, row)));
    }
    calls.reads.push(rest);
    if (table === "course_visuals") return jsonResponse(200, world.visuals || []);
    if (table === "course_maps") return jsonResponse(200, world.maps || []);
    if (table === "course_mapper_jobs") return jsonResponse(200, world.mapperJobs || []);
    if (table === "course_visual_jobs") {
      /* The rate-limit read is the only one filtered by requested_by; every other read of this
         table wants the course's job history. */
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
    url: "https://clarity.example/api/course-visual-jobs",
    headers: { get: (name) => (String(name).toLowerCase() === "authorization" && token ? "Bearer " + token : null) },
    json: async () => body
  };
}

function get(courseId) {
  return {
    method: "GET",
    url: "https://clarity.example/api/course-visual-jobs?courseId=" + encodeURIComponent(courseId),
    headers: { get: () => null }
  };
}

let handler = null;
async function call(request) {
  const response = await handler(request);
  return { status: response.status, body: JSON.parse(await response.text()) };
}

/* A signed-in player, a course with published geometry, nothing built yet - the state the
   automatic route is designed for. */
function unbuiltCourse(overrides = {}) {
  return Object.assign({
    sessions: { "player-token": PLAYER, "admin-token": ADMIN },
    /* objects_json is not decoration: the auto path judges geometry by CONTENT, because the
       mapper's ensureCourseCenter publishes a centre-only row before any geometry exists. A
       bare { course_id } row is that pre-mapping state, which its own test covers below. */
    maps: [{ course_id: "pupuke", objects_json: { "pupuke-h1-green": { type: "green", holeNumber: 1 } } }],
    visuals: [],
    jobs: [],
    userJobs: []
  }, overrides);
}

const jobInserts = (calls) => calls.inserts.filter(insert => insert.table === "course_visual_jobs");

test("an anonymous auto request is refused before it touches the database", async () => {
  const calls = stubFetch(unbuiltCourse());
  const result = await call(post({ courseId: "pupuke", kind: "auto" }, null));
  assert.strictEqual(result.status, 401);
  assert.deepStrictEqual(calls.inserts, [], "no write may happen for an unauthenticated caller");
  assert.deepStrictEqual(calls.reads, [], "and no read either - identity is checked first");
});

test("a signed-in player starts a snapshot on an unbuilt course", async () => {
  const calls = stubFetch(unbuiltCourse());
  const result = await call(post({ courseId: "pupuke", kind: "auto" }, "player-token"));
  assert.strictEqual(result.status, 202);
  assert.strictEqual(result.body.state, "queued");
  const inserted = jobInserts(calls);
  assert.strictEqual(inserted.length, 1);
  const row = inserted[0].rows[0];
  assert.strictEqual(row.kind, "snapshot", "auto enqueues a snapshot; the worker chains the export");
  assert.strictEqual(row.course_id, "pupuke");
  assert.strictEqual(row.requested_by, "auto:" + PLAYER.id);
  assert.strictEqual(calls.workerPings, 1, "the worker is woken rather than left to the sweeper");
});

test("a player cannot enqueue an export, which is what carries a recipe", async () => {
  const calls = stubFetch(unbuiltCourse());
  const result = await call(post({ courseId: "pupuke", kind: "export", recipe: { presetId: "twilight" } }, "player-token"));
  assert.strictEqual(result.status, 403);
  assert.deepStrictEqual(calls.inserts, [], "the app surface may not author a bake");
});

test("a recipe smuggled into an auto body is stored as null", async () => {
  const calls = stubFetch(unbuiltCourse());
  await call(post({ courseId: "pupuke", kind: "auto", recipe: { presetId: "twilight", overrides: { mowingVisibility: "Prominent" } } }, "player-token"));
  const row = jobInserts(calls)[0].rows[0];
  assert.strictEqual(row.recipe, null, "automatic exports bake the natural baseline, never a passed recipe");
});

test("an admin keeps the explicit export path, recipe and all", async () => {
  const calls = stubFetch(unbuiltCourse());
  const result = await call(post({ courseId: "pupuke", kind: "export", recipe: { presetId: "twilight" } }, "admin-token"));
  assert.strictEqual(result.status, 202);
  const row = jobInserts(calls)[0].rows[0];
  assert.strictEqual(row.kind, "export");
  assert.deepStrictEqual(row.recipe, { presetId: "twilight" });
  assert.strictEqual(row.requested_by, ADMIN.email);
});

test("a course that already has frames is not rebuilt", async () => {
  const calls = stubFetch(unbuiltCourse({ visuals: [{ published_version: 4, current_version: 4, status: "published" }] }));
  const result = await call(post({ courseId: "pupuke", kind: "auto" }, "player-token"));
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.state, "frames-ready");
  assert.strictEqual(result.body.framesVersion, 4);
  assert.deepStrictEqual(jobInserts(calls), [], "a client that misreads its own cache must not requeue the course");
});

test("a build already in flight is not duplicated", async () => {
  const calls = stubFetch(unbuiltCourse({ jobs: [{ id: "job-live", kind: "snapshot", status: "running", result: { progress: { capturesDone: 12 } } }] }));
  const result = await call(post({ courseId: "pupuke", kind: "auto" }, "player-token"));
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.state, "running");
  assert.deepStrictEqual(jobInserts(calls), []);
});

test("a course with no published geometry fails fast instead of queueing an empty scan", async () => {
  const calls = stubFetch(unbuiltCourse({ maps: [] }));
  const result = await call(post({ courseId: "pupuke", kind: "auto" }, "player-token"));
  assert.strictEqual(result.status, 404);
  assert.deepStrictEqual(jobInserts(calls), []);
});

test("a centre-only row mid-automap answers 'mapping' instead of minting a doomed job", async () => {
  /* ensureCourseCenter publishes { course_id, centre } with no geometry the moment a mapper
     job is enqueued. An auto request in that window used to pass the row-exists check and
     queue a snapshot whose only possible outcome was "capture plan is empty" - the player
     then saw a failed build for a course that was mapping fine. The mapper worker chains the
     snapshot itself when geometry lands, so the right answer here is a quiet "mapping". */
  const calls = stubFetch(unbuiltCourse({ maps: [{ course_id: "pupuke" }], mapperJobs: [{ id: "map-live" }] }));
  const result = await call(post({ courseId: "pupuke", kind: "auto" }, "player-token"));
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.state, "mapping");
  assert.deepStrictEqual(jobInserts(calls), []);
});

test("a player who has started several builds recently is rate limited", async () => {
  const calls = stubFetch(unbuiltCourse({ userJobs: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
  const result = await call(post({ courseId: "pupuke", kind: "auto" }, "player-token"));
  assert.strictEqual(result.status, 429);
  assert.deepStrictEqual(jobInserts(calls), []);
});

/* The state read is what the app polls while it plays over live tiles, so it must be readable
   without a session and must describe what EXISTS, not what the queue last said. */
test("the status read is public and derives the build state", async () => {
  stubFetch(unbuiltCourse({ jobs: [{ id: "j1", kind: "snapshot", status: "done" }] }));
  const ready = await call(get("pupuke"));
  assert.strictEqual(ready.status, 200);
  assert.strictEqual(ready.body.state, "captures-ready", "snapshot landed, export did not - retrying needs an export only");

  stubFetch(unbuiltCourse({ visuals: [{ published_version: 2 }], jobs: [{ id: "j1", kind: "export", status: "failed", error: "boom" }] }));
  const framed = await call(get("pupuke"));
  assert.strictEqual(framed.body.state, "frames-ready", "published frames outrank a failed rebuild - the course is playable");
  assert.strictEqual(framed.body.framesReady, true);

  stubFetch(unbuiltCourse({ jobs: [{ id: "j1", kind: "snapshot", status: "failed", error: "tile coverage incomplete" }] }));
  const failed = await call(get("pupuke"));
  assert.strictEqual(failed.body.state, "failed");
  assert.ok(String(failed.body.lastError).includes("tile coverage"));

  stubFetch(unbuiltCourse());
  const none = await call(get("pupuke"));
  assert.strictEqual(none.body.state, "none");
});

/* The studio's status chip reads data.jobs off this same GET; widening the response must not
   have taken that away. */
test("the status read still carries the job list the studio chip reads", async () => {
  stubFetch(unbuiltCourse({ jobs: [{ id: "j1", kind: "export", status: "running" }] }));
  const result = await call(get("pupuke"));
  assert.ok(Array.isArray(result.body.jobs) && result.body.jobs.length === 1);
  assert.strictEqual(result.body.jobs[0].kind, "export");
});

(async function run() {
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  process.env.SUPABASE_ANON_KEY = "anon-stub";
  handler = (await import(path.join(root, "functions", "course-visual-jobs.mjs"))).default;
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
    console.error("course-visual-auto-build FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-visual-auto-build passed: " + tests.length + " checks");
})();
