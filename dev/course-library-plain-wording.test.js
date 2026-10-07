/* The course library speaks plainly.
 *
 * It was built as a front-end for the mapper and kept its vocabulary after the
 * mapper stopped being the point: "Objects are grouped by saved GPS course",
 * "3 green targets · 2 bunkers · 1 tee", "Mapping Mode", "Unassigned". The
 * library is now a window onto what is stored on the device and needs no
 * breakdown of internal object types.
 *
 * The wording is asserted against source: the surrounding file is 6,000 lines of
 * browser globals, and these strings are the whole point of the change, so a
 * revert should fail here rather than be noticed on a phone. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "scripts", "gd-course-library-pin-lock.js");
const src = fs.readFileSync(LIB, "utf8");
/* The words themselves now live in the translation base (scripts/i18n/en.js);
   the code names them by key. Wording checks read both. */
const english = fs.readFileSync(path.join(ROOT, "scripts", "i18n", "en.js"), "utf8");
const words = src + "\n" + english;

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
  const left = RETIRED.filter(s => words.includes(s));
  assert.deepStrictEqual(left, [], "still present in source: " + left.join(" | "));
});

test("the object-type breakdown builder is gone entirely", () => {
  assert.ok(
    !/courseSummaryLine/.test(src),
    "leaving it defined invites the next surface to render '3 green targets · 2 bunkers' again"
  );
});

test("the library describes itself as device storage", () => {
  assert.ok(/"course\.librarySubtitle": "[^"]*this device[^"]*"/.test(english), "library subtitle must say what it is");
  assert.ok(/"course\.libraryTitle": "Course Library"/.test(english), "library heading must be the plain one");
});

/* The "Playing at..." confirmation sheet had no way to open it - nothing called
   gdChangeAssumedCourse - and it was the only reader of the whole published
   library on the device, which the device no longer holds. */
test("the unreachable confirmation sheet is gone", () => {
  assert.ok(!/gdCourseConfirmOverlay|renderCourseConfirmation|nearbySavedCourses/.test(src),
    "it listed every published course within 1.4km, which needs the whole library on the phone");
});

test("the mapper has no entry point left in the library", () => {
  assert.ok(!/gdCLOpenCourseFromLibrary/.test(src), "the mapping-mode door must be gone, not merely hidden");
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
