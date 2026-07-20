/* Course identity resolution.
 *
 * Regression guard for a bug where selecting any course with a stored library
 * record navigated to Akarana instead. The chain was:
 *
 *   ensureCourse stores {id,userId,courseId,courseName,...} - no .name
 *   -> rawCourseName read only .name, so it returned 'Manual GPS'
 *   -> isManualGpsCourse was true for EVERY stored record
 *   -> sessionCourse substituted nearestKnownCourse, which in Auckland is Akarana
 *   -> the whole app then treated Akarana as the current course and scanned it
 *
 * Separately, scans persisted under "user-<playerid>::<courseid>" because
 * surfaceCourseKey preferred .id, which on a stored record is the composite
 * storage key rather than the course identity.
 *
 * These files are huge and depend on live browser globals, so the mechanism is
 * asserted against the source rather than executed. The behaviour itself needs a
 * device check - see docs/NATIVE_SHELL.md. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PIN_LOCK = path.join(ROOT, "scripts", "gd-course-library-pin-lock.js");
const CAMERA = path.join(ROOT, "scripts", "inline", "gd-captured-hole-frame-camera-v19.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function readFn(file, signature, span) {
  const src = fs.readFileSync(file, "utf8");
  const idx = src.indexOf(signature);
  assert.notStrictEqual(idx, -1, "could not find: " + signature);
  /* Generous span: these functions carry long explanatory comments before the
     expression being asserted on. */
  return src.slice(idx, idx + (span || 1200));
}

test("stored library records are created with courseName and no name field", () => {
  const src = fs.readFileSync(PIN_LOCK, "utf8");
  const idx = src.indexOf("store.courses[key]={");
  assert.notStrictEqual(idx, -1, "ensureCourse record literal must exist");
  const record = src.slice(idx, idx + 400);
  assert.ok(/courseName:/.test(record), "record must carry courseName");
  assert.ok(
    !/(^|[^a-zA-Z])name:/.test(record.replace(/courseName:/g, "")),
    "record must NOT carry a bare name field - that asymmetry is what caused the bug"
  );
});

test("rawCourseName falls back to courseName before declaring Manual GPS", () => {
  const fn = readFn(PIN_LOCK, "function rawCourseName(");
  assert.ok(
    /course\?\.name\s*\|\|\s*course\?\.courseName/.test(fn),
    "rawCourseName must read courseName too, or every stored record becomes Manual GPS "
    + "and sessionCourse substitutes the nearest built-in course"
  );
});

test("a stored record no longer classifies as Manual GPS", () => {
  /* Evaluate the real expression against the real record shape. */
  const fn = readFn(PIN_LOCK, "function rawCourseName(");
  const body = fn.match(/return String\((.*?)\);/);
  assert.ok(body, "rawCourseName must return a String(...) expression");
  const expr = body[1].replace(/course\?\./g, "c.");
  // eslint-disable-next-line no-new-func
  const resolve = new Function("c", "return String(" + expr + ");");

  const storedRecord = {
    id: "user-demo-player::te-puke",
    userId: "user-demo-player",
    courseId: "te-puke",
    courseName: "Te Puke Golf Club"
  };
  assert.strictEqual(
    resolve(storedRecord), "Te Puke Golf Club",
    "a stored record must resolve to its own name, not Manual GPS"
  );

  const pickerPayload = { name: "Takapuna Golf Course", courseId: "takapuna-golf-course" };
  assert.strictEqual(
    resolve(pickerPayload), "Takapuna Golf Course",
    "live picker payloads use .name and must still resolve"
  );

  const genuineManual = { courseId: "manual-gps" };
  assert.strictEqual(
    resolve(genuineManual), "Manual GPS",
    "a session with no course identity at all must still fall back to Manual GPS"
  );
});

test("surfaceCourseKey prefers courseId over the composite storage id", () => {
  const fn = readFn(CAMERA, "function surfaceCourseKey(");
  const order = ["courseId", "key", "id", "name"]
    .map(function (field) { return { field: field, at: fn.indexOf("currentCourse." + field) }; })
    .filter(function (entry) { return entry.at !== -1; });
  assert.ok(order.length >= 2, "surfaceCourseKey must read several candidate fields");
  assert.strictEqual(
    order[0].field, "courseId",
    "courseId must be read first - .id on a stored record is `${userId}::${courseId}`, "
    + "which leaks a per-user storage key into captured_surfaces"
  );
});

test("the composite storage key is still built the same way", () => {
  /* If this changes, the surfaceCourseKey reasoning above needs revisiting. */
  const fn = readFn(PIN_LOCK, "function courseKey(");
  assert.ok(
    /\$\{uid\}::\$\{cid\}/.test(fn),
    "courseKey is expected to remain `${uid}::${cid}` - update the guard if it changes"
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
    console.error("course-identity-resolution failed: " + failed + "/" + tests.length);
    process.exit(1);
  }
  console.log("course-identity-resolution passed: " + tests.length + " checks");
})();
