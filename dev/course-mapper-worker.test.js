/* course-mapper-worker-background: proves the atomic-claim pattern shared with
 * course-visual-worker-background.mjs - two concurrent claims against the same queued row
 * must never both succeed, and a job past the stall cutoff gets reaped/requeued. Supabase is
 * stubbed at the fetch layer. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let worker = null;

test("two concurrent claims against the same queued row never both succeed", async () => {
  let claimed = false;
  const row = { id: "job-1", course_id: "pupuke", kind: "automap", status: "queued" };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (method === "GET") {
      return jsonResponse(200, row.status === "queued" ? [row] : []);
    }
    if (method === "PATCH") {
      /* PATCH filter carries status=eq.queued - a second racer sees the row already flipped
         and gets nothing back, mirroring PostgREST's real behavior. */
      if (row.status !== "queued" || claimed) return jsonResponse(200, []);
      claimed = true;
      row.status = "running";
      return jsonResponse(200, [row]);
    }
    return jsonResponse(200, []);
  };
  const [a, b] = await Promise.all([
    worker.claimJob(null),
    worker.claimJob(null)
  ]);
  const winners = [a, b].filter(Boolean);
  assert.strictEqual(winners.length, 1, "exactly one of two concurrent claimers should win the row");
});

test("a job stalled past the cutoff is requeued, not left running forever", async () => {
  const staleAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const patches = [];
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    const rest = url.split("/rest/v1/")[1] || "";
    if (method === "GET" && rest.includes("status=eq.running")) {
      return jsonResponse(200, [{ id: "job-stale", result: null, updated_at: staleAt }]);
    }
    if (method === "PATCH") {
      patches.push(JSON.parse(options.body || "{}"));
      return jsonResponse(200, [{ id: "job-stale" }]);
    }
    return jsonResponse(200, []);
  };
  await worker.reapStaleJobs();
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].status, "queued", "a first stall is requeued, not failed");
});

test("a job stalled 8 times in a row is failed for good, not requeued forever", async () => {
  const staleAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const patches = [];
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    const rest = url.split("/rest/v1/")[1] || "";
    if (method === "GET" && rest.includes("status=eq.running")) {
      return jsonResponse(200, [{ id: "job-doomed", result: { attempts: 7 }, updated_at: staleAt }]);
    }
    if (method === "PATCH") {
      patches.push(JSON.parse(options.body || "{}"));
      return jsonResponse(200, [{ id: "job-doomed" }]);
    }
    return jsonResponse(200, []);
  };
  await worker.reapStaleJobs();
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].status, "failed");
});

/* NZ mainland bounds (LINZ-covered, key stubbed in run() below) and an Australian course
   (no licensed imagery source) - the two sides of chainVisualSnapshot's licensing guard. */
const NZ_BOUNDS = { south: -36.79, west: 174.75, north: -36.77, east: 174.77 };
const AU_BOUNDS = { south: -33.9, west: 151.2, north: -33.88, east: 151.22 };

test("a successful mapping run chains a visual snapshot and wakes the visual worker", async () => {
  const inserts = [];
  let pinged = false;
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.includes("course-visual-worker-background")) { pinged = true; return jsonResponse(202, {}); }
    if (method === "GET") return jsonResponse(200, []);
    if (method === "POST") { inserts.push(JSON.parse(options.body || "[]")); return jsonResponse(201, []); }
    return jsonResponse(200, []);
  };
  const outcome = await worker.chainVisualSnapshot("pupuke", NZ_BOUNDS, "https://clarity.test");
  assert.strictEqual(outcome.chained, true);
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0][0].course_id, "pupuke");
  assert.strictEqual(inserts[0][0].kind, "snapshot");
  assert.strictEqual(inserts[0][0].requested_by, "auto-after-automap");
  assert.strictEqual(pinged, true, "the visual worker should be woken rather than left to the sweeper");
});

test("no licensed imagery -> no snapshot job is minted", async () => {
  let touchedQueue = false;
  global.fetch = async () => { touchedQueue = true; return jsonResponse(200, []); };
  const outcome = await worker.chainVisualSnapshot("bondi-links", AU_BOUNDS, "https://clarity.test");
  assert.strictEqual(outcome.chained, false);
  assert.ok(String(outcome.reason).startsWith("imagery-source-unavailable"), "reason should carry the licensing verdict: " + outcome.reason);
  assert.strictEqual(touchedQueue, false, "an unlicensed course should never reach the job queue");
});

test("a live snapshot job dedupes the chain instead of stacking a second worker", async () => {
  const posts = [];
  global.fetch = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    if (method === "GET") return jsonResponse(200, [{ id: "job-live" }]);
    posts.push(String(url));
    return jsonResponse(201, []);
  };
  const outcome = await worker.chainVisualSnapshot("pupuke", NZ_BOUNDS, "https://clarity.test");
  assert.strictEqual(outcome.chained, false);
  assert.strictEqual(outcome.reason, "snapshot-already-live");
  assert.strictEqual(posts.length, 0);
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

(async function run() {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  /* Makes LINZ resolvable so the chain tests exercise the licensed path - the imagery table
     refuses a source whose key is not configured, which is itself what the AU test relies on. */
  process.env.LINZ_BASEMAPS_API_KEY = "stub-linz-key";
  const mod = await import(path.join(root, "functions", "course-mapper-worker-background.mjs"));
  worker = mod.__courseMapperWorkerTest;
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
    console.error("course-mapper-worker FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-mapper-worker passed: " + tests.length + " checks");
})();
