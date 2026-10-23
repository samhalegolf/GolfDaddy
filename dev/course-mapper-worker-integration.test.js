/* course-mapper-worker-background: the real pipeline (stage 3 of the migration plan) -
 * claim a job, look up the course's center point in course_maps, fetch OSM geometry, resolve
 * it, and write objects_json/holes_json/geometry_version back. Both Supabase and Overpass are
 * stubbed at the fetch layer using the same saved fixture as dev/automapper-core.test.js, so
 * this is hermetic and does not depend on network access or a live worker deploy. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "overpass-two-hole-course.json"), "utf8"));
const unnumberedFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "geometry-resolver-two-hole-course.json"), "utf8"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stubWorld({ mapRow, patches, osmFixture, scorecardRow }) {
  /* Mutable so GET/PATCH agree on job.status across the worker's claim/finish calls -
     otherwise claimJob's "status=eq.queued" filter has nothing real to check against and the
     worker's claim-then-loop-again pattern never terminates. */
  const job = { id: "job-1", course_id: "pupuke", kind: "automap", status: "queued" };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.startsWith("https://overpass-api.de/")) return jsonResponse(200, osmFixture || fixture);
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (table === "course_mapper_jobs") {
      if (method === "GET") return jsonResponse(200, rest.includes("status=eq.queued") && job.status === "queued" ? [Object.assign({}, job)] : []);
      if (method === "PATCH") {
        const body = JSON.parse(options.body || "{}");
        if (rest.includes("status=eq.queued") && job.status !== "queued") return jsonResponse(200, []);
        Object.assign(job, body);
        patches.push({ table, body });
        return jsonResponse(200, [Object.assign({}, job)]);
      }
    }
    if (table === "course_maps") {
      if (method === "GET") return jsonResponse(200, mapRow ? [mapRow] : []);
      if (method === "PATCH") { patches.push({ table, body: JSON.parse(options.body || "{}") }); return jsonResponse(200, [{ course_id: "pupuke" }]); }
    }
    if (table === "course_scorecards") {
      if (method === "GET") return jsonResponse(200, scorecardRow ? [scorecardRow] : []);
    }
    return jsonResponse(200, []);
  };
}

let worker = null;

test("a job for a course with a known center resolves geometry and writes it back", async () => {
  const patches = [];
  stubWorld({ mapRow: { course_id: "pupuke", course_name: "Pupuke", course_lat: -36.8, course_lng: 174.702, objects_json: {}, holes_json: {} }, patches });
  await worker.default({ json: async () => ({ jobId: "job-1" }) });
  const jobPatches = patches.filter(p => p.table === "course_mapper_jobs");
  const mapPatches = patches.filter(p => p.table === "course_maps");
  assert.ok(mapPatches.length >= 1, "geometry should be written to course_maps");
  const geometryWrite = mapPatches[mapPatches.length - 1].body;
  assert.strictEqual(Object.keys(geometryWrite.objects_json).length > 0, true);
  assert.strictEqual(Object.keys(geometryWrite.holes_json).length, 2);
  assert.ok(geometryWrite.geometry_version, "geometry_version travels with the write so future jobs can dedupe against it");
  const finalStatus = jobPatches.find(p => p.body.status === "done");
  assert.ok(finalStatus, "the job should finish as done, not failed");
});

test("a job for a course with no known center fails clearly instead of guessing", async () => {
  const patches = [];
  stubWorld({ mapRow: null, patches });
  await worker.default({ json: async () => ({ jobId: "job-1" }) });
  const jobPatches = patches.filter(p => p.table === "course_mapper_jobs");
  const failed = jobPatches.find(p => p.body.status === "failed");
  assert.ok(failed, "no course_maps row with a center means the job cannot run - it must fail, not silently no-op");
  assert.ok(String(failed.body.error).includes("no known location"));
  assert.deepStrictEqual(patches.filter(p => p.table === "course_maps"), [], "no geometry write should happen without a center");
});

test("OSM shapes with no hole numbers fall through to the geometry resolver, which numbers them from a shared scorecard", async () => {
  const patches = [];
  stubWorld({
    mapRow: { course_id: "pupuke", course_name: "Pupuke Golf Club", course_lat: -37.11, course_lng: 175.01, objects_json: {}, holes_json: {} },
    patches,
    osmFixture: unnumberedFixture,
    scorecardRow: {
      holes_json: [
        { hole: 1, par: 5, metres: 400 },
        { hole: 2, par: 3, metres: 150 }
      ],
      source: "website", source_url: "https://example.test/scorecard", sources_json: []
    }
  });
  await worker.default({ json: async () => ({ jobId: "job-1" }) });
  const jobPatches = patches.filter(p => p.table === "course_mapper_jobs");
  const mapPatches = patches.filter(p => p.table === "course_maps");
  const finalStatus = jobPatches.find(p => p.body.status === "done");
  assert.ok(finalStatus, "the job should finish as done via the geometry resolver, not failed");
  assert.ok(finalStatus.body.result.resolverStatus, "the geometry resolver's outcome is recorded on the job");
  assert.ok(mapPatches.length >= 1, "resolver-sourced geometry should still be written to course_maps");
  const geometryWrite = mapPatches[mapPatches.length - 1].body;
  assert.ok(Object.keys(geometryWrite.holes_json).length >= 1, "at least one hole was numbered by the geometry resolver");
});

test("OSM shapes with no hole numbers and no shared scorecard fail clearly, not silently", async () => {
  const patches = [];
  stubWorld({
    mapRow: { course_id: "pupuke", course_name: "Pupuke Golf Club", course_lat: -37.22, course_lng: 175.02, objects_json: {}, holes_json: {} },
    patches,
    osmFixture: unnumberedFixture,
    scorecardRow: null
  });
  await worker.default({ json: async () => ({ jobId: "job-1" }) });
  const jobPatches = patches.filter(p => p.table === "course_mapper_jobs");
  const failed = jobPatches.find(p => p.body.status === "failed");
  assert.ok(failed, "no scorecard means the resolver cannot number the geometry, and the job must say so");
  assert.ok(String(failed.body.error).includes("no shared scorecard found"));
});

/* Yarra Bend, 2026-10-23: its own holes drawn but not numbered, and the only numbered golf in
   the sweep a neighbouring par 3 in an outline of its own. The par 3 must not publish as
   Yarra Bend, and it must not stop Yarra Bend's own ground being numbered from its card. */
function besideNumberedParThree() {
  const ring = (south, west, north, east) => [
    { lat: south, lon: west }, { lat: north, lon: west }, { lat: north, lon: east }, { lat: south, lon: east }, { lat: south, lon: west }
  ];
  const parThrees = Array.from({ length: 9 }, (_, i) => ({
    type: "way", id: 900 + i, tags: { golf: "hole", ref: String(i + 1), par: "3" },
    geometry: [{ lat: -0.0115 + i * 0.0003, lon: 0.0005 }, { lat: -0.0113 + i * 0.0003, lon: 0.0012 }]
  }));
  return {
    elements: unnumberedFixture.elements.concat(
      { type: "way", id: 801, tags: { leisure: "golf_course", name: "Yarra Bend Golf Course" }, geometry: ring(-0.002, -0.003, 0.014, 0.003) },
      { type: "way", id: 802, tags: { leisure: "golf_course", name: "Studley Park Golf Course" }, geometry: ring(-0.013, -0.001, -0.008, 0.003) },
      parThrees
    )
  };
}

test("a numbered par 3 next door is set aside and the course's own unnumbered ground is resolved from its card", async () => {
  const patches = [];
  stubWorld({
    mapRow: { course_id: "pupuke", course_name: "Yarra Bend Golf Course", course_lat: 0.005, course_lng: 0, objects_json: {}, holes_json: {} },
    patches,
    osmFixture: besideNumberedParThree(),
    scorecardRow: {
      holes_json: [
        { hole: 1, par: 5, metres: 400 },
        { hole: 2, par: 3, metres: 150 }
      ],
      source: "website", source_url: "https://example.test/scorecard", sources_json: []
    }
  });
  await worker.default({ json: async () => ({ jobId: "job-1" }) });
  const jobPatches = patches.filter(p => p.table === "course_mapper_jobs");
  const finalStatus = jobPatches.find(p => p.body.status === "done");
  const failed = jobPatches.find(p => p.body.status === "failed");
  assert.ok(finalStatus, "the job should finish as done, not refuse: " + (failed && failed.body.error));
  const diagnostics = finalStatus.body.result.diagnostics;
  assert.strictEqual(diagnostics.foreignGround.holesOutline.name, "Studley Park Golf Course");
  assert.strictEqual(diagnostics.foreignGround.setAside, true);
  assert.ok(finalStatus.body.result.queryStages.includes("neighbour-set-aside"));
  assert.strictEqual(finalStatus.body.result.resolverStatus.trigger, "no-osm-numbering");
  const ownWrite = patches.filter(p => p.table === "course_maps" && p.body.holes_json && Object.keys(p.body.holes_json).length === 2).pop();
  assert.ok(ownWrite, "Yarra Bend's own two holes are written, numbered from its card");
});

test("a numbered neighbour beside an outline holding nothing of its own still refuses", async () => {
  const patches = [];
  const world = besideNumberedParThree();
  world.elements = world.elements.filter(element => !(element.tags && element.tags.golf === "green") && !(element.tags && element.tags.golf === "fairway"));
  stubWorld({
    /* A pin of its own: the worker caches Overpass answers by query, and the same pin
       would be handed the world above, greens and all. */
    mapRow: { course_id: "pupuke", course_name: "Yarra Bend Golf Course", course_lat: 0.006, course_lng: 0, objects_json: {}, holes_json: {} },
    patches,
    osmFixture: world,
    scorecardRow: null
  });
  await worker.default({ json: async () => ({ jobId: "job-1" }) });
  const failed = patches.filter(p => p.table === "course_mapper_jobs").find(p => p.body.status === "failed");
  assert.ok(failed, "nothing of this course's own to number: the run refuses");
  assert.ok(String(failed.body.error).includes("course-outline-names-another-club"), failed.body.error);
});

(async function run() {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  worker = await import(path.join(root, "functions", "course-mapper-worker-background.mjs"));
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
    console.error("course-mapper-worker-integration FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-mapper-worker-integration passed: " + tests.length + " checks");
})();
