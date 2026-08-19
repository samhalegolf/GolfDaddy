/* What a course row says it is.
 *
 * North Shore Golf Club sat in the admin list as "published" with 0/0 holes.
 * Two separate faults stacked up to produce that:
 *
 *   1. functions/course-mapper-jobs.mjs writes a stub course_maps row -
 *      identity and centre only, published:true - before the mapper runs, so
 *      the worker has a point to query Overpass from. The mapping run then
 *      failed and nothing revised the row.
 *   2. The admin screen labelled every cloud row "published" by default. It
 *      never read a status, because course_maps has no status column.
 *
 * So a course that failed to map looked identical to a fully mapped one, and
 * the reason - which was sitting in course_mapper_jobs.error the whole time -
 * was on a screen that never asked for it.
 *
 * The same stub was also being offered to players in the picker, ranked above
 * real search results.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ADMIN = path.join(ROOT, "scripts", "studio", "gd-admin-course-db.js");
const JOBS = path.join(ROOT, "functions", "course-mapper-jobs.mjs");
const PICKER = path.join(ROOT, "scripts", "inline", "gd-course-picker-search-v2.js");

const adminSrc = fs.readFileSync(ADMIN, "utf8");
const jobsSrc = fs.readFileSync(JOBS, "utf8");
const pickerSrc = fs.readFileSync(PICKER, "utf8");

function lift(src, signature, endSignature, names) {
  const start = src.indexOf(signature);
  assert.notStrictEqual(start, -1, "could not find: " + signature);
  const end = src.indexOf(endSignature, start);
  assert.notStrictEqual(end, -1, "could not find: " + endSignature);
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(start, end) + "\nreturn {" + names.join(",") + "};")();
}

/* The status chain, run for real. gdAdminCourseDbJobState is stubbed per case
   so the job side can be varied without a network. */
function statusHarness(job) {
  const src =
    'var __job = ' + JSON.stringify(job) + ';\n' +
    'function gdAdminCourseDbJobState(){ return __job; }\n' +
    adminSrc.slice(
      adminSrc.indexOf("function gdAdminCourseDbBaseStatus(course){"),
      adminSrc.indexOf("function gdMapCloudMapsToAdminStore(maps){")
    );
  // eslint-disable-next-line no-new-func
  return new Function(src + "\nreturn {gdAdminCourseDbBaseStatus,gdAdminCourseDbStatusFor,gdAdminCourseDbStatusWhy};")();
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("a course with holes is published", () => {
  const h = statusHarness(null);
  assert.strictEqual(h.gdAdminCourseDbBaseStatus({ holes: { 1: {}, 2: {} } }), "published");
  assert.strictEqual(h.gdAdminCourseDbStatusFor({ id: "x", status: "published" }), "published");
  assert.strictEqual(h.gdAdminCourseDbStatusWhy({ id: "x", status: "published" }), "");
});

test("an empty course whose mapping run failed reads as failed, with the reason", () => {
  /* The exact North Shore case, using the error the database actually holds. */
  const reason = "no numbered hole geometry found for north-shore (no OSM hole geometry within range)";
  const h = statusHarness({ state: "failed", lastError: reason });
  const item = { id: "north-shore", status: h.gdAdminCourseDbBaseStatus({ holes: {}, objects: {} }) };
  assert.strictEqual(item.status, "empty", "no holes and no objects is empty, not published");
  assert.strictEqual(h.gdAdminCourseDbStatusFor(item), "failed");
  assert.strictEqual(h.gdAdminCourseDbStatusWhy(item), reason);
});

test("a failed run with no recorded reason still says so plainly", () => {
  const h = statusHarness({ state: "failed", lastError: null });
  const item = { id: "x", status: "empty" };
  assert.strictEqual(h.gdAdminCourseDbStatusFor(item), "failed");
  assert.ok(/gave no reason/.test(h.gdAdminCourseDbStatusWhy(item)));
});

test("a run in flight reads as mapping, not as failed or published", () => {
  ["running", "queued"].forEach(function (state) {
    const h = statusHarness({ state: state });
    assert.strictEqual(h.gdAdminCourseDbStatusFor({ id: "x", status: "empty" }), "mapping");
  });
});

test("geometry beats whatever the queue last said", () => {
  /* A course that has holes is playable even if the most recent job failed -
     matching mapperBuildState's "what exists over what the queue said". */
  const h = statusHarness({ state: "failed", lastError: "stale failure" });
  assert.strictEqual(h.gdAdminCourseDbStatusFor({ id: "x", status: "published" }), "published");
  assert.strictEqual(h.gdAdminCourseDbStatusWhy({ id: "x", status: "published" }), "");
});

test("status is never defaulted to published again", () => {
  assert.ok(
    !/status:c\.status\|\|"published"/.test(adminSrc),
    'every cloud row being labelled "published" on arrival is the bug itself'
  );
  assert.ok(
    /status:c\.status\|\|gdAdminCourseDbBaseStatus\(c\)/.test(adminSrc),
    "status must be derived from the course's own geometry"
  );
});

test("the row expands in place and shows the failure reason", () => {
  assert.ok(/function gdAdminCourseDbToggleRow\(courseId\)/.test(adminSrc), "rows must toggle");
  assert.ok(/window\.gdAdminCourseDbToggleRow=gdAdminCourseDbToggleRow;/.test(adminSrc), "the toggle must be reachable from the onclick");
  assert.ok(/onclick="return gdAdminCourseDbToggleRow\(/.test(adminSrc), "the row click must expand rather than only opening the panel");
  const block = adminSrc.slice(adminSrc.indexOf("function gdAdminCourseDbExpandedRow(item){"));
  assert.ok(/gdAdminCourseDbStatusWhy\(item\)/.test(block), "the expansion must show why");
  assert.ok(/gdAdminCourseDbActionRail\(item\)/.test(block), "the full detail tabs must still be reachable");
});

test("the jobs endpoint answers for every course in one request", () => {
  assert.ok(/async function mapperBuildStateAll\(\)/.test(jobsSrc), "a bulk builder must exist");
  assert.ok(
    /if \(!courseId\) return json\(200, await mapperBuildStateAll\(\)\);/.test(jobsSrc),
    "GET with no courseId must return every course, not a 400"
  );
  assert.ok(/truncated: jobs\.length >= BULK_JOB_SCAN_LIMIT/.test(jobsSrc), "a capped scan must admit it was capped");
});

test("the bulk and single forms use one vocabulary", () => {
  /* Two status vocabularies would let a row and its detail panel disagree. */
  const single = jobsSrc.slice(jobsSrc.indexOf("async function mapperBuildState(courseId)"), jobsSrc.indexOf("async function mapperBuildState(courseId)") + 1400);
  const bulk = jobsSrc.slice(jobsSrc.indexOf("async function mapperBuildStateAll()"), jobsSrc.indexOf("async function mapperBuildState(courseId)"));
  ["geometry-ready", "running", "queued", "failed", "none"].forEach(function (state) {
    assert.ok(single.includes('"' + state + '"'), "single form lost state: " + state);
    assert.ok(bulk.includes('"' + state + '"'), "bulk form lost state: " + state);
  });
});

test("a course with no holes is never offered to a player", () => {
  /* The stub is published:true, so published alone can never be the test. */
  assert.ok(
    /function databaseCourseHasMap\(raw\)\{\s*return Object\.keys\(raw&&raw\.holes\|\|\{\}\)\.length>0;/.test(pickerSrc),
    "holes are the only evidence a database course is playable"
  );
  assert.ok(
    /\.filter\(databaseCourseHasMap\)\.map\(databaseCoursePayload\)/.test(pickerSrc),
    "the filter must run before a stub becomes a picker result"
  );
});

test("deleting a course clears its mapping history", () => {
  /* deriveCoursePackageState makes a course whose last mapper job failed
     permanently "failed" - /api/course-package answers failed on every poll and
     never enqueues again. That is deliberate and correct (it stopped a
     mis-matched course burning five identical jobs in forty seconds and
     starving two real courses of any job at all).
  
     But it made delete a lie. The jobs live in course_mapper_jobs, so the
     failure survived deleting the course_maps row and the course could never be
     mapped again - it went straight to manual with nothing reaching the
     database, and deleting and re-adding could not clear it. Deleting the
     course is the deliberate retry the design intends; it has to clear the
     history it is retrying past. */
  const fs = require("fs");
  const mapsSrc = fs.readFileSync(path.join(ROOT, "functions", "course-maps.mjs"), "utf8");
  assert.ok(/async function deleteMapperJobs\(courseId\)/.test(mapsSrc), "a job-clearing helper must exist");
  assert.ok(
    /course_mapper_jobs\?course_id=eq\./.test(mapsSrc),
    "it must delete by course_id from the jobs table"
  );
  const del = mapsSrc.slice(mapsSrc.indexOf("async function deleteSupabaseCourse(courseId)"));
  assert.ok(
    del.indexOf("await deleteMapperJobs(courseId);") !== -1 &&
    del.indexOf("await deleteMapperJobs(courseId);") < del.indexOf("\n}"),
    "the course delete must clear the jobs, not just the map row"
  );
  const helper = mapsSrc.slice(mapsSrc.indexOf("async function deleteMapperJobs(courseId)"));
  assert.ok(
    /catch \(error\)/.test(helper.slice(0, 700)),
    "best effort - a course that is gone must not come back because its history would not delete"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("course-db-status failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("course-db-status passed: " + tests.length + " checks");
})();
