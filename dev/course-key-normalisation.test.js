/* Course key normalisation.
 *
 * The same course used to land under several keys - "maungakiekie-golf-club",
 * "Maungakiekie_Golf_Club", "cromwell" and "cromwell-golf-course" all coexisted -
 * because producers upstream disagreed and the write path stored the key raw
 * while the read path slugged it. Anything written under a raw key was therefore
 * unreadable: the pull looked for a slug that did not exist.
 *
 * These lock the two properties that matter: writes are normalised, and reads
 * normalise identically so a pull finds what a push stored. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "functions", "captured-surface-sync.js");
const UTILS = path.join(ROOT, "functions", "payment-utils.js");

function loadFunction(capture) {
  [FN].forEach(function (p) { delete require.cache[p]; });
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === FN) {
      if (request === "./alert-utils") return { sendSystemAlert: async function () {} };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(FN);
  } finally {
    Module._load = originalLoad;
  }
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* The normaliser is module-private, so exercise it through the exported surface
   by reading the source and evaluating the function in isolation. */
function courseKeySlug() {
  const fs = require("fs");
  const src = fs.readFileSync(FN, "utf8");
  const match = src.match(/function courseKeySlug\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "courseKeySlug must exist in the sync function");
  // eslint-disable-next-line no-new-func
  return new Function(match[0] + "; return courseKeySlug;")();
}

test("the historical drifted keys all collapse to one canonical key", () => {
  const slug = courseKeySlug();
  const maungakiekie = ["maungakiekie-golf-club", "Maungakiekie_Golf_Club", "Maungakiekie Golf Club"];
  const keys = new Set(maungakiekie.map(slug));
  assert.strictEqual(
    keys.size, 1,
    "every historical spelling must normalise to a single key, got: " + Array.from(keys).join(", ")
  );
  assert.strictEqual(Array.from(keys)[0], "maungakiekie-golf-club");
});

test("raw underscore and capitalised forms normalise", () => {
  const slug = courseKeySlug();
  assert.strictEqual(slug("Redlands_Country_Club"), "redlands-country-club");
  assert.strictEqual(slug("Takapuna Golf Course"), "takapuna-golf-course");
  assert.strictEqual(slug("  Windross Farm Golf Course  "), "windross-farm-golf-course");
});

/* The camera derives its manifest key AND its published-visual lookup from
   surfaceCourseKey(), whose fallback chain ends at a display name. Its key builder
   preserves case, so "Akarana Golf Club" became "Akarana_Golf_Club" while the rest
   of the app used "akarana-golf-club" - and engine.getRecord() therefore missed 18
   published per-hole play surfaces that were sitting in course_visuals. Same defect
   this file already covers for the sync path, one file over. */
function cameraCourseKey() {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "inline", "gd-captured-hole-frame-camera-v19.js"), "utf8");
  const match = src.match(/function canonicalCourseKey\(value\)\{[\s\S]*?\n\t  \}/);
  assert.ok(match, "canonicalCourseKey must exist in the captured-frame camera");
  // eslint-disable-next-line no-new-func
  return new Function(match[0].replace(/\t/g, " ") + "; return canonicalCourseKey;")();
}

test("the camera normalises course keys identically to the sync path", () => {
  const cam = cameraCourseKey();
  const slug = courseKeySlug();
  ["Akarana Golf Club", "Akarana_Golf_Club", "akarana-golf-club", "  Akarana Golf Club  "]
    .forEach((form) => assert.strictEqual(cam(form), "akarana-golf-club", "camera must canonicalise " + form));
  ["Maungakiekie_Golf_Club", "Takapuna Golf Course", "Redlands_Country_Club"]
    .forEach((form) => assert.strictEqual(cam(form), slug(form),
      "camera and sync must agree on " + form + " or a push and a pull disagree"));
});

test("courses differing only by suffix stay distinct", () => {
  const slug = courseKeySlug();
  /* This is why the plain slug is canonical rather than the picker's stripped
     form: stripping "golf course"/"links" would collapse these into one. */
  assert.notStrictEqual(
    slug("Takapuna Golf Course"), slug("Takapuna Links"),
    "distinct courses at the same place must not share a key"
  );
});

test("empty and junk input falls back rather than producing an empty key", () => {
  const slug = courseKeySlug();
  assert.strictEqual(slug(""), "course");
  assert.strictEqual(slug(null), "course");
  assert.strictEqual(slug("---"), "course");
  assert.strictEqual(slug("!!!"), "course");
});

test("normalisation is idempotent", () => {
  const slug = courseKeySlug();
  ["Takapuna Golf Course", "Maungakiekie_Golf_Club", "cromwell"].forEach(function (input) {
    assert.strictEqual(slug(slug(input)), slug(input), "slugging twice must not change the key: " + input);
  });
});

test("the client write path slugs the key too", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "scripts", "gd-captured-surface-sync.js"), "utf8");
  assert.ok(
    /course_key:\s*slug\(scan\.courseKey\)/.test(src),
    "scanToPayload must slug course_key, or local and remote keys diverge"
  );
});

test("the server read path slugs before filtering", () => {
  const fs = require("fs");
  const src = fs.readFileSync(FN, "utf8");
  const scope = src.match(/function scopeFilter\(payload\) \{[\s\S]*?\n\}/);
  assert.ok(scope, "scopeFilter must exist");
  assert.ok(
    /courseKeySlug\(/.test(scope[0]),
    "scopeFilter must normalise, or a pull misses scans stored under the canonical key"
  );
});

test("the server write path slugs before storing", () => {
  const fs = require("fs");
  const src = fs.readFileSync(FN, "utf8");
  const norm = src.match(/function normaliseScan\(row, payload\) \{[\s\S]*?\n\}/);
  assert.ok(norm, "normaliseScan must exist");
  assert.ok(
    /courseKeySlug\(/.test(norm[0]) && /course_key:\s*courseKey\b/.test(norm[0]),
    "normaliseScan must slug course_key - older installed builds still send raw keys"
  );
});

test("scans with no course identity are rejected server-side", () => {
  const src = fs.readFileSync(FN, "utf8");
  const norm = src.match(/function normaliseScan\(row, payload\) \{[\s\S]*?\n\}/);
  assert.ok(norm, "normaliseScan must exist");
  assert.ok(
    /courseKey === "course"/.test(norm[0]) && /return null/.test(norm[0]),
    "an unidentified scan must be rejected - every one slugs to \"course\" and would "
    + "merge with unrelated captures under a single key"
  );
});

test("the client does not push unidentified scans", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "gd-captured-surface-sync.js"), "utf8");
  assert.ok(/function scanIsIdentified\(/.test(src), "scanIsIdentified must exist");
  assert.ok(
    /if \(!scanIsIdentified\(scan\)\) return null;/.test(src),
    "scanToPayload must drop unidentified scans before they are queued"
  );
});

test("composite storage keys never leak into course names", () => {
  [
    ["scripts/inline/gd-captured-hole-frame-camera-v19.js", "function surfaceCourseName("],
    ["scripts/inline/gd-captured-surface-model-v1.js", "manifest.courseName=manifest.courseName||"],
    ["scripts/inline/gd-captured-surface-model-v1.js", "function currentCourseKey("]
  ].forEach(function (entry) {
    const src = fs.readFileSync(path.join(ROOT, entry[0]), "utf8");
    const idx = src.indexOf(entry[1]);
    assert.notStrictEqual(idx, -1, "could not find " + entry[1] + " in " + entry[0]);
    const body = src.slice(idx, idx + 700);
    /* Only inspect the resolution expression, not the explanatory comment. */
    const expr = body.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
      !/currentCourse\.(key|id)\b/.test(expr),
      entry[0] + " / " + entry[1] + " must not fall through to .key or .id - on a stored "
      + "record those are the composite `${userId}::${courseId}` storage key"
    );
  });
});

test("the sync function still loads", () => {
  const mod = loadFunction();
  assert.strictEqual(typeof mod.handler, "function", "handler must still be exported");
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
