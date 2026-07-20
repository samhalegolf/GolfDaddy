/* What may be pushed to the database.
 *
 * pendingPayloads walks the entire local registry, so anything sitting there
 * becomes an upload candidate. Two kinds must never be sent:
 *
 *  - cloud-hydrated scans. They came FROM the database. Re-uploading them churned
 *    updated_at on every course entry, which made a course jump to the top of the
 *    admin list just for being opened, and left freshly pulled scans looking
 *    unsynced. Confirmed on device: pullCourse:OK pulled=17, then updated_at
 *    moved six seconds later with created_at unchanged.
 *
 *  - unidentified scans. Every one slugs to "course" and would merge with
 *    unrelated captures under a single key.
 *
 * A local re-capture replaces the registry entry with a fresh scan carrying no
 * cloudHydrated flag, so real edits still upload. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SYNC = path.join(ROOT, "scripts", "gd-captured-surface-sync.js");
const src = fs.readFileSync(SYNC, "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Evaluate the real predicates rather than restating them. */
function predicate(name) {
  const idx = src.indexOf("function " + name + "(");
  assert.notStrictEqual(idx, -1, name + " must exist");
  const end = src.indexOf("\n  }", idx);
  const body = src.slice(idx, end + 4);
  const slug = "function slug(v){return String(v||'course').toLowerCase().trim()"
    + ".replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'course';}";
  // eslint-disable-next-line no-new-func
  return new Function(slug + "\n" + body + "\nreturn " + name + ";")();
}

test("a cloud-hydrated scan is never pushed back", () => {
  const isCloud = predicate("scanIsCloudHydrated");
  assert.strictEqual(
    isCloud({ id: "x", courseKey: "takapuna", source: { cloudHydrated: true } }), true,
    "a scan pulled from the database must be recognised as cloud-hydrated"
  );
});

test("a locally captured scan is still pushed", () => {
  const isCloud = predicate("scanIsCloudHydrated");
  assert.strictEqual(
    isCloud({ id: "x", courseKey: "takapuna", source: { type: "leaflet-tile-capture" } }), false,
    "a local capture must remain uploadable or new courses never reach the database"
  );
  assert.strictEqual(isCloud({ id: "x", courseKey: "takapuna" }), false, "no source object means local");
});

test("an unidentified scan is never pushed", () => {
  const isIdentified = predicate("scanIsIdentified");
  assert.strictEqual(isIdentified({ courseKey: "" }), false);
  assert.strictEqual(isIdentified({ courseKey: "course" }), false);
  assert.strictEqual(isIdentified({ courseKey: "Takapuna Golf Course" }), true);
});

test("scanToPayload applies both filters before building a payload", () => {
  const idx = src.indexOf("function scanToPayload(");
  const fn = src.slice(idx, idx + 700);
  assert.ok(/if \(!scanIsIdentified\(scan\)\) return null;/.test(fn), "identity filter must run");
  assert.ok(/if \(scanIsCloudHydrated\(scan\)\) return null;/.test(fn), "cloud-hydrated filter must run");
});

test("the pull still marks imported scans as cloud-hydrated", () => {
  assert.ok(
    /cloudHydrated: true/.test(src),
    "cloudScanToLocal must keep setting cloudHydrated, or the filter above matches nothing"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("scan-push-filter failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("scan-push-filter passed: " + tests.length + " checks");
})();
