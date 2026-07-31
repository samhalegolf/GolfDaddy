/* The course library and the confirmation sheet speak plainly.
 *
 * Both surfaces were built as front-ends for the mapper and kept its vocabulary
 * after the mapper stopped being the point: "Objects are grouped by saved GPS
 * course", "3 green targets · 2 bunkers · 1 tee", "Mapping Mode", "Unassigned".
 * The library is now a window onto what is stored on the device, and the
 * confirmation sheet answers "which course is this?" - neither needs a breakdown
 * of internal object types.
 *
 * The wording is asserted against source: the surrounding file is 6,000 lines of
 * browser globals, and these strings are the whole point of the change, so a
 * revert should fail here rather than be noticed on a phone. distanceLabel is
 * executed instead - it is pure, and its boundary is the kind of thing that
 * silently drifts. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "scripts", "gd-course-library-pin-lock.js");
const src = fs.readFileSync(LIB, "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Whole retired sentences, not fragments. A bare "green target" or "Mapping Mode"
   also matches this file's own comments explaining what was removed, and the Map
   Tools sheet - which still carries the old wording but has no entry point left, so
   rewriting it would be theatre. Matching the exact strings that were on the two
   surfaces keeps the assertion about those surfaces. */
const RETIRED = [
  "Objects are grouped by saved GPS course, with duplicates merged by course label.",
  "Saved mapper data will live under this course.",
  "Selected course label",
  "Assumed from current GPS/map position",
  "No nearby saved courses yet.",
  "Scan a green or save a mapper pin in GPS and it will appear here."
];

test("the retired mapping wording is gone", () => {
  const left = RETIRED.filter(s => src.includes(s));
  assert.deepStrictEqual(left, [], "still present in source: " + left.join(" | "));
});

test("the object-type breakdown builder is gone entirely", () => {
  assert.ok(
    !/courseSummaryLine/.test(src),
    "leaving it defined invites the next surface to render '3 green targets · 2 bunkers' again"
  );
});

test("the library describes itself as device storage", () => {
  assert.ok(/Golf course data saved on this device, listed by course name\./.test(src), "library subtitle must say what it is");
  assert.ok(/Course Data/.test(src), "library heading must be the plain one");
});

test("the confirmation sheet asks a plain question", () => {
  assert.ok(/Confirm which course this round is saved under\./.test(src), "confirmation subtitle must be plain");
  assert.ok(/Guessed from your location/.test(src), "the assumed-course line must not read as GPS/map internals");
});

test("the mapper has no entry point left in the library", () => {
  assert.ok(!/gdCLOpenCourseFromLibrary/.test(src), "the mapping-mode door must be gone, not merely hidden");
});

test("candidates are described by what is stored, not by object type", () => {
  const m = src.match(/function savedDataLabel\(course\)\{([\s\S]*?)\n  \}/);
  assert.ok(m, "savedDataLabel must exist");
  assert.ok(/hole/.test(m[1]), "candidates should be summarised by holes held");
  assert.ok(!/bunker|fairway|green/.test(m[1]), "object types are internals, not a course summary");
});

/* Executed, not pattern-matched: the m/km boundary is easy to break by a digit. */
function distanceLabelFrom(src) {
  const m = src.match(/function distanceLabel\(metres\)\{([\s\S]*?)\n  \}/);
  assert.ok(m, "distanceLabel must be a single extractable function");
  return new Function("metres", m[1]);
}

test("distance reads in metres up close and kilometres further out", () => {
  const d = distanceLabelFrom(src);
  assert.strictEqual(d(0), "0m away");
  assert.strictEqual(d(840), "840m away");
  assert.strictEqual(d(949), "949m away");
  assert.strictEqual(d(999), "999m away", "switching before 1km prints '0.9km away', which reads as nearer than 949m");
  assert.strictEqual(d(1000), "1.0km away");
  assert.strictEqual(d(1200), "1.2km away");
});

test("a candidate with no usable distance still reads as a sentence", () => {
  const d = distanceLabelFrom(src);
  assert.strictEqual(d(undefined), "nearby", "an empty string here would render a stray separator");
  assert.strictEqual(d(NaN), "nearby");
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
    console.error("course-library-plain-wording failed: " + failed + "/" + tests.length);
    process.exit(1);
  }
  console.log("course-library-plain-wording passed: " + tests.length + " checks");
})();
