/* The scorecard run on the mapper queue (resolve_scorecards in
 * functions/course-mapper-worker-background.mjs) and the backfill that queues it.
 *
 * Load-bearing assertions:
 *   - a facility whose cards are all stored is named from them without a search
 *   - a facility with no card and nothing findable reports the shortfall, writes no card and
 *     renames nothing
 *   - the backfill queues one job per uncovered facility, against its pinned course, skipping
 *     facilities covered by facility_key, by a course's own name key, or tried this month
 *   - SCORECARD_BACKFILL=off queues nothing
 *
 * Supabase and the site's own scorecard-search function are stubbed at the fetch layer, so
 * the suite is hermetic: the search returns no candidates, so no page is ever fetched.
 *
 * Run: node dev/course-scorecard-job.test.js */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } };
}

/* Same geometry trick as dev/course-scorecard-update.test.js: a tee and a green on one
   longitude make the published length exactly the card's metres. */
function metresToDegLat(m) { return m / 111320; }
function geometryFromLengths(lengths) {
  const objects = {};
  Object.keys(lengths).forEach(holeStr => {
    const hole = Number(holeStr);
    const lat0 = -36.18 + hole * 0.001;
    objects["tee-" + hole] = { id: "tee-" + hole, type: "tee", holeNumber: hole, position: { lat: lat0, lng: 174.66 } };
    objects["green-" + hole] = { id: "green-" + hole, type: "green", holeNumber: hole, position: { lat: lat0 + metresToDegLat(lengths[hole]), lng: 174.66 } };
  });
  return objects;
}
const NORTH_PARS = [4, 3, 4, 4, 4, 4, 3, 4, 5, 4, 5, 3, 4, 5, 3, 4, 3, 5];
const SOUTH_PARS = [5, 4, 4, 4, 3, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 4, 3, 5];
function cardFromPars(name, pars, baseMetres) {
  const holes = pars.map((par, i) => ({ hole: i + 1, par, distanceM: baseMetres + (par - 4) * 60 + i * 3 }));
  return { name, source: "golfpass", sourceUrl: "https://example.com/" + name.toLowerCase().replace(/[^a-z]+/g, "-"), holes };
}
const NORTH_CARD = cardFromPars("Te Arai Links - North Course", NORTH_PARS, 360);
const SOUTH_CARD = cardFromPars("Te Arai Links - South Course", SOUTH_PARS, 380);
function lengthsFromCard(card) { const l = {}; card.holes.forEach(h => { l[h.hole] = h.distanceM; }); return l; }
function scorecardRow(card, facilityKey) {
  return {
    course_key: card.name.trim().replace(/\s+/g, " ").toLowerCase(), course_name: card.name, facility_key: facilityKey,
    source: card.source, source_url: card.sourceUrl, hole_count: card.holes.length, holes_json: card.holes, sources_json: []
  };
}
function place(row) {
  return Object.assign({ course_lat: -36.18, course_lng: 174.66, region: "Auckland", country: "New Zealand", country_code: "NZ", course_aliases: [], holes_json: {} }, row);
}

function stub(world) {
  const calls = { searches: 0, scorecardWrites: [], mapPatches: [], jobInserts: [], jobPatches: [], reads: [] };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.includes("/.netlify/functions/scorecard-search")) { calls.searches++; return jsonResponse(200, { results: [] }); }
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (method === "GET") calls.reads.push(rest);
    if (table === "course_maps") {
      const maps = world.maps || [];
      if (method === "PATCH") {
        const id = decodeURIComponent(rest.match(/course_id=eq\.([^&]+)/)[1]);
        const body = JSON.parse(options.body || "{}");
        calls.mapPatches.push({ courseId: id, body });
        const row = maps.find(m => m.course_id === id);
        if (row) Object.assign(row, body);
        return jsonResponse(200, [row].filter(Boolean));
      }
      if (rest.includes("course_id=eq.")) {
        const id = decodeURIComponent(rest.match(/course_id=eq\.([^&]+)/)[1]);
        return jsonResponse(200, maps.filter(m => m.course_id === id));
      }
      if (rest.includes("facility_key=eq.")) {
        const key = decodeURIComponent(rest.match(/facility_key=eq\.([^&]+)/)[1]);
        return jsonResponse(200, maps.filter(m => m.facility_key === key && m.published));
      }
      return jsonResponse(200, maps.filter(m => m.published));
    }
    if (table === "course_scorecards") {
      if (method === "POST") { calls.scorecardWrites.push(JSON.parse(options.body || "[]")); return jsonResponse(201, []); }
      return jsonResponse(200, world.scorecards || []);
    }
    if (table === "course_mapper_jobs") {
      if (method === "POST") {
        const rows = JSON.parse(options.body || "[]");
        calls.jobInserts.push(...rows);
        return jsonResponse(201, rows.map((row, i) => Object.assign({ id: "new-" + i }, row)));
      }
      if (method === "PATCH") {
        calls.jobPatches.push({ rest, body: JSON.parse(options.body || "{}") });
        const id = (rest.match(/id=eq\.([^&]+)/) || [])[1];
        const queued = calls.jobInserts[Number(String(id || "").replace("new-", ""))];
        return jsonResponse(200, queued ? [Object.assign({ id }, queued, { status: "running" })] : []);
      }
      if (rest.includes("created_at=gt.")) return jsonResponse(200, world.tried || []);
      if (rest.includes("id=eq.")) {
        const id = rest.match(/id=eq\.([^&]+)/)[1];
        const queued = calls.jobInserts[Number(id.replace("new-", ""))];
        return jsonResponse(200, queued ? [Object.assign({ id }, queued)] : []);
      }
      return jsonResponse(200, []);
    }
    return jsonResponse(200, []);
  };
  return calls;
}

function teArai() {
  return [
    place({ course_id: "te-arai", course_name: "Te Arai Links - Course 1", facility_key: "te-arai", published: true, objects_json: geometryFromLengths(lengthsFromCard(NORTH_CARD)) }),
    place({ course_id: "te-arai-course-2", course_name: "Te Arai Links - Course 2", facility_key: "te-arai", published: true, objects_json: geometryFromLengths(lengthsFromCard(SOUTH_CARD)) })
  ];
}

test("a facility whose cards are all stored is named from them, with no search", async () => {
  const maps = teArai();
  const calls = stub({ maps, scorecards: [scorecardRow(NORTH_CARD, "te-arai"), scorecardRow(SOUTH_CARD, "te-arai")] });
  const out = await worker.runScorecardJob({ id: "j", course_id: "te-arai-course-2", kind: "resolve_scorecards", requested_by: "scorecard-backfill" }, "https://clarity.example");
  assert.strictEqual(out.kind, "resolve_scorecards");
  assert.strictEqual(out.want, 2);
  assert.strictEqual(out.distinct, 2);
  assert.strictEqual(out.resolved, true);
  assert.strictEqual(out.searched, false, "nothing to look for");
  assert.strictEqual(calls.searches, 0);
  assert.deepStrictEqual(out.renamed.map(r => r.to).sort(), [NORTH_CARD.name, SOUTH_CARD.name].sort());
  assert.strictEqual(maps[0].course_name, NORTH_CARD.name);
  assert.strictEqual(maps[1].course_name, SOUTH_CARD.name);
  calls.mapPatches.forEach(patch => {
    ["course_id", "facility_key", "objects_json", "holes_json"].forEach(field => assert.ok(!(field in patch.body), field + " is never in a rename"));
  });
  assert.strictEqual(out.visualsTouched, false);
  assert.strictEqual(out.holeGeometryTouched, false);
});

test("no card stored and nothing findable: the shortfall is reported, nothing written, nothing renamed", async () => {
  const maps = [place({ course_id: "pupuke", course_name: "Pupuke Golf Club", facility_key: null, published: true, objects_json: {} })];
  const calls = stub({ maps, scorecards: [] });
  const out = await worker.runScorecardJob({ id: "j", course_id: "pupuke", kind: "resolve_scorecards" }, "https://clarity.example");
  assert.strictEqual(out.want, 1);
  assert.strictEqual(out.distinct, 0);
  assert.strictEqual(out.searched, true);
  assert.strictEqual(out.stored, false);
  assert.ok(calls.searches >= 1, "the site's search was asked");
  assert.ok(out.message.includes("0 of 1"), out.message);
  assert.strictEqual(calls.scorecardWrites.length, 0);
  assert.strictEqual(calls.mapPatches.length, 0);
  assert.strictEqual(maps[0].course_name, "Pupuke Golf Club");
  const stages = calls.jobPatches.map(p => p.body.result && p.body.result.progress && p.body.result.progress.stage).filter(Boolean);
  assert.deepStrictEqual(stages, ["resolving-scorecard", "naming-courses"], "the bar's stages, in order");
});

test("the backfill queues the first uncovered facility against its pinned course, skipping covered and recently tried ones", async () => {
  const maps = [
    { course_id: "a", course_name: "A Golf Club", facility_key: "a", published: true },
    { course_id: "b", course_name: "B Golf Club", facility_key: null, published: true },
    { course_id: "c", course_name: "C Links - Course 1", facility_key: "c", published: true },
    { course_id: "c-course-2", course_name: "C Links - Course 2", facility_key: "c", published: true },
    { course_id: "d", course_name: "D Golf Club", facility_key: "d", published: true },
    { course_id: "e-course-2", course_name: "E Golf Club - Course 2", facility_key: "e", published: true }
  ];
  const scorecards = [
    { course_key: "a golf club", facility_key: "a", hole_count: 18 },
    /* Stored before facility_key existed: covers b by its own name key. */
    { course_key: "b golf club", facility_key: null, hole_count: 18 }
  ];
  let calls = stub({ maps, scorecards, tried: [{ course_id: "c-course-2" }] });
  let job = await worker.claimScorecardBackfill();
  assert.deepStrictEqual(calls.jobInserts.map(r => [r.course_id, r.kind, r.requested_by]), [["d", "resolve_scorecards", "scorecard-backfill"]],
    "a covered by facility, b by name, c tried this month on a sibling: d is next");
  assert.strictEqual(job && job.course_id, "d");
  assert.ok(calls.reads.some(rest => rest.startsWith("course_scorecards?") && rest.includes("hole_count=gt.0")), "an empty card covers nothing");

  calls = stub({ maps, scorecards: scorecards.concat([{ course_key: "d golf club", facility_key: "d", hole_count: 18 }]), tried: [{ course_id: "c-course-2" }] });
  job = await worker.claimScorecardBackfill();
  assert.deepStrictEqual(calls.jobInserts.map(r => r.course_id), ["e-course-2"], "a facility whose pinned row is not published is run on the sibling that is");

  calls = stub({ maps, scorecards, tried: [] });
  job = await worker.claimScorecardBackfill();
  assert.strictEqual(job && job.course_id, "c", "a multi-course facility is queued once, on its pinned course");
});

test("SCORECARD_BACKFILL=off queues nothing", async () => {
  process.env.SCORECARD_BACKFILL = "off";
  try {
    const calls = stub({ maps: [{ course_id: "a", course_name: "A", facility_key: "a", published: true }], scorecards: [] });
    assert.strictEqual(await worker.claimScorecardBackfill(), null);
    assert.strictEqual(calls.jobInserts.length, 0);
    assert.strictEqual(calls.reads.length, 0, "nothing is even read");
  } finally {
    delete process.env.SCORECARD_BACKFILL;
  }
});

let worker = null;
(async () => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
  worker = (await import(path.join(root, "functions", "course-mapper-worker-background.mjs"))).__courseMapperWorkerTest;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
  }
  console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " scorecard job checks");
  process.exit(failed ? 1 : 0);
})();
