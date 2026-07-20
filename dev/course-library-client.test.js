/* Client side of the course library cache.
 *
 * The local library mirrors the published courses so play starts fast. Checking
 * whether it is stale must not cost what re-downloading costs, or the cache
 * earns nothing: /api/course-maps returns every course's full objects and holes
 * - hundreds of kilobytes - and it was being fetched on every course entry just
 * to discover nothing had changed.
 *
 * The manifest answers the same question in well under a kilobyte. These lock
 * the comparison logic and, more importantly, that the expensive call is
 * actually skipped when the library is current. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PIN_LOCK = path.join(ROOT, "scripts", "gd-course-library-pin-lock.js");
const src = fs.readFileSync(PIN_LOCK, "utf8");
const SERVER = path.join(ROOT, "functions", "course-library.mjs");
const serverSrc = fs.readFileSync(SERVER, "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Lift the two pure functions out and run them with publishedCourses stubbed. */
function loadComparer(localCourses) {
  function extract(signature) {
    const idx = src.indexOf(signature);
    assert.notStrictEqual(idx, -1, "could not find " + signature);
    const end = src.indexOf("\n  }", idx);
    assert.notStrictEqual(end, -1, "could not bound " + signature);
    return src.slice(idx, end + 4);
  }
  const code = extract("function localObjectsVersion(course)") + "\n"
    + extract("function courseLibraryFreshness(manifest)");
  const scope = {
    publishedCourses: function () { return localCourses; },
    slug: function (s) { return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  };
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const build = new Function(names.join(","), code + "\nreturn {courseLibraryFreshness:courseLibraryFreshness,localObjectsVersion:localObjectsVersion};");
  return build.apply(null, names.map(function (n) { return scope[n]; }));
}

function manifestOf(entries) {
  return { configured: true, serverTime: "2026-07-20T05:00:00.000Z", courses: entries };
}

test("a course whose server version is newer is stale", () => {
  const api = loadComparer([{ courseId: "takapuna", publishedAt: "2026-07-20T01:00:00.000Z", updatedAt: "2026-07-20T01:00:00.000Z" }]);
  const f = api.courseLibraryFreshness(manifestOf([{ course_id: "takapuna", objects_version: "2026-07-20T02:51:59.000Z" }]));
  assert.deepStrictEqual(f.stale, ["takapuna"]);
  assert.deepStrictEqual(f.current, []);
});

test("a course at the same version is current", () => {
  const api = loadComparer([{ courseId: "takapuna", publishedAt: "2026-07-20T02:51:59.000Z", updatedAt: "2026-07-20T02:51:59.000Z" }]);
  const f = api.courseLibraryFreshness(manifestOf([{ course_id: "takapuna", objects_version: "2026-07-20T02:51:59.000Z" }]));
  assert.deepStrictEqual(f.current, ["takapuna"]);
  assert.deepStrictEqual(f.stale, []);
});

test("a course the device has never seen is missing, not stale", () => {
  const api = loadComparer([]);
  const f = api.courseLibraryFreshness(manifestOf([{ course_id: "pupuke", objects_version: "2026-07-20T01:36:46.000Z" }]));
  assert.deepStrictEqual(f.missing, ["pupuke"]);
  assert.deepStrictEqual(f.stale, []);
});

test("an older server version does not overwrite a newer local one", () => {
  const api = loadComparer([{ courseId: "takapuna", publishedAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" }]);
  const f = api.courseLibraryFreshness(manifestOf([{ course_id: "takapuna", objects_version: "2026-07-20T02:00:00.000Z" }]));
  assert.deepStrictEqual(
    f.stale, [],
    "a local publish that has not synced yet must not be treated as out of date"
  );
});

test("local version uses the newest of publishedAt and updatedAt", () => {
  const api = loadComparer([]);
  assert.strictEqual(
    api.localObjectsVersion({ publishedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" }),
    "2026-06-01T00:00:00.000Z"
  );
  assert.strictEqual(api.localObjectsVersion({ publishedAt: "2026-06-01T00:00:00.000Z" }), "2026-06-01T00:00:00.000Z");
  assert.strictEqual(api.localObjectsVersion({}), "");
});

test("client and server compute the version the same way", () => {
  /* If these diverge, every course looks permanently stale and the cache is
     worse than useless - it would re-download on every entry. */
  assert.ok(/function objectsVersion\(row\)/.test(serverSrc), "server helper must exist");
  assert.ok(/published > updated \? published : updated/.test(serverSrc), "server takes the newer of the two");
  assert.ok(/published>updated\?published:updated/.test(src), "client must take the newer of the two as well");
});

test("no manifest means no conclusion - never assume current", () => {
  const api = loadComparer([{ courseId: "takapuna", publishedAt: "2026-01-01T00:00:00.000Z" }]);
  const f = api.courseLibraryFreshness(null);
  assert.strictEqual(f.checked, false, "an unreachable manifest must not read as 'everything is fresh'");
});

test("the expensive full pull is skipped only when nothing changed", () => {
  const idx = src.indexOf("async function syncPublishedCourseMaps(");
  assert.notStrictEqual(idx, -1);
  const fn = src.slice(idx, idx + 1800);
  assert.ok(/fetchCourseLibraryManifest\(\)/.test(fn), "the manifest must be consulted first");
  assert.ok(
    /freshness\.checked&&!freshness\.stale\.length&&!freshness\.missing\.length/.test(fn),
    "the skip must require a successful check AND nothing stale AND nothing missing"
  );
  const skipAt = fn.indexOf("return loadPublishedStore();");
  const pullAt = fn.indexOf("await fetch(PUBLISHED_COURSE_API");
  assert.ok(skipAt !== -1 && pullAt !== -1 && skipAt < pullAt, "the skip must short-circuit before the full pull");
});

test("a caller can force a full pull", () => {
  const idx = src.indexOf("async function syncPublishedCourseMaps(");
  const fn = src.slice(idx, idx + 1800);
  assert.ok(
    /opts\.force!==true/.test(fn),
    "publish flows need a way to re-read what the server now holds regardless of versions"
  );
});

test("the freshness result is observable", () => {
  assert.ok(/window\.GDCourseLibrary\s*=/.test(src), "must expose an API for UI and on-device diagnosis");
  assert.ok(/updateAvailable:function\(\)/.test(src), "'new map update available' needs a single source of truth");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("course-library-client failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("course-library-client passed: " + tests.length + " checks");
})();
