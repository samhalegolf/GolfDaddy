/* Pull-before-capture.
 *
 * pullCourse existed but nothing ever called it - the only cloud lookup was for
 * published course_maps. So a course that had been scanned but not published
 * missed on every device, every time, and was rescanned from scratch. One course
 * reached 231 rows across 18 holes that way.
 *
 * The ordering is the whole fix: hydrating writes into the same local store the
 * saved-map check reads, so it has to run BEFORE that check, and be awaited.
 * Asserted against source because the surrounding file is 5,000 lines of browser
 * globals; behaviour is verified on device. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PIN_LOCK = path.join(ROOT, "scripts", "gd-course-library-pin-lock.js");
const SYNC = path.join(ROOT, "scripts", "gd-captured-surface-sync.js");

const src = fs.readFileSync(PIN_LOCK, "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("the captured-scan pull is actually called", () => {
  const calls = src.split("tryHydrateCapturedScansFromCloud(").length - 1;
  assert.ok(
    calls >= 2,
    "must be defined AND invoked - the previous bug was a pull that existed but was never called"
  );
});

test("pullCourse is reachable from the app", () => {
  assert.ok(
    /api\.pullCourse\(/.test(src),
    "the hydrate must actually invoke pullCourse, not just check it exists"
  );
  const sync = fs.readFileSync(SYNC, "utf8");
  assert.ok(/pullCourse: pullCourse/.test(sync), "pullCourse must stay exported");
});

test("the pull is awaited", () => {
  assert.ok(
    /await tryHydrateCapturedScansFromCloud\(/.test(src),
    "an un-awaited pull races the saved-map check and the scan wins"
  );
});

test("the pull runs before the saved-map check", () => {
  const hydrateAt = src.indexOf("await tryHydrateCapturedScansFromCloud(");
  const savedAt = src.indexOf("const savedState=savedMapCanSatisfyRequest(");
  assert.notStrictEqual(hydrateAt, -1, "hydrate call must exist");
  assert.notStrictEqual(savedAt, -1, "saved-map check must exist");
  assert.ok(
    hydrateAt < savedAt,
    "hydrating after the saved-map check means scanning first and only then "
    + "discovering the data already existed - the exact bug being fixed"
  );
});

test("the pull runs before the automapper", () => {
  const hydrateAt = src.indexOf("await tryHydrateCapturedScansFromCloud(");
  const autoMapAt = src.indexOf("const autoMapResult=await autoMapOsmCourse(");
  assert.notStrictEqual(autoMapAt, -1, "automap call must exist");
  assert.ok(hydrateAt < autoMapAt, "the automapper is what generates a fresh scan");
});

test("course identity is literal, with no candidate list", () => {
  const idx = src.indexOf("function literalCourseKey(");
  assert.notStrictEqual(idx, -1, "literalCourseKey must exist");
  const fn = src.slice(idx, idx + 500);
  assert.ok(/c\.courseId\s*\|\|\s*c\.courseName\s*\|\|\s*c\.name/.test(fn), "must read courseId, courseName, name in that order");
  assert.ok(
    !/\bc\.id\b/.test(fn),
    "must never read .id - on a stored record that is the composite `${userId}::${courseId}` key"
  );
});

test("the hydrate uses the literal key, not the fuzzy candidate list", () => {
  const idx = src.indexOf("async function tryHydrateCapturedScansFromCloud(");
  assert.notStrictEqual(idx, -1);
  const fn = src.slice(idx, idx + 1800);
  assert.ok(/literalCourseKey\(/.test(fn), "must resolve identity literally");
  assert.ok(
    !/cloudCourseMapKeys\(/.test(fn),
    "must not use the multi-candidate key list - that is the fuzzy matching being removed"
  );
});

test("a failed hydrate is not fatal", () => {
  const idx = src.indexOf("async function tryHydrateCapturedScansFromCloud(");
  const fn = src.slice(idx, idx + 1800);
  assert.ok(/catch\s*\(error\)/.test(fn), "must catch");
  assert.ok(
    !/throw\b/.test(fn),
    "a failed pull must fall through to scanning, not break entering a course"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  ok  " + t.name);
    } catch (err) {
      failed += 1;
      console.error("  FAIL " + t.name);
      console.error("       " + (err && err.message || err));
    }
  }
  if (failed) {
    console.error("captured-scan-hydrate failed: " + failed + "/" + tests.length);
    process.exit(1);
  }
  console.log("captured-scan-hydrate passed: " + tests.length + " checks");
})();
