/* Test bakes (Mapbox): the normal capture + bake into a private sandbox, never published.
 *
 * The behaviour that matters is what a test bake CANNOT do - reach the live course's frames,
 * write course_visuals, show a player a course as building, outlive its retention window -
 * so most checks here are refusals. Pure parts run for real; the worker and endpoints are
 * pinned by source, in the style of dev/course-map-ai-scan.test.js.
 *
 * Run: node dev/test-bakes.test.mjs */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

const core = await import("../functions/lib/gd-test-bake-core.mjs");
const mapbox = await import("../functions/lib/gd-mapbox-source.mjs");
const plan = await import("../functions/lib/gd-visual-plan-core.mjs");
const jobsModule = await import("../functions/course-visual-jobs.mjs");
const jobs = jobsModule.__test;

const worker = read("functions/course-visual-worker-background.mjs");
const endpoint = read("functions/course-test-bakes.mjs");
const sweeper = read("functions/course-visual-sweeper.mjs");
const assets = read("functions/course-visual-assets.mjs");
const studio = read("scripts/studio/gd-admin-course-test-bakes.js");
const courseDb = read("scripts/studio/gd-admin-course-db.js");
const html = read("index.html");
const toml = read("netlify.toml");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const COURSE = "cc-37-178n-127-708e";
const NOW = Date.parse("2026-10-01T03:00:00Z");

test("a test run gets a dated root under its own course, and the job's run is validated", () => {
  const run = core.newTestRun({ courseId: COURSE, source: "mapbox", requestedBy: "a@b", now: NOW, random: () => 0.5 });
  assert.match(run.root, /^2026-10-01\/cc-37-178n-127-708e\/t[a-z0-9]+-[a-z0-9]+$/);
  const job = { course_id: COURSE, kind: core.TEST_SNAPSHOT_KIND, recipe: { testRun: run } };
  assert.equal(core.testRunFromJob(job).root, run.root);
  assert.throws(() => core.testRunFromJob({ course_id: COURSE, recipe: {} }), /no testRun/);
  assert.throws(() => core.testRunFromJob({ course_id: COURSE, recipe: { testRun: Object.assign({}, run, { source: "esri" }) } }), /not a test source/);
  assert.throws(() => core.testRunFromJob({ course_id: "other-course", recipe: { testRun: run } }), /does not belong/, "a run may only write under its own course");
  assert.throws(() => core.testRunFromJob({ course_id: COURSE, recipe: { testRun: Object.assign({}, run, { root: COURSE + "/frames" }) } }), /does not belong/, "a live-shaped path is refused");
  assert.throws(() => core.testRunFromJob({ course_id: COURSE, recipe: { testRun: Object.assign({}, run, { root: "2026-10-01/" + COURSE + "/../x" }) } }), /does not belong/);
  assert.ok(core.isTestKind("test-snapshot") && core.isTestKind("test-export") && !core.isTestKind("snapshot") && !core.isTestKind("export"));
});

test("retention deletes whole date folders past the window, recursively, and nothing newer", async () => {
  const files = [
    "2026-09-20/c1/t1/captures/index.json", "2026-09-20/c1/t1/captures/2048/hole/1/a.jpg",
    "2026-09-20/c1/t1/frames/r1/h1.jpg", "2026-09-26/c2/t2/frames/index.json", "2026-09-30/c3/t3/frames/h1.jpg", "notes.txt"
  ];
  const removed = [];
  const storage = {
    async list(prefix) {
      const names = new Map();
      files.filter(f => f.startsWith(prefix) && !removed.includes(f)).forEach(f => {
        const rest = f.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        names.set(head, tail.length ? null : "file-id");
      });
      return [...names].map(([name, id]) => ({ name, id }));
    },
    async remove(paths) { removed.push(...paths); }
  };
  const result = await core.purgeTestBakes(storage, { now: NOW, days: 7 });
  assert.equal(result.cutoff, "2026-09-24");
  assert.deepEqual(result.dates, ["2026-09-20"]);
  assert.deepEqual(removed.sort(), files.slice(0, 3).sort());
});

test("Mapbox as a capture source: 256px xyz tiles, terrain-RGB relief, not storable, and absent without a token", () => {
  assert.equal(mapbox.mapboxCaptureSource({}), null);
  const src = mapbox.mapboxCaptureSource({ MAPBOX_PUBLIC_TOKEN: "pk.TEST" });
  assert.equal(src.storable, false);
  assert.equal(src.imagery.adapter, "xyz");
  assert.ok(src.imagery.urlTemplate.includes("/mapbox.satellite/{z}/{x}/{y}.jpg90?access_token="), "256px tiles - no @2x, the planner grids in 256px cells");
  assert.ok(!src.imagery.urlTemplate.includes("@2x"));
  assert.ok(src.dem.urlTemplate.includes("/mapbox.mapbox-terrain-dem-v1/{z}/{x}/{y}.pngraw?"));
  assert.equal(src.terrain.role, "relief", "the DEM must be usable for relief and green surfaces");
  assert.equal(src.terrain.encoding, "terrain-rgb");
  assert.equal(src.license.storage, false);
  /* A grid the planner builds from it carries the token only in tile URLs. */
  const grid = plan.captureGrid({ role: "course-backdrop", bounds: { north: 37.1835, south: 37.1692, west: 127.696, east: 127.714 }, paddedBounds: { north: 37.1835, south: 37.1692, west: 127.696, east: 127.714 }, targetZoom: 16, minZoom: 14, maxTiles: 64 }, { source: src });
  if (grid) {
    assert.equal(grid.sourceKey, "mapbox");
    assert.ok(grid.tiles.every(t => t.url.includes("access_token=pk.TEST")));
    const withoutUrls = Object.assign({}, grid, { tiles: [] });
    assert.ok(!JSON.stringify(withoutUrls).includes("pk.TEST"), "grid metadata must not carry the token");
  }
});

test("the player-facing build state never sees a test job", () => {
  const visual = null;
  const running = jobs.deriveCourseBuildStateFromRows({ jobs: [{ kind: "test-snapshot", status: "running", updated_at: new Date().toISOString() }], visual });
  assert.equal(running.state, "none", "a running test must not read as building");
  const failed = jobs.deriveCourseBuildStateFromRows({ jobs: [{ kind: "test-export", status: "failed", error: "boom" }], visual });
  assert.equal(failed.state, "none", "a failed test must not read as this course failing");
  const jobsSrc = read("functions/course-visual-jobs.mjs");
  assert.ok(jobsSrc.includes("&kind=in.(snapshot,export)&order=created_at.desc&limit=8"), "the single-course job list must not include test jobs");
  assert.ok(jobsSrc.includes("if (!id || isTestKind(job.kind)) return;"), "the bulk list must not include test jobs");
});

test("the worker keeps a test job inside its private space", () => {
  assert.ok(worker.includes("function spaceFor(job)") && worker.includes("bucket: TEST_BAKE_BUCKET, root: run.root"));
  const body = name => worker.slice(worker.indexOf("async function " + name + "("), worker.indexOf("\n}\n", worker.indexOf("async function " + name + "(")));
  for (const name of ["runSnapshotJob", "runExportJob"]) {
    const src = body(name);
    assert.ok(src.includes("const space = spaceFor(job);"), name + " must resolve its space first");
    const calls = src.match(/storage(Upload|Download|Exists)\([^;]*\)/g) || [];
    assert.ok(calls.length > 3, name + " storage calls not found");
    calls.forEach(call => assert.ok(call.includes("space.bucket"), name + ": a storage call without space.bucket would write the live bucket: " + call.slice(0, 120)));
    assert.ok(!/pkg\.courseId \+ "\/(captures|frames)/.test(src.slice(0, src.indexOf("if (space.test) {\n    return {") > 0 ? src.indexOf("if (space.test) {\n    return {") : src.length)), name + " builds a live path before the test return");
  }
  const exportSrc = body("runExportJob");
  const testReturn = exportSrc.indexOf("if (space.test) {\n    return {");
  assert.ok(testReturn > 0, "the export must return early for a test");
  assert.ok(testReturn < exportSrc.indexOf("await writeCourseVisualRow("), "a test must return before course_visuals is written");
  assert.ok(testReturn < exportSrc.indexOf("sweepOldFrameVersions("), "a test must return before live frame versions are swept");
  assert.ok(exportSrc.includes('if (!space.test && capturesIndex.source && capturesIndex.source.storable === false)'), "a live export must refuse non-storable captures");
  const snapSrc = body("runSnapshotJob");
  assert.ok(snapSrc.includes('mapboxCaptureSource()') && snapSrc.includes("await ensureTestBucket();"));
  assert.ok(snapSrc.includes('if (source.storable === false) throw new Error("imagery-source-unavailable: "'), "a live snapshot must never take a non-storable source");
  assert.ok(worker.includes("if (job.kind === TEST_SNAPSHOT_KIND) await enqueueTestExport(job)"), "a test snapshot chains a TEST export");
  assert.ok(/if \(job\.kind === "snapshot"\) await enqueueFollowUpExport/.test(worker), "only a live snapshot chains the live export");
  assert.ok(worker.includes("public: false"), "the test bucket is created private");
});

test("test frames are reachable only by admins, through expiring links", () => {
  assert.ok(endpoint.includes("verifiedAdminEmail(req)") && endpoint.includes('if (!admin) return json(403'), "admin only, both GET and POST");
  assert.ok(endpoint.indexOf("verifiedAdminEmail(req)") < endpoint.indexOf('req.method === "GET"'), "the admin check precedes the GET branch");
  assert.ok(endpoint.includes("/storage/v1/object/sign/") && endpoint.includes("SIGNED_URL_SECONDS = 3600"));
  assert.ok(!assets.includes("course-visual-tests"), "the public asset proxy must not serve the test bucket");
  assert.ok(/const BUCKET = "course-visuals";/.test(assets));
  assert.ok(toml.includes('from = "/api/course-test-bakes"'));
  assert.ok(fs.existsSync(path.join(ROOT, "supabase/migrations/20261001_create_course_visual_tests_bucket.sql")));
  assert.match(read("supabase/migrations/20261001_create_course_visual_tests_bucket.sql"), /'course-visual-tests', 'course-visual-tests', false/);
});

test("old test bakes are purged by the visual sweeper", () => {
  assert.ok(sweeper.includes("purgeTestBakes(createSupabaseStorage({ base, key, bucket: TEST_BAKE_BUCKET }))"));
  assert.ok(sweeper.includes("const testBakes = await purgeOldTestBakes();"));
});

test("Studio: Rebuild menu entry, a Test Bakes view, loaded on the studio surface", () => {
  assert.ok(courseDb.includes('item("test_bake_mapbox","Test bake with Mapbox"'));
  assert.ok(courseDb.includes('if(mode==="test_bake_mapbox")') && courseDb.includes("window.gdAdminCourseTestBakeStart(id)"));
  assert.ok(courseDb.includes('gdAdminCourseDatabaseTab==="testbakes"'));
  assert.ok(/data-gd-surface="studio"[^>]*gd-admin-course-test-bakes\.js/.test(html));
  assert.ok(studio.includes('call("POST", "", { courseId: id, source: "mapbox" })'));
  assert.ok(studio.includes("window.confirm("), "a test bake costs a course of tile fetches - it is confirmed");
});

let failures = 0;
for (const item of tests) {
  try { await item.fn(); console.log("  ok  " + item.name); }
  catch (error) { failures += 1; console.error("  FAIL  " + item.name + "\n        " + (error && error.stack || error)); }
}
if (failures) { console.error("test-bakes FAILED: " + failures + " of " + tests.length); process.exit(1); }
console.log("test-bakes passed: " + tests.length + " checks");
