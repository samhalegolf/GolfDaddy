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

/* ---- the pin lifecycle ----
 *
 * `fit` is the mapper's verdict on the coordinate it was handed, and it is the ONLY thing that
 * puts the pin screen in front of a player (see dev/course-pin-trust.test.js). These four
 * cases are the repeating pin prompt: a course that had one bad run, was pinned, mapped
 * successfully, and then asked for a pin again on every single open - because a dead verdict
 * from the first run outlived every run after it and rode out on a ready package. */

const GROUND_REFUSAL = { trusted: false, scope: "ground", reason: "multiple-courses", message: "There look to be several courses here." };

test("a refusal is reported, so the one case the pin exists for can still reach the player", async () => {
  stubFetch({ mapperJobs: [{ id: "j1", kind: "automap", status: "failed", error: "could not tell which course this is", result: { fit: GROUND_REFUSAL } }] });
  const result = await buildCoursePackage("balgove");
  assert.strictEqual(result.status, "failed");
  assert.strictEqual(result.fit.scope, "ground", "without this the pin is unreachable in the only situation it repairs");
});

test("a refusal saved by the worker's catch handler is found too", async () => {
  stubFetch({ mapperJobs: [{ id: "j1", kind: "automap", status: "failed", error: "refused", result: { diagnostics: { fit: GROUND_REFUSAL } } }] });
  assert.strictEqual((await buildCoursePackage("balgove")).fit.reason, "multiple-courses");
});

test("a course that HAS a map never carries a verdict, whatever its job history says", async () => {
  /* The bug, exactly. Run 1 refused. The player pinned the course and run 2 mapped it. The
     package is lite-geo-ready - there is geometry, there is somewhere to play - and it used to
     come back carrying run 1's refusal anyway, which the picker reads as "the ground was
     wrong" and answers with the pin screen. Every open. Forever. */
  stubFetch({
    maps: [{ course_id: "southport", published: true, geometry_version: "v1", objects_json: {
      "green-1": { type: "green", holeNumber: 1, position: { lat: 53.64, lng: -3.02 } },
      "tee-1": { type: "tee", holeNumber: 1, position: { lat: 53.641, lng: -3.021 } }
    }, holes_json: {} }],
    mapperJobs: [
      { id: "j2", kind: "automap", status: "succeeded", result: { holes: 18 } },
      { id: "j1", kind: "automap", status: "failed", error: "could not tell which course this is", result: { fit: GROUND_REFUSAL } }
    ]
  });
  const result = await buildCoursePackage("southport");
  assert.strictEqual(result.status, "lite-geo-ready");
  assert.strictEqual(result.fit, undefined, "published geometry is a better answer about the ground than any old verdict");
});

test("the newest settled run speaks for the course, not the oldest one that had an opinion", async () => {
  /* Even with nothing published yet: a later run that reached a verdict has already answered
     the question the earlier one asked. Scanning the window for anything carrying a fit meant
     the earliest refusal won permanently. */
  stubFetch({
    mapperJobs: [
      { id: "j2", kind: "automap", status: "failed", error: "no OSM hole geometry within range", result: { fit: { trusted: true } } },
      { id: "j1", kind: "automap", status: "failed", error: "refused", result: { fit: GROUND_REFUSAL } }
    ]
  });
  const result = await buildCoursePackage("southport");
  assert.strictEqual(result.status, "failed");
  assert.strictEqual(result.fit, undefined, "the latest run trusted the coordinate - a thin map is not a reason to ask for a pin");
});

test("a run still in flight has no verdict, and an older one may not stand in for it", async () => {
  stubFetch({
    mapperJobs: [
      { id: "j2", kind: "automap", status: "running" },
      { id: "j1", kind: "automap", status: "failed", error: "refused", result: { fit: GROUND_REFUSAL } }
    ]
  });
  const result = await buildCoursePackage("southport");
  assert.strictEqual(result.status, "processing", "a live job is the state, and processing never carries a fit");
  assert.strictEqual(result.fit, undefined);
});

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

test("a failed mapper job with no geometry and nothing live reports failed with the job's error", async () => {
  /* This used to assert "none" ("a failed run is retryable, not a dead end"). That reading
     let buildCoursePackageWithTrigger re-enqueue the same doomed job on every poll of a
     fast-failing course, which on 2026-08-18 burned the per-user auto rate limit in 40s and
     starved every later scan of a mapper job. Failed is terminal now; retrying is a
     deliberate POST to /api/course-mapper-jobs (the mapping flyout's Auto tool / remap). */
  stubFetch({ mapperJobs: [{ id: "job-1", kind: "automap", status: "failed", error: "no OSM data" }] });
  const result = await buildCoursePackage("brand-new-course");
  assert.strictEqual(result.status, "failed");
  assert.ok(result.reason.includes("no OSM data"), "the job's error travels as reason so debug reports can show it");
});

test("a failed job is outranked by a newer live run - a retry reports processing, not failed", async () => {
  stubFetch({ mapperJobs: [
    { id: "job-2", kind: "automap", status: "queued" },
    { id: "job-1", kind: "automap", status: "failed", error: "no OSM data" }
  ] });
  const result = await buildCoursePackage("brand-new-course");
  assert.strictEqual(result.status, "processing");
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

/* ---------- OSM course surfaces in the package ------------------------------------------- */

const surfaceObjects = () => ({
  "tee-1": { id: "tee-1", type: "tee", holeNumber: 1, position: { lat: 36.0, lng: 174.0 } },
  "green-1": { id: "green-1", type: "green", holeNumber: 1, position: { lat: 36.0, lng: 174.003 },
    shape: [{ lat: 36.0, lng: 174.003 }, { lat: 36.0001, lng: 174.003 }, { lat: 36.0001, lng: 174.0031 }] },
  "bunker-1": { id: "bunker-1", type: "bunker", holeNumber: 1, osmId: "way/30", source: "osm_auto_surface",
    position: { lat: 36.0, lng: 174.0028 },
    shape: [{ lat: 36.0, lng: 174.0028 }, { lat: 36.0001, lng: 174.0028 }, { lat: 36.0001, lng: 174.0029 }] },
  "water-1": { id: "water-1", type: "water", holeNumber: 1, hazardClass: "penalty_area", osmId: "way/31",
    position: { lat: 36.0, lng: 174.0015 },
    shape: [{ lat: 36.0, lng: 174.0015 }, { lat: 36.0002, lng: 174.0015 }, { lat: 36.0002, lng: 174.0017 }] },
  /* Far off the playable geometry - the boundary pond that must not frame the course. */
  "water-far": { id: "water-far", type: "water", holeNumber: 1, hazardClass: "water",
    position: { lat: 36.02, lng: 174.05 },
    shape: [{ lat: 36.02, lng: 174.05 }, { lat: 36.021, lng: 174.05 }, { lat: 36.021, lng: 174.051 }] }
});

test("the package's surface type list matches the mapper's", async () => {
  const shape = await import(path.join(root, "functions", "lib", "gd-course-package-shape.mjs"));
  const core = await import(path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  /* Held as two constants so the per-request read endpoint does not import the mapper. This is
     the assertion that keeps them from drifting apart. */
  assert.deepStrictEqual(
    [...shape.__coursePackageShapeTest.SURFACE_TYPES].sort(),
    [...core.SURFACE_TYPES].sort()
  );
});

test("a lite package carries each hole's surfaces alongside its geometry", async () => {
  const shape = await import(path.join(root, "functions", "lib", "gd-course-package-shape.mjs"));
  const pkg = shape.shapeLitePackage({ course_id: "surf", objects_json: surfaceObjects(), updated_at: "2026-09-01T00:00:00Z" }, "none");
  const hole = pkg.holes.find(h => h.holeNumber === 1);
  assert.strictEqual(hole.surfaces.bunkers.length, 1);
  assert.strictEqual(hole.surfaces.bunkers[0].osmId, "way/30");
  assert.strictEqual(hole.surfaces.water.length, 2);
  /* The hazard distinction OSM actually made survives to the client. */
  assert.deepStrictEqual(hole.surfaces.water.map(w => w.hazardClass).sort(), ["penalty_area", "water"]);
  /* Surfaces are additive: the geometry the client already relied on is unchanged. */
  assert.ok(hole.green && hole.tee && hole.route.length >= 2);
});

test("a hole with no surfaces reports null rather than empty scaffolding", async () => {
  const shape = await import(path.join(root, "functions", "lib", "gd-course-package-shape.mjs"));
  const objects = surfaceObjects();
  delete objects["bunker-1"]; delete objects["water-1"]; delete objects["water-far"];
  const pkg = shape.shapeLitePackage({ course_id: "surf", objects_json: objects, updated_at: "2026-09-01T00:00:00Z" }, "none");
  assert.strictEqual(pkg.holes.find(h => h.holeNumber === 1).surfaces, null);
});

/* courseBounds drives the client's map framing. A lake tagged on the course edge, or one
   cloned onto three holes, would otherwise drag the course's bounds out to the water. */
test("courseBounds is framed by playable geometry, not by hazards", async () => {
  const shape = await import(path.join(root, "functions", "lib", "gd-course-package-shape.mjs"));
  const objects = surfaceObjects();
  const withSurfaces = shape.courseBoundsFromObjects(objects);
  const playableOnly = shape.courseBoundsFromObjects(
    Object.fromEntries(Object.entries(objects).filter(([, o]) => ["tee", "green", "fairway"].includes(o.type))));
  assert.deepStrictEqual(withSurfaces, playableOnly);
  assert.ok(withSurfaces.north < 36.01, "the boundary pond did not stretch the course north");
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
