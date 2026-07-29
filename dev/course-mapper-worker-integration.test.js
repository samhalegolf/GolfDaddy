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

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stubWorld({ mapRow, patches }) {
  /* Mutable so GET/PATCH agree on job.status across the worker's claim/finish calls -
     otherwise claimJob's "status=eq.queued" filter has nothing real to check against and the
     worker's claim-then-loop-again pattern never terminates. */
  const job = { id: "job-1", course_id: "pupuke", kind: "automap", status: "queued" };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.startsWith("https://overpass-api.de/")) return jsonResponse(200, fixture);
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
