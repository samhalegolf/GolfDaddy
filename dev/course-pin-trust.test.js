/* When must a player place a pin?
 *
 * Almost never. gdCoursePickerNeedsCoursePin used to answer TRUE by default, so
 * the pin screen ran on every new course search: no stored map and no confirmed
 * pin is the normal state of every course nobody has played, and it was being
 * treated as evidence of something. A search result already carries a
 * coordinate and it is right nearly every time.
 *
 * The rule now: trust that coordinate, map from it, and ask for a pin only when
 * the mapper comes back and says it was clearly wrong. These tests pin down
 * both halves - what counts as "clearly wrong", and that nothing else reaches
 * the screen. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FIT = path.join(ROOT, "functions", "lib", "gd-course-fit-core.mjs");
const CORE = path.join(ROOT, "scripts", "gd-app-core.js");
const PICKER = path.join(ROOT, "scripts", "inline", "gd-course-picker-search-v2.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---- what counts as clearly wrong ---- */

test("a normal course is trusted and asks for nothing", async () => {
  const { courseFitVerdict } = await import(FIT);
  const v = courseFitVerdict({
    expectedHoles: 18, holesResolved: 18,
    courseBounds: { north: -36.740, south: -36.760, east: 174.690, west: 174.670 }
  });
  assert.strictEqual(v.trusted, true);
  assert.strictEqual(v.reason, null);
});

test("a course with no scorecard is trusted, not suspected", async () => {
  const { courseFitVerdict } = await import(FIT);
  /* Most courses have no shared scorecard. If a missing one counted as evidence
     the pin screen would be back on every course, which is the bug. */
  const v = courseFitVerdict({ expectedHoles: 0, holesResolved: 14 });
  assert.strictEqual(v.trusted, true, "no scorecard is not evidence of anything");
});

test("nothing known at all is still trusted", async () => {
  const { courseFitVerdict } = await import(FIT);
  assert.strictEqual(courseFitVerdict({}).trusted, true, "silence must mean trust, or the default inverts again");
  assert.strictEqual(courseFitVerdict(null).trusted, true);
});

test("two courses on the same ground stops the round", async () => {
  const { courseFitVerdict } = await import(FIT);
  const v = courseFitVerdict({ collision: { multiLoop: true, loops: 3, widestSeparationM: 700 } });
  assert.strictEqual(v.trusted, false);
  assert.strictEqual(v.reason, "multiple-courses");
  assert.strictEqual(v.scope, "ground", "the map is wrong, not thin");
});

test("holes too spread out to be one course stops the round", async () => {
  const { courseFitVerdict, COURSE_FIT_MAX_SPAN_M, boundsSpanM } = await import(FIT);
  /* ~14km across - the sweep ate a neighbouring club that course_maps does not
     know about, so guideBelongsToCourse had no sibling centre to partition it. */
  const bounds = { north: -36.70, south: -36.80, east: 174.75, west: 174.65 };
  assert.ok(boundsSpanM(bounds) > COURSE_FIT_MAX_SPAN_M);
  const v = courseFitVerdict({ expectedHoles: 18, holesResolved: 18, courseBounds: bounds });
  assert.strictEqual(v.reason, "holes-scattered");
  assert.strictEqual(v.scope, "ground");
});

test("a genuinely long course is not scattered", async () => {
  const { courseFitVerdict, boundsSpanM } = await import(FIT);
  /* St Andrews Old runs about 2km end to end; the threshold has to clear that
     and every 27-hole site by a wide margin or it fires on real golf. */
  const bounds = { north: 56.3560, south: 56.3410, east: -2.7900, west: -2.8300 };
  assert.ok(boundsSpanM(bounds) < 4000, "sanity: this is a real links, got " + boundsSpanM(bounds));
  assert.strictEqual(courseFitVerdict({ courseBounds: bounds }).trusted, true);
});

test("fewer holes than the scorecard is a coverage problem, not a ground one", async () => {
  const { courseFitVerdict } = await import(FIT);
  const v = courseFitVerdict({ expectedHoles: 18, holesResolved: 11 });
  assert.strictEqual(v.trusted, false);
  assert.strictEqual(v.scope, "coverage",
    "a scraped scorecard is as likely to be wrong as the pin - this must not hard-block");
});

test("every untrusted verdict explains itself", async () => {
  const { courseFitVerdict, courseFitMessage } = await import(FIT);
  [
    { collision: { multiLoop: true, loops: 2, widestSeparationM: 400 } },
    { expectedHoles: 18, holesResolved: 9 },
    { courseBounds: { north: -36.70, south: -36.80, east: 174.75, west: 174.65 } }
  ].forEach((facts) => {
    const message = courseFitMessage(courseFitVerdict(facts));
    assert.ok(message && message.length > 20, "asking for work without a reason is not on: " + message);
  });
  assert.strictEqual(courseFitMessage({ trusted: true }), "", "a trusted course says nothing");
});

/* ---- the gate itself ---- */

function coreFn(signature) {
  const src = fs.readFileSync(CORE, "utf8");
  const idx = src.indexOf(signature);
  assert.notStrictEqual(idx, -1, "could not find: " + signature);
  let depth = 0, started = false;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === "{") { depth++; started = true; }
    else if (src[i] === "}") { depth--; if (started && depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error("unbalanced braces after " + signature);
}

function loadGate(bypass) {
  const source = coreFn("function gdCoursePickerNeedsCoursePin(payload){")
    + "\n" + coreFn("function gdCoursePickerConsumePinBypass(payload){");
  return new Function("gdCoursePayloadIsManual", "gdStoredCourseSessionKey", "document", "window",
    source + "\nreturn gdCoursePickerNeedsCoursePin;")(
    (p) => !!(p && p.manual),
    (p) => String((p && (p.courseId || p.name)) || ""),
    { body: { dataset: {} } },
    { __gdCoursePickerBypassPinOnce: bypass === undefined ? null : bypass }
  );
}

test("a brand new course search does NOT ask for a pin", () => {
  const needsPin = loadGate();
  /* The whole point. No stored map, no confirmed location, nothing played here
     before - and the player goes straight to their round. */
  assert.strictEqual(needsPin({ name: "Some New Club", courseId: "some-new-club" }), false);
});

test("no database map is not a reason to ask", () => {
  const needsPin = loadGate();
  assert.strictEqual(needsPin({ courseId: "x", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: false }), false,
    "an unmapped course is the normal state, not a problem");
});

test("a failed fit verdict is the one thing that asks", () => {
  const needsPin = loadGate();
  assert.strictEqual(needsPin({ courseId: "x", gdCourseFitTrusted: false, gdCourseFitReason: "multiple-courses" }), true);
});

test("pinning ends the conversation instead of looping", () => {
  /* The payload still carries the failing verdict from the run that asked, so
     without the bypass the re-entry would ask again forever. */
  const needsPin = loadGate("x");
  assert.strictEqual(needsPin({ courseId: "x", gdCourseFitTrusted: false, gdCourseFitReason: "multiple-courses" }), false);
});

test("a stale bypass cannot silence a DIFFERENT course", () => {
  /* This was a real leak while the flag was a bare boolean: gdConfirmCoursePin
     set it, an early bail meant nothing consumed it, and the next unrelated
     course had its pin prompt suppressed. */
  const needsPin = loadGate("some-other-course");
  assert.strictEqual(needsPin({ courseId: "x", gdCourseFitTrusted: false, gdCourseFitReason: "holes-scattered" }), true);
});

test("manual GPS never asks", () => {
  assert.strictEqual(loadGate()({ manual: true, gdCourseFitTrusted: false }), false);
});

/* ---- and nothing else reaches the screen ---- */

test("the picker only opens the pin as a post-mapping repair", () => {
  const src = fs.readFileSync(PICKER, "utf8");
  const calls = src.split("\n").filter((line) => /showPin\s*\(/.test(line) && !/typeof/.test(line));
  assert.ok(calls.length >= 1, "the repair path must exist");
  /* Two call sites are expected: the gate in selectCourseForPlay and the
     post-mapping repair. A third means someone re-added a pre-mapping prompt. */
  assert.ok(calls.length <= 2, "unexpected extra showPin call site:\n" + calls.join("\n"));
  assert.ok(/fit\.scope==="ground"/.test(src), "the repair must branch on scope, not on any failed verdict");
});

test("the pin screen no longer blames GPS", () => {
  const src = fs.readFileSync(CORE, "utf8");
  assert.ok(!/gdCoursePinKicker">GPS not available/.test(src),
    "this screen is a repair now; GPS was never the reason and is now never true");
  assert.ok(/gdCourseFitMessage/.test(src), "it must show why it is asking");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed++; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("course-pin-trust failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("course-pin-trust passed: " + tests.length + " checks");
})();
