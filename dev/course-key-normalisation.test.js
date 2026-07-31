/* Course key normalisation.
 *
 * The same course used to land under several keys - "maungakiekie-golf-club",
 * "Maungakiekie_Golf_Club", "cromwell" and "cromwell-golf-course" all coexisted -
 * because producers upstream disagreed and the write path stored the key raw
 * while the read path slugged it. Anything written under a raw key was therefore
 * unreadable: the pull looked for a slug that did not exist.
 *
 * The captured-surface sync path (client module + server function) was deleted
 * 2026-07-31 with the rest of the authoring stack. The surviving normaliser is
 * the camera's canonicalCourseKey(), which derives both the manifest key and the
 * published-visual lookup - the miss that once hid 18 published play surfaces
 * ("Akarana_Golf_Club" vs "akarana-golf-club"). These lock its behaviour. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* The normaliser is module-private, so read the source and evaluate the
   function in isolation. */
function cameraCourseKey() {
  const src = fs.readFileSync(
    path.join(ROOT, "scripts", "inline", "gd-captured-hole-frame-camera-v19.js"), "utf8");
  const match = src.match(/function canonicalCourseKey\(value\)\{[\s\S]*?\n\t  \}/);
  assert.ok(match, "canonicalCourseKey must exist in the captured-frame camera");
  // eslint-disable-next-line no-new-func
  return new Function(match[0].replace(/\t/g, " ") + "; return canonicalCourseKey;")();
}

test("the historical drifted keys all collapse to one canonical key", () => {
  const cam = cameraCourseKey();
  const maungakiekie = ["maungakiekie-golf-club", "Maungakiekie_Golf_Club", "Maungakiekie Golf Club"];
  const keys = new Set(maungakiekie.map(cam));
  assert.strictEqual(
    keys.size, 1,
    "every historical spelling must normalise to a single key, got: " + Array.from(keys).join(", ")
  );
  assert.strictEqual(Array.from(keys)[0], "maungakiekie-golf-club");
});

test("raw underscore and capitalised forms normalise", () => {
  const cam = cameraCourseKey();
  assert.strictEqual(cam("Redlands_Country_Club"), "redlands-country-club");
  assert.strictEqual(cam("Takapuna Golf Course"), "takapuna-golf-course");
  assert.strictEqual(cam("  Windross Farm Golf Course  "), "windross-farm-golf-course");
  ["Akarana Golf Club", "Akarana_Golf_Club", "akarana-golf-club", "  Akarana Golf Club  "]
    .forEach((form) => assert.strictEqual(cam(form), "akarana-golf-club", "camera must canonicalise " + form));
});

test("courses differing only by suffix stay distinct", () => {
  const cam = cameraCourseKey();
  /* This is why the plain slug is canonical rather than the picker's stripped
     form: stripping "golf course"/"links" would collapse these into one. */
  assert.notStrictEqual(
    cam("Takapuna Golf Course"), cam("Takapuna Links"),
    "distinct courses at the same place must not share a key"
  );
});

test("empty and junk input falls back rather than producing an empty key", () => {
  const cam = cameraCourseKey();
  assert.strictEqual(cam(""), "course");
  assert.strictEqual(cam(null), "course");
  assert.strictEqual(cam("---"), "course");
  assert.strictEqual(cam("!!!"), "course");
});

test("normalisation is idempotent", () => {
  const cam = cameraCourseKey();
  ["Takapuna Golf Course", "Maungakiekie_Golf_Club", "cromwell"].forEach(function (input) {
    assert.strictEqual(cam(cam(input)), cam(input), "slugging twice must not change the key: " + input);
  });
});

test("composite storage keys never leak into course names", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "scripts", "inline", "gd-captured-hole-frame-camera-v19.js"), "utf8");
  const idx = src.indexOf("function surfaceCourseName(");
  assert.notStrictEqual(idx, -1, "could not find surfaceCourseName in the camera");
  const body = src.slice(idx, idx + 700);
  /* Only inspect the resolution expression, not the explanatory comment. */
  const expr = body.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/currentCourse\.(key|id)\b/.test(expr),
    "surfaceCourseName must not fall through to .key or .id - on a stored "
    + "record those are the composite `${userId}::${courseId}` storage key"
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
    console.error("course-key-normalisation failed: " + failed + "/" + tests.length);
    process.exit(1);
  }
  console.log("course-key-normalisation passed: " + tests.length + " checks");
})();
