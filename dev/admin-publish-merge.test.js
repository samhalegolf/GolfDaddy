/* Admin course-map publish must not destroy holes it did not touch.
 *
 * The admin path replaced the published course wholesale, so publishing a
 * session that had only 4 holes mapped wiped the 13 that were already published.
 * A 17-hole course collapsed to 4 and play could only load those 4 - the exact
 * "scans work but play doesn't pick up" symptom, because the raw scans stayed
 * intact in captured_surfaces while the published play map lost 13 holes.
 *
 * These lock the union behaviour: existing holes survive, incoming holes are
 * added, and a genuine conflict lets the admin's new version win. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "functions", "course-maps.mjs"), "utf8");

/* Lift mergeAdminPublish out and run it directly. */
function loadMerge() {
  const idx = SRC.indexOf("function mergeAdminPublish(existing, incoming)");
  assert.notStrictEqual(idx, -1, "mergeAdminPublish must exist");
  const end = SRC.indexOf("\nfunction mergeGeneratedCourse", idx);
  const body = SRC.slice(idx, end);
  // eslint-disable-next-line no-new-func
  return new Function(body + "\nreturn mergeAdminPublish;")();
}

const mergeAdminPublish = loadMerge();
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function holeMap(nums) {
  const h = {};
  nums.forEach(function (n) { h[n] = { holeNumber: n, green: "g" + n }; });
  return h;
}
function objMap(ids) {
  const o = {};
  ids.forEach(function (id) { o[id] = { id: id }; });
  return o;
}

test("publishing 4 holes over an existing 17 keeps all 17", () => {
  const existing = { id: "published::takapuna", holes: holeMap([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]), objects: objMap(["a","b"]) };
  const incoming = { id: "published::takapuna", holes: holeMap([1,2,3,4]), objects: objMap(["a"]) };
  const result = mergeAdminPublish(existing, incoming);
  const holes = Object.keys(result.course.holes).map(Number).sort(function (a, b) { return a - b; });
  assert.strictEqual(holes.length, 17, "a partial re-publish must not delete the other holes; got " + holes.length);
  assert.strictEqual(holes[16], 17, "hole 17 must survive a 4-hole publish");
});

test("new holes from the payload are added", () => {
  const existing = { holes: holeMap([1,2,3]), objects: {} };
  const incoming = { holes: holeMap([3,4,5]), objects: {} };
  const result = mergeAdminPublish(existing, incoming);
  const holes = Object.keys(result.course.holes).map(Number).sort(function (a, b) { return a - b; });
  assert.deepStrictEqual(holes, [1,2,3,4,5], "the union of existing and incoming holes");
});

test("on a real conflict, the admin's incoming version wins", () => {
  const existing = { holes: { 1: { holeNumber: 1, green: "old" } }, objects: {} };
  const incoming = { holes: { 1: { holeNumber: 1, green: "new" } }, objects: {} };
  const result = mergeAdminPublish(existing, incoming);
  assert.strictEqual(result.course.holes[1].green, "new", "admin is authoritative for a hole it re-mapped");
});

test("objects union the same way", () => {
  const existing = { holes: {}, objects: objMap(["a","b","c"]) };
  const incoming = { holes: {}, objects: objMap(["c","d"]) };
  const result = mergeAdminPublish(existing, incoming);
  assert.deepStrictEqual(Object.keys(result.course.objects).sort(), ["a","b","c","d"], "no object is dropped");
});

test("a brand-new course with no existing map is published as-is", () => {
  const incoming = { id: "published::new", holes: holeMap([1,2]), objects: objMap(["x"]) };
  const result = mergeAdminPublish(null, incoming);
  assert.strictEqual(Object.keys(result.course.holes).length, 2);
  assert.strictEqual(result.accepted.course, 1);
});

test("incoming top-level fields (name, publisher) still take effect", () => {
  const existing = { courseName: "Old Name", holes: holeMap([1]), objects: {} };
  const incoming = { courseName: "Takapuna Golf Course", holes: holeMap([2]), objects: {} };
  const result = mergeAdminPublish(existing, incoming);
  assert.strictEqual(result.course.courseName, "Takapuna Golf Course", "admin can still correct course-level fields");
  assert.strictEqual(Object.keys(result.course.holes).length, 2, "while still preserving holes");
});

test("the admin path no longer replaces wholesale", () => {
  assert.ok(
    /adminActor\s*\?\s*mergeAdminPublish\(/.test(SRC),
    "the POST handler must route admin publishes through the non-destructive merge, not { course }"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("admin-publish-merge failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("admin-publish-merge passed: " + tests.length + " checks");
})();
