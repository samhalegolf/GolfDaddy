/* Client side of the course library cache.
 *
 * The local library holds the published courses this device has opened, so play
 * starts fast. Checking
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
/* objectsVersion() moved out of course-library.mjs into the package shape module
   when the package endpoint started needing the same value; this test kept
   reading the old file and failed on a helper that had simply relocated. */
const SERVER = path.join(ROOT, "functions", "lib", "gd-course-package-shape.mjs");
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
  assert.ok(/function objectsVersion\(map\)/.test(serverSrc), "server helper must exist");
  assert.ok(/published > updated \? published : updated/.test(serverSrc), "server takes the newer of the two");
  assert.ok(/published>updated\?published:updated/.test(src), "client must take the newer of the two as well");
});

test("no manifest means no conclusion - never assume current", () => {
  const api = loadComparer([{ courseId: "takapuna", publishedAt: "2026-01-01T00:00:00.000Z" }]);
  const f = api.courseLibraryFreshness(null);
  assert.strictEqual(f.checked, false, "an unreachable manifest must not read as 'everything is fresh'");
});

/* Runs the real sync against a stubbed manifest and records which courses it
   asks the server for. */
async function syncAsks(held, manifestEntries, opts) {
  function extract(signature) {
    const idx = src.indexOf(signature);
    assert.notStrictEqual(idx, -1, "could not find " + signature);
    const end = src.indexOf("\n  }", idx);
    return src.slice(idx, end + 4);
  }
  const code = ["function localObjectsVersion(course)", "function courseLibraryFreshness(manifest)",
    "function uniqueSlugs(values)", "async function runPublishedCourseMapSync(opts={})"].map(extract).join("\n");
  const asked = [];
  const scope = {
    fetch: function () {},
    PUBLISHED_SUBSET_SYNC_MAX: 24,
    lastCourseLibraryFreshness: null,
    publishedCourses: function () { return held; },
    slug: function (v) { return String(v || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); },
    pruneUnopenedPublishedCourses: function () {},
    fetchCourseLibraryManifest: async function () { return manifestEntries ? manifestOf(manifestEntries) : null; },
    fetchPublishedCourseSubset: async function (ids) { asked.push.apply(asked, ids); return null; },
    loadPublishedStore: function () { return { courses: {} }; },
    mergePublishedStore: function (x) { return x; },
    renderCourseLibraryPanel: function () {}
  };
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const run = new Function(names.join(","), code + "\nreturn runPublishedCourseMapSync;").apply(null, names.map(function (n) { return scope[n]; }));
  await run(opts || {});
  return asked.sort();
}

const HELD = [{ courseId: "takapuna", publishedAt: "2026-07-20T01:00:00.000Z" }];
const LISTED = [
  { course_id: "takapuna", objects_version: "2026-07-20T01:00:00.000Z" },
  { course_id: "pupuke", objects_version: "2026-07-20T01:00:00.000Z" },
  { course_id: "derllys-court", objects_version: "2026-07-20T01:00:00.000Z" }
];

test("a sync never pulls courses nobody opened", async () => {
  /* Every published course the device has never seen used to count as missing,
     and the device pulled them all - the whole library, on every phone. */
  assert.deepStrictEqual(await syncAsks(HELD, LISTED), []);
  assert.ok(!/fetch\(PUBLISHED_COURSE_API\+'\?scope=play'[,)]/.test(src), "no whole-library request is left");
});

test("the course being opened is fetched by id when not held", async () => {
  assert.deepStrictEqual(await syncAsks(HELD, LISTED, { courseIds: ["derllys-court", "derllys-court-golf-club"] }), ["derllys-court"],
    "only ids the server publishes - a name-derived key is not asked for");
});

test("held courses that moved on are refreshed", async () => {
  const moved = LISTED.map(e => e.course_id === "takapuna" ? Object.assign({}, e, { objects_version: "2026-07-21T00:00:00.000Z" }) : e);
  assert.deepStrictEqual(await syncAsks(HELD, moved), ["takapuna"]);
});

test("a held, current course is only re-read when forced", async () => {
  assert.deepStrictEqual(await syncAsks(HELD, LISTED, { courseIds: ["takapuna"] }), []);
  assert.deepStrictEqual(await syncAsks(HELD, LISTED, { courseIds: ["takapuna"], force: true }), ["takapuna"]);
});

test("with no manifest, only the course being opened is asked for", async () => {
  assert.deepStrictEqual(await syncAsks(HELD, null, { courseIds: ["pupuke"] }), ["pupuke"]);
  assert.deepStrictEqual(await syncAsks(HELD, null), []);
});

test("a phone that holds the whole library keeps only what it opened, once", () => {
  const idx = src.indexOf("function pruneUnopenedPublishedCourses(keepIds)");
  const code = src.slice(idx, src.indexOf("\n  }", idx) + 4)
    + "\n" + src.slice(src.indexOf("function uniqueSlugs(values)"), src.indexOf("\n  }", src.indexOf("function uniqueSlugs(values)")) + 4);
  let store = { courses: {
    "published::takapuna": { courseId: "takapuna" },
    "published::pupuke": { courseId: "pupuke" },
    "published::derllys-court": { courseId: "derllys-court" },
    "published::cromwell": { courseId: "cromwell" }
  } };
  let saves = 0;
  const scope = {
    slug: function (v) { return String(v || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); },
    loadPublishedStore: function () { return JSON.parse(JSON.stringify(store)); },
    savePublishedStore: function (next) { saves += 1; store = next; },
    loadStore: function () { return { courses: { "u::takapuna": { courseId: "takapuna" } } }; },
    downloadedCourseEntries: function () { return [{ courseId: "pupuke" }]; }
  };
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const prune = new Function(names.join(","), code + "\nreturn pruneUnopenedPublishedCourses;").apply(null, names.map(function (n) { return scope[n]; }));
  prune(["derllys-court"]);
  assert.deepStrictEqual(Object.keys(store.courses).sort(),
    ["published::derllys-court", "published::pupuke", "published::takapuna"],
    "own library, offline downloads and the course being opened stay; the rest goes");
  prune([]);
  assert.strictEqual(saves, 1, "it runs once - after that the store only ever holds opened courses");
});

test("a caller can force a re-read", () => {
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
