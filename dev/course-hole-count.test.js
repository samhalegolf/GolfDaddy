/* Hole counts other than 18 are normal.
 *
 * Nine-hole courses, 27-hole courses played as three nines, and genuine
 * oddities like Takapuna's 17 are all valid. The code assumed 18 and clamped to
 * it, so those courses were judged against a count they could never reach:
 * courseDataMapReadiness reported them incomplete on every entry, and that
 * suppressed the cloud sync outright ("reason:incomplete-map") - meaning a 9 or
 * 17 hole course could never publish.
 *
 * The resolver is exercised directly against the real source. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PIN_LOCK = path.join(ROOT, "scripts", "gd-course-library-pin-lock.js");
const src = fs.readFileSync(PIN_LOCK, "utf8");

/* Pull the resolver and its helpers out and run them in isolation, with the
   scorecard absent so the course-derived paths are what is under test. */
function loadResolver() {
  const names = [
    "const COURSE_HOLE_COUNT_MAX=36;",
    "function scorecardHoleCount(",
    "function declaredHoleCount(",
    "function courseExpectedHoleCount("
  ];
  let code = "";
  names.forEach(function (needle) {
    const idx = src.indexOf(needle);
    assert.notStrictEqual(idx, -1, "could not find: " + needle);
    if (needle.indexOf("const ") === 0) { code += needle + "\n"; return; }
    const end = src.indexOf("\n  }", idx);
    assert.notStrictEqual(end, -1, "could not bound: " + needle);
    code += src.slice(idx, end + 4) + "\n";
  });
  // eslint-disable-next-line no-new-func
  return new Function("window", code + "\nreturn courseExpectedHoleCount;")({});
}

const expectedFor = loadResolver();
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function courseWithHoles(n) {
  const holes = {};
  for (let i = 1; i <= n; i += 1) holes[String(i)] = { mapped: true };
  return { holes: holes };
}

test("a declared 9 hole course expects 9, not 18", () => {
  assert.strictEqual(expectedFor({ holeCount: 9 }), 9);
});

test("a declared 17 hole course expects 17 - Takapuna is not a failed scan", () => {
  assert.strictEqual(expectedFor({ holeCount: 17 }), 17);
});

test("an 18 hole course still expects 18", () => {
  assert.strictEqual(expectedFor({ holeCount: 18 }), 18);
});

test("27 holes survives - three nines is no longer clamped to 18", () => {
  assert.strictEqual(
    expectedFor({ holeCount: 27 }), 27,
    "the old Math.min(18,...) capped this, so nine holes of a 27 hole course were invisible"
  );
});

test("a partial scan is NOT treated as a small course", () => {
  /* The count must never be inferred from how many holes happen to be mapped.
     Doing so made any partial scan look complete, so the resolver would never
     finish it - caught by course-mapping-controller. */
  assert.strictEqual(
    expectedFor(courseWithHoles(4)), 18,
    "four mapped holes and nothing declared must still expect 18, so the course reads as incomplete"
  );
});

test("a declared count wins over mapped holes either way", () => {
  const partial = courseWithHoles(4);
  partial.holeCount = 18;
  assert.strictEqual(expectedFor(partial), 18);
  const full = courseWithHoles(18);
  full.holeCount = 9;
  assert.strictEqual(full.holeCount, 9, "fixture sanity");
  assert.strictEqual(expectedFor(full), 9, "the declaration is authoritative");
});

test("nothing known falls back to 18", () => {
  assert.strictEqual(expectedFor({}), 18);
  assert.strictEqual(expectedFor(null), 18);
});

test("an absurd declared count is clamped", () => {
  assert.ok(expectedFor({ holeCount: 9999 }) <= 36, "must not expect thousands of holes");
  assert.ok(expectedFor({ holeCount: -5 }) >= 1, "must not expect a negative number of holes");
});

test("only a plausible sweep result may be recorded as the hole count", () => {
  const idx = src.indexOf("function recordDiscoveredHoleCount(");
  assert.notStrictEqual(idx, -1, "recordDiscoveredHoleCount must exist");
  const fn = src.slice(idx, idx + 900);
  assert.ok(
    /found<9/.test(fn),
    "a sweep returning one or two holes must not convince later checks the course is that small"
  );
  assert.ok(/COURSE_HOLE_COUNT_MAX/.test(fn), "and it must be bounded at the top end too");
});

test("the discovered count is only recorded for a whole-course sweep", () => {
  assert.ok(
    /request\.wholeCourse!==false\)recordDiscoveredHoleCount\(/.test(src),
    "a single-hole map says nothing about the course total"
  );
});

test("the clamp to 18 is gone from every readiness site", () => {
  assert.ok(
    !/Math\.min\(18,\s*Number\(automapperExpectedHoleCount/.test(src),
    "a hardcoded 18 ceiling would silently truncate 27 hole courses again"
  );
  const uses = src.split("courseExpectedHoleCount(").length - 1;
  assert.ok(uses >= 4, "all readiness/frame sites must use the resolver, found " + uses + " references");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("course-hole-count failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("course-hole-count passed: " + tests.length + " checks");
})();
