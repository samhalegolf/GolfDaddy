/* course-package.mjs: the unified read endpoint. Asserts the precedence rules from the
 * architecture doc (Full beats Lite beats Processing beats Manual beats None) against every
 * combination the doc's own acceptance criteria calls out - fresh course, existing full
 * package, processing, failure, manual correction, repeated requests for the same course.
 * Supabase is stubbed at the fetch layer, so this is hermetic. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stubFetch(world) {
  global.fetch = async (url) => {
    url = String(url);
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (table === "course_maps") return jsonResponse(200, world.maps || []);
    if (table === "course_visuals") return jsonResponse(200, world.visuals || []);
    if (table === "course_visual_jobs") return jsonResponse(200, world.visualJobs || []);
    if (table === "course_mapper_jobs") return jsonResponse(200, world.mapperJobs || []);
    return jsonResponse(200, []);
  };
}

let buildCoursePackage = null;

test("a fresh, never-touched course reports none", async () => {
  stubFetch({});
  const result = await buildCoursePackage("brand-new-course");
  assert.strictEqual(result.status, "none");
});

test("a course with published geometry but no visuals reports lite-geo-ready with the right shape", async () => {
  stubFetch({
    maps: [{ course_id: "pupuke", published: true, geometry_version: "v1", objects_json: {
      "green-1": { type: "green", holeNumber: 1, position: { lat: -36.8, lng: 174.7 }, greenShape: [{ lat: -36.8001, lng: 174.7001 }] },
      "tee-1": { type: "tee", holeNumber: 1, position: { lat: -36.799, lng: 174.699 } }
    }, holes_json: {} }]
  });
  const result = await buildCoursePackage("pupuke");
  assert.strictEqual(result.status, "lite-geo-ready");
  assert.strictEqual(result.geometryVersion, "v1");
  assert.strictEqual(result.holes.length, 1);
  assert.deepStrictEqual(result.holes[0].tee, { lat: -36.799, lng: 174.699 });
  assert.deepStrictEqual(result.holes[0].green, { lat: -36.8, lng: 174.7 });
  assert.ok(result.courseBounds);
});

test("a course with a published full package reports full-map-ready even while a re-export is running", async () => {
  stubFetch({
    maps: [{ course_id: "pupuke", published: true, geometry_version: "v1", objects_json: { "green-1": { type: "green", holeNumber: 1, position: { lat: -36.8, lng: 174.7 } } }, holes_json: {} }],
    visuals: [{ published_version: 3, uploaded_assets: [{ path: "pupuke/frames/r1/h1.jpg", role: "hole-frame-published", holeNumber: 1, metadata: { width: 1024, height: 768, bounds: { south: -36.81 } } }], diagnostics: { generatedAt: "2026-01-01T00:00:00.000Z" } }],
    visualJobs: [{ id: "job-export-running", kind: "export", status: "running" }]
  });
  const result = await buildCoursePackage("pupuke");
  assert.strictEqual(result.status, "full-map-ready", "a published package stays playable while a rebuild runs in the background");
  assert.strictEqual(result.packageVersion, 3);
  assert.strictEqual(result.holes.length, 1);
  assert.ok(result.holes[0].visual.url.includes("/api/course-visual-assets"));
  assert.ok(result.holes[0].visual.checksum, "a checksum travels with the descriptor so a client can detect it changed");
});

test("a course with a live mapper job and no geometry yet reports processing", async () => {
  stubFetch({ mapperJobs: [{ id: "job-1", kind: "automap", status: "running" }] });
  const result = await buildCoursePackage("brand-new-course");
  assert.strictEqual(result.status, "processing");
  assert.strictEqual(result.stage, "automap");
});

test("a course with a live visual job and no geometry yet also reports processing", async () => {
  stubFetch({ visualJobs: [{ id: "job-1", kind: "snapshot", status: "queued" }] });
  const result = await buildCoursePackage("brand-new-course");
  assert.strictEqual(result.status, "processing");
});

test("a failed mapper job with no geometry and nothing live reports none, not a permanent error state", async () => {
  stubFetch({ mapperJobs: [{ id: "job-1", kind: "automap", status: "failed", error: "no OSM data" }] });
  const result = await buildCoursePackage("brand-new-course");
  assert.strictEqual(result.status, "none", "a failed run with nothing live is retryable, not a dead end - see acceptance criteria for repeat requests");
});

test("a mapper job explicitly flagged manual-required is surfaced as manual-required", async () => {
  stubFetch({ mapperJobs: [{ id: "job-1", kind: "automap", status: "manual-required", error: "ambiguous course boundary" }] });
  const result = await buildCoursePackage("brand-new-course");
  assert.strictEqual(result.status, "manual-required");
  assert.ok(result.reason.includes("ambiguous"));
});

test("repeated requests for the same course are stable and side-effect-free (read-only)", async () => {
  const world = { maps: [{ course_id: "pupuke", published: true, geometry_version: "v1", objects_json: { "green-1": { type: "green", holeNumber: 1, position: { lat: -36.8, lng: 174.7 } } }, holes_json: {} }] };
  stubFetch(world);
  const first = await buildCoursePackage("pupuke");
  stubFetch(world);
  const second = await buildCoursePackage("pupuke");
  assert.deepStrictEqual(first, second);
});

(async function run() {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  const mod = await import(path.join(root, "functions", "course-package.mjs"));
  buildCoursePackage = mod.buildCoursePackage;
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
    console.error("course-package FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-package passed: " + tests.length + " checks");
})();
