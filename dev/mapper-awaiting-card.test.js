/* A scan that found golf but had no scorecard to number it waits for a card, then runs again.
 *
 * The Kenya scans of 2026-10-27 failed with "geometry-resolved-numbering-unavailable (no
 * shared scorecard found)" while greens and fairways sat right there in OSM; their cards
 * arrived 20 minutes to 16 hours later and nothing re-ran the maps. What is asserted:
 *   - such a scan is parked (result.awaitingCard), a card search is queued for its course,
 *     and the debug Routine is held rather than fired
 *   - a scan that found no golf at all is not parked: a card cannot number nothing
 *   - a parked job whose course now has a card - from any source - is queued again, once
 *   - a parked job whose card search finished empty-handed fires the held debug, once, and
 *     keeps waiting for a card from elsewhere
 *
 * Run: node dev/mapper-awaiting-card.test.js */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } };
}

const COURSE = {
  course_id: "limuru-country-club", course_name: "Limuru Country Club", facility_name: "", course_lat: -1.1339, course_lng: 36.6734,
  region: "Kiambu", country: "Kenya", country_code: "KE", objects_json: {}, holes_json: {}
};

/* A ring of greens and fairways round the centre, no hole lines - Limuru as OSM has it. */
function greensAndFairways(count) {
  const elements = [];
  for (let i = 0; i < count; i++) {
    const lat = COURSE.course_lat + Math.cos(i) * 0.003;
    const lon = COURSE.course_lng + Math.sin(i) * 0.003;
    const ring = [[0, 0], [0, 0.0002], [0.0002, 0.0002], [0.0002, 0], [0, 0]].map(([a, b]) => ({ lat: lat + a, lon: lon + b }));
    elements.push({ type: "way", id: 1000 + i, tags: { golf: "green" }, geometry: ring });
    elements.push({ type: "way", id: 2000 + i, tags: { golf: "fairway" }, geometry: ring.map(p => ({ lat: p.lat - 0.001, lon: p.lon })) });
  }
  return elements;
}

function stubWorld(world) {
  const calls = { jobInserts: [], jobPatches: [], fires: 0, served: false };
  global.fetch = async (url, init = {}) => {
    url = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (url.startsWith("https://api.anthropic.com/")) { calls.fires++; return jsonResponse(200, { claude_code_session_url: "https://claude.ai/code/session_x" }); }
    if (url.includes("overpass")) return jsonResponse(200, { elements: world.elements || [] });
    if (url.includes("/.netlify/functions/scorecard-search")) return jsonResponse(200, { results: [] });
    const rest = url.split("/rest/v1/")[1];
    if (rest === undefined) return jsonResponse(200, {});
    const table = rest.split("?")[0];
    if (table === "course_mapper_jobs") {
      if (method === "POST") {
        const rows = JSON.parse(init.body || "[]");
        calls.jobInserts.push(...rows);
        return jsonResponse(201, rows.map((row, i) => Object.assign({ id: "new-" + calls.jobInserts.length + "-" + i }, row)));
      }
      if (method === "PATCH") {
        const body = JSON.parse(init.body || "{}");
        if (rest.includes("status=eq.queued")) return jsonResponse(200, world.job ? [Object.assign({}, world.job, { status: "running" })] : []);
        calls.jobPatches.push({ rest, body });
        return jsonResponse(200, []);
      }
      if (rest.includes("awaitingCard")) return jsonResponse(200, world.waiting || []);
      if (rest.includes("status=eq.queued") && rest.includes("kind=not.in")) {
        if (calls.served || !world.job) return jsonResponse(200, []);
        calls.served = true;
        return jsonResponse(200, [world.job]);
      }
      if (rest.includes("kind=eq.resolve_scorecards") && rest.includes("status=in.")) return jsonResponse(200, world.openSearch || []);
      if (rest.startsWith("course_mapper_jobs?select=status&id=eq.")) return jsonResponse(200, world.searchJob ? [world.searchJob] : []);
      return jsonResponse(200, []);
    }
    if (table === "course_maps") return jsonResponse(200, method === "GET" ? [world.course || COURSE] : []);
    if (table === "course_scorecards") return jsonResponse(200, world.cards || []);
    return jsonResponse(200, []);
  };
  return calls;
}

function routineOn() {
  process.env.CLAUDE_MAPPER_ROUTINE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01TEST/fire";
  process.env.CLAUDE_MAPPER_ROUTINE_TOKEN = "sk-ant-oat01-stub";
}

async function runWorker() {
  await worker.run(new Request("https://clarity.test/.netlify/functions/course-mapper-worker-background", { method: "POST", body: "{}" }));
}

test("greens and fairways but no card: the scan is parked, a card search is queued, no debug fires", async () => {
  routineOn();
  const calls = stubWorld({ elements: greensAndFairways(18), job: { id: "scan-1", course_id: COURSE.course_id, kind: "automap", status: "queued", requested_by: "user:x", result: null } });
  await runWorker();
  const failed = calls.jobPatches.find(p => p.body.status === "failed");
  assert.ok(failed, "the scan still ends failed");
  assert.match(failed.body.error, /no numbered hole geometry/);
  assert.strictEqual(failed.body.result.awaitingCard, true);
  assert.strictEqual(failed.body.result.debugHeld, true, "a player's scan holds its debug");
  assert.ok(failed.body.result.cardJob, "the queued search is linked");
  assert.deepStrictEqual(calls.jobInserts.filter(r => r.kind === "resolve_scorecards").map(r => [r.course_id, r.requested_by]),
    [[COURSE.course_id, "awaiting-card"]]);
  assert.strictEqual(calls.fires, 0, "no debug session while a card may still come");
});

test("a card search already queued for the course is reused, not doubled", async () => {
  const calls = stubWorld({ elements: greensAndFairways(18), openSearch: [{ id: "search-open" }], job: { id: "scan-2", course_id: COURSE.course_id, kind: "nearby_automap", status: "queued", requested_by: "nearby:x", result: null } });
  await runWorker();
  const failed = calls.jobPatches.find(p => p.body.status === "failed");
  assert.strictEqual(failed.body.result.cardJob, "search-open");
  assert.strictEqual(failed.body.result.debugHeld, false, "a background scan has no debug to hold");
  assert.strictEqual(calls.jobInserts.filter(r => r.kind === "resolve_scorecards").length, 0);
});

test("no golf in OSM at all: failed for good, not parked", async () => {
  routineOn();
  /* Somewhere else: the Overpass client caches by query, and Limuru's answer is greens. */
  const course = Object.assign({}, COURSE, { course_id: "migaa-golf-estate", course_name: "Migaa Golf Estate", course_lat: -1.1236, course_lng: 36.8372 });
  const calls = stubWorld({ course, elements: [], job: { id: "scan-3", course_id: course.course_id, kind: "automap", status: "queued", requested_by: "user:x", result: null } });
  await runWorker();
  const failed = calls.jobPatches.find(p => p.body.status === "failed");
  assert.ok(!failed.body.result.awaitingCard, JSON.stringify(failed.body.result.diagnostics.osmFeatures) + " " + failed.body.error);
  assert.strictEqual(calls.jobInserts.filter(r => r.kind === "resolve_scorecards").length, 0);
});

test("a parked scan whose course now has a card is queued again, as the same kind, and unparked", async () => {
  const parked = { id: "scan-1", course_id: COURSE.course_id, kind: "automap", error: "no numbered hole geometry", result: { awaitingCard: true, debugHeld: true, cardJob: "search-1", attempts: 1 } };
  const card = { course_key: "limuru country club", holes_json: [{ hole: 1, par: 4 }], source: "golfpass" };
  const calls = stubWorld({ waiting: [parked], cards: [card] });
  await worker.requeueMapsAwaitingCards();
  assert.deepStrictEqual(calls.jobInserts.map(r => [r.course_id, r.kind, r.status, r.requested_by, r.result.rerunOf]),
    [[COURSE.course_id, "automap", "queued", "card-arrived", "scan-1"]]);
  const unparked = calls.jobPatches.find(p => p.rest.includes("id=eq.scan-1"));
  assert.strictEqual(unparked.body.result.awaitingCard, false, "queued once, never again");
  assert.ok(unparked.body.result.cardRerunJob);
  assert.strictEqual(calls.fires, 0);
});

test("no card yet and the search still running: nothing happens", async () => {
  const parked = { id: "scan-1", course_id: COURSE.course_id, kind: "automap", result: { awaitingCard: true, debugHeld: true, cardJob: "search-1" } };
  const calls = stubWorld({ waiting: [parked], cards: [], searchJob: { status: "running" } });
  await worker.requeueMapsAwaitingCards();
  assert.strictEqual(calls.jobInserts.length, 0);
  assert.strictEqual(calls.jobPatches.length, 0);
  assert.strictEqual(calls.fires, 0);
});

test("the card search came back empty: the held debug fires once and the scan keeps waiting", async () => {
  routineOn();
  const parked = { id: "scan-1", course_id: COURSE.course_id, kind: "automap", error: "no numbered hole geometry found", result: { awaitingCard: true, debugHeld: true, cardJob: "search-1", attempts: 1, diagnostics: { centre: { lat: -1.1339, lng: 36.6734 } } } };
  const calls = stubWorld({ waiting: [parked], cards: [], searchJob: { status: "done" } });
  await worker.requeueMapsAwaitingCards();
  assert.strictEqual(calls.jobInserts.length, 0, "no re-run without a card");
  const patch = calls.jobPatches.find(p => p.rest.includes("id=eq.scan-1"));
  assert.strictEqual(patch.body.result.debugHeld, false, "fired once");
  assert.strictEqual(patch.body.result.awaitingCard, true, "a card from an upload or an AI ask still re-runs it");
  assert.ok(patch.body.result.failureKind, "the debug outcome is recorded");
});

let worker = null;
(async () => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
  process.env.TREE_BACKFILL = "off";
  process.env.SCORECARD_BACKFILL = "off";
  const mod = await import(path.join(root, "functions", "course-mapper-worker-background.mjs"));
  worker = Object.assign({ run: mod.default }, mod.__courseMapperWorkerTest);
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
  }
  console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " awaiting-card checks");
  process.exit(failed ? 1 : 0);
})();
