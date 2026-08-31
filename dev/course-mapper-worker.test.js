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

/* ---------- collect_extra_objects -------------------------------------------------------- */

/* A saved, already-playable course: one hole with a tee, a green and a route point, exactly
   the shape runObjectCollectionJob treats as authoritative and refuses to re-resolve. */
const CLAT = 36.0, CLNG = 174.0;
const cPoint = (east, north) => ({
  lat: CLAT + north / 111320,
  lng: CLNG + east / (111320 * Math.cos(CLAT * Math.PI / 180))
});
const cRing = (east, north, r) => [cPoint(east - r, north - r), cPoint(east + r, north - r), cPoint(east + r, north + r), cPoint(east - r, north + r)];

function savedCourseRow(extraObjects = {}) {
  return {
    course_id: "saved", course_name: "Saved", course_lat: CLAT, course_lng: CLNG,
    objects_json: Object.assign({
      "tee-1": { id: "tee-1", type: "tee", holeNumber: 1, position: cPoint(0, 0), source: "osm_auto_tee", confirmed: true },
      "green-1": { id: "green-1", type: "green", holeNumber: 1, position: cPoint(270, 0), shape: cRing(270, 0, 12), source: "osm_auto_green_polygon", confirmed: true },
      "fairway-1": { id: "fairway-1", type: "fairway", holeNumber: 1, position: cPoint(135, 0), source: "osm_auto_fairway", confirmed: true }
    }, extraObjects),
    holes_json: { 1: { holeNumber: 1, greenCenter: cPoint(270, 0), confirmed: true } },
    object_collection: null
  };
}

const OVERPASS_SURFACES = { elements: [
  { type: "way", id: 90, tags: { golf: "fairway" }, geometry: cRing(140, 0, 40) },
  { type: "way", id: 91, tags: { golf: "bunker" }, geometry: cRing(250, 22, 7) },
  { type: "way", id: 92, tags: { golf: "lateral_water_hazard" }, geometry: cRing(150, 42, 25) }
] };

/* Returns {patches, run} - every PATCH body the job sent, in order. */
function stubCollectionWorld(row) {
  const patches = [];
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (!url.includes("stub.supabase.co")) return jsonResponse(200, OVERPASS_SURFACES);
    const rest = url.split("/rest/v1/")[1] || "";
    if (method === "PATCH") {
      const body = JSON.parse(options.body || "{}");
      patches.push({ rest, body });
      return jsonResponse(200, [row]);
    }
    if (rest.startsWith("course_maps")) return jsonResponse(200, [row]);
    return jsonResponse(200, []);
  };
  return patches;
}

test("collect_extra_objects writes objects_json and nothing else", async () => {
  const row = savedCourseRow();
  const patches = stubCollectionWorld(row);
  const result = await worker.runObjectCollectionJob({ id: "job-c", course_id: "saved", kind: "collect_extra_objects" });

  assert.deepStrictEqual(result.added, { fairways: 1, bunkers: 1, water: 1 });
  assert.strictEqual(result.holeGeometryTouched, false);
  assert.strictEqual(result.visualsTouched, false);

  const geometryPatch = patches.find(p => p.body.objects_json);
  assert.ok(geometryPatch, "the collected objects were saved");
  /* The three columns that would make this behave like a remap. Their absence is the contract. */
  ["holes_json", "geometry_version", "hole_count"].forEach(column => {
    assert.ok(!(column in geometryPatch.body), column + " must not be written by an enrichment run");
  });
  /* And the saved hole geometry came through untouched rather than re-resolved. */
  const saved = geometryPatch.body.objects_json;
  assert.strictEqual(saved["tee-1"].source, "osm_auto_tee");
  assert.deepStrictEqual(saved["green-1"].position, cPoint(270, 0));
});

test("collect_extra_objects refuses a course with no saved holes rather than resolving some", async () => {
  const row = savedCourseRow();
  row.holes_json = {};
  stubCollectionWorld(row);
  await assert.rejects(
    () => worker.runObjectCollectionJob({ id: "job-c", course_id: "saved", kind: "collect_extra_objects" }),
    /no saved holes to enrich/
  );
});

/* Pressing the button twice must not double every bunker on the course. */
test("collect_extra_objects is idempotent", async () => {
  const row = savedCourseRow();
  const patches = stubCollectionWorld(row);
  await worker.runObjectCollectionJob({ id: "job-c", course_id: "saved", kind: "collect_extra_objects" });
  const first = patches.find(p => p.body.objects_json).body.objects_json;

  /* Feed the first run's output back in as the saved state, exactly as a second press would. */
  row.objects_json = first;
  const secondPatches = stubCollectionWorld(row);
  const second = await worker.runObjectCollectionJob({ id: "job-c2", course_id: "saved", kind: "collect_extra_objects" });
  assert.deepStrictEqual(second.added, { fairways: 0, bunkers: 0, water: 0 });
  const saved = secondPatches.find(p => p.body.objects_json).body.objects_json;
  assert.strictEqual(Object.keys(saved).length, Object.keys(first).length, "no duplicate surfaces on a second run");
});

/* The claim the whole job type exists to make. Not "the chain was skipped" - the chain is
   not reachable from this path, so there is no flag that could be set wrong. */
test("collect_extra_objects never chains a visual job", async () => {
  const row = savedCourseRow();
  const requests = [];
  global.fetch = async (url, options = {}) => {
    url = String(url);
    requests.push(url);
    const method = String(options.method || "GET").toUpperCase();
    if (!url.includes("stub.supabase.co")) return jsonResponse(200, OVERPASS_SURFACES);
    const rest = url.split("/rest/v1/")[1] || "";
    if (method === "PATCH") return jsonResponse(200, [row]);
    if (rest.startsWith("course_maps")) return jsonResponse(200, [row]);
    return jsonResponse(200, []);
  };
  await worker.runObjectCollectionJob({ id: "job-c", course_id: "saved", kind: "collect_extra_objects" });
  assert.strictEqual(requests.some(u => u.includes("course_visual_jobs")), false, "no visual job row was written");
  assert.strictEqual(requests.some(u => u.includes("course-visual-worker")), false, "the visual worker was never pinged");
});

/* An unapplied migration must not turn a successful enrichment into a failed job. */
test("collect_extra_objects still succeeds when the object_collection column is missing", async () => {
  const row = savedCourseRow();
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (!url.includes("stub.supabase.co")) return jsonResponse(200, OVERPASS_SURFACES);
    const rest = url.split("/rest/v1/")[1] || "";
    if (method === "PATCH") {
      const body = JSON.parse(options.body || "{}");
      if (body.object_collection) return jsonResponse(400, { message: "column \"object_collection\" does not exist" });
      return jsonResponse(200, [row]);
    }
    if (rest.startsWith("course_maps")) return jsonResponse(200, [row]);
    return jsonResponse(200, []);
  };
  const result = await worker.runObjectCollectionJob({ id: "job-c", course_id: "saved", kind: "collect_extra_objects" });
  assert.strictEqual(result.metadataSaved, false);
  assert.strictEqual(result.objectCollection, null);
  assert.deepStrictEqual(result.added, { fairways: 1, bunkers: 1, water: 1 }, "the objects still landed");
});

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
