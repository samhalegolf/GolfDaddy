/* An unlicensed region is a limit, not a failure.
 *
 * Balgove Course, St Andrews, 2026-08-20. Geometry mapped and published - 9
 * holes, plays fine on live tiles - and Studio showed it in red as
 * "build failed". The job row said why:
 *
 *   imagery-source-unavailable: no licensed imagery source covers this course
 *
 * There is no imagery source for Great Britain, so no Clarity map was ever
 * possible there. Takapuna sits in the same practical state and reads
 * "live map", because nothing ever queued a job for it.
 *
 * Two causes, both fixed here: the publish path queued a job it knew could only
 * fail, and Studio treated that failure as a fault rather than a known limit. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SOURCES = path.join(ROOT, "functions", "lib", "gd-imagery-sources.mjs");
const MAPS = path.join(ROOT, "functions", "course-maps.mjs");
const STUDIO = path.join(ROOT, "scripts", "studio", "gd-admin-course-db.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* Real bounds. Balgove is the 9-holer at St Andrews; North Shore is Albany. */
const BALGOVE = { south: 56.3455, west: -2.8250, north: 56.3520, east: -2.8150 };
const NORTH_SHORE = { south: -36.7560, west: 174.6790, north: -36.7420, east: 174.6890 };

test("Great Britain has no imagery source, which is why Balgove could never build", async () => {
  const { unscannableReason, resolveImagerySource } = await import(SOURCES);
  assert.strictEqual(resolveImagerySource(BALGOVE), null);
  assert.strictEqual(unscannableReason(BALGOVE), "no licensed imagery source covers this course",
    "the first branch - no region match at all, before licensing or config is even considered");
});

test("a covered region fails differently, and must not be mistaken for this", async () => {
  const { unscannableReason } = await import(SOURCES);
  /* NZ IS covered by LINZ; without an API key the reason is a CONFIG problem.
     Both end up as imagery-source-unavailable and both mean "live tiles" to a
     player, but they are different jobs for whoever is on call. */
  const reason = unscannableReason(NORTH_SHORE);
  assert.ok(/not configured/.test(reason), "expected a config reason for NZ, got: " + reason);
  assert.notStrictEqual(reason, "no licensed imagery source covers this course");
});

test("publishing no longer queues a job that can only fail", () => {
  const src = fs.readFileSync(MAPS, "utf8");
  const fn = src.slice(src.indexOf("async function enqueueVisualSnapshot(course, req) {"));
  const checkAt = fn.indexOf("resolveImagerySource(bounds)");
  const postAt = fn.indexOf('method: "POST"');
  assert.notStrictEqual(checkAt, -1,
    "the publish path must run the same licensing check chainVisualSnapshot already does");
  assert.ok(checkAt < postAt, "checking after queueing would defeat the point");
});

/* ---- Studio's label ---- */

function studioFn(signature) {
  const src = fs.readFileSync(STUDIO, "utf8");
  const idx = src.indexOf(signature);
  assert.notStrictEqual(idx, -1, "could not find: " + signature);
  let depth = 0, started = false;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === "{") { depth++; started = true; }
    else if (src[i] === "}") { depth--; if (started && depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error("unbalanced braces after " + signature);
}

function loadUnlicensed() {
  return new Function(studioFn("function gdAdminVisualUnlicensed(lastError){") + "\nreturn gdAdminVisualUnlicensed;")();
}

test("the worker's own error string is what Studio matches on", () => {
  const unlicensed = loadUnlicensed();
  assert.strictEqual(unlicensed("imagery-source-unavailable: no licensed imagery source covers this course"), true);
  /* Every reason half means the same thing to a player, so the prefix is the
     match - not the full sentence. */
  [
    "imagery-source-unavailable: imagery covering this course is a draft entry with unverified endpoints",
    "imagery-source-unavailable: imagery covering this course is display-only and may not be stored",
    "imagery-source-unavailable: imagery source is not configured (LINZ_BASEMAPS_API_KEY)"
  ].forEach((e) => assert.strictEqual(unlicensed(e), true, "should match: " + e));
});

test("a genuine build failure is still red", () => {
  const unlicensed = loadUnlicensed();
  [
    "tile fetch failed after 4 retries",
    "The requested image exceeds the size limit",
    "",
    null,
    undefined
  ].forEach((e) => assert.strictEqual(unlicensed(e), false, "must not swallow: " + e));
});

test("both Studio failure surfaces rule out unlicensed regions before showing a red status", () => {
  const visualState = studioFn("function gdAdminCourseDbVisualState(courseId){");
  const chip = studioFn("function gdAdminCourseCloudJobChip(courseId){");
  [visualState, chip].forEach((body) => {
    const unlicensedAt = Math.max(
      body.indexOf("gdAdminVisualUnlicensed(state.lastError)"),
      body.indexOf("gdAdminVisualUnlicensed(cloud.lastError)")
    );
    const visualFailedAt = body.indexOf("visual treatment failed");
    const captureFailedAt = body.indexOf("capture failed");
    assert.ok(unlicensedAt !== -1, "the unlicensed guard must exist before failure labels");
    assert.ok(visualFailedAt === -1 || unlicensedAt < visualFailedAt, "visual treatment failures must come after the unlicensed guard");
    assert.ok(captureFailedAt === -1 || unlicensedAt < captureFailedAt, "capture failures must come after the unlicensed guard");
  });
});

test("the label a player-facing course lands on is live map, not an error", () => {
  const body = studioFn("function gdAdminCourseDbVisualState(courseId){");
  const at = body.indexOf("gdAdminVisualUnlicensed(cloud.lastError)");
  assert.notStrictEqual(at, -1);
  assert.ok(/label:"live map"/.test(body.slice(at, at + 160)),
    "an unlicensed region must read exactly like Takapuna, which has no job row at all");
});

test("the stale 18-hole comment is gone", () => {
  const src = fs.readFileSync(STUDIO, "utf8");
  assert.ok(!/A course is 18 hole images/.test(src),
    "North Shore is 27 and Balgove is 9; the planner never assumed 18 but the comment claimed it did");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed++; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("unlicensed-region-live-map failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("unlicensed-region-live-map passed: " + tests.length + " checks");
})();
