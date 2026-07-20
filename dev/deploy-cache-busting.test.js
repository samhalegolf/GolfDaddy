/* The deploy build must content-hash every script/style ?v=.
 *
 * The manual ?v= strings in index.html are cache keys: a browser caches a script
 * under its ?v=, so editing a script without bumping its ?v= leaves returning
 * users on the old cached copy. A day of edits with unbumped versions produced a
 * mismatched build - new index.html loading stale modules - which silently broke
 * the course picker and Supabase for returning users while a fresh browser saw
 * nothing wrong.
 *
 * Content-hash stamping at build time removes the manual step: a changed file
 * gets a new ?v= automatically. These verify the build actually does it, so the
 * failure cannot recur unnoticed. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST_INDEX = path.join(ROOT, "dist", "index.html");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Build once, then assert against the output. */
function ensureBuilt() {
  execFileSync("node", ["scripts/clarity-deploy-build.js"], { cwd: ROOT, stdio: "pipe" });
  return fs.readFileSync(DIST_INDEX, "utf8");
}

const html = ensureBuilt();

test("every deployed script/style ref is content-hashed", () => {
  const refs = html.match(/(?:src|href)="(?:scripts|styles)\/[^"?]+\.(?:js|css)\?v=[^"]*"/g) || [];
  assert.ok(refs.length > 20, "expected many hashed assets, found " + refs.length);
  const notHashed = refs.filter(function (r) { return !/\?v=[0-9a-f]{10}"/.test(r); });
  assert.deepStrictEqual(
    notHashed, [],
    "these deployed refs are not content-hashed, so a change to them would not bust the cache: "
      + notHashed.slice(0, 5).join(", ")
  );
});

test("the hash reflects the file's actual content", () => {
  const crypto = require("crypto");
  const m = html.match(/src="(scripts\/[^"?]+\.js)\?v=([0-9a-f]{10})"/);
  assert.ok(m, "at least one hashed script ref must exist");
  const assetPath = m[1];
  const stampedHash = m[2];
  const actual = crypto.createHash("sha1")
    .update(fs.readFileSync(path.join(ROOT, "dist", assetPath)))
    .digest("hex").slice(0, 10);
  assert.strictEqual(stampedHash, actual, "the ?v= must be the sha1 of the deployed file, so an edit changes it");
});

test("editing a file would change its stamp (the whole point)", () => {
  const crypto = require("crypto");
  const sample = path.join(ROOT, "dist", "scripts", "clarity-supabase-auth.js");
  const original = fs.readFileSync(sample);
  const hashBefore = crypto.createHash("sha1").update(original).digest("hex").slice(0, 10);
  const hashAfter = crypto.createHash("sha1").update(Buffer.concat([original, Buffer.from("// x")])).digest("hex").slice(0, 10);
  assert.notStrictEqual(hashBefore, hashAfter, "a content change must produce a different cache key");
});

test("the source index.html keeps human-readable version labels", () => {
  /* Stamping happens on the dist copy, so the source stays diff-friendly. */
  const source = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(
    /\?v=[a-z0-9-]{6,}/i.test(source),
    "the source should keep readable ?v= labels, not hashes"
  );
});

test("the deployed index.html still has its scripts and structure", () => {
  assert.ok(/<script/.test(html) && /gd-app-core\.js/.test(html), "stamping must not damage the document");
  assert.ok(/gd-course-picker-search-v2\.js/.test(html), "the course picker script must still be referenced");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("deploy-cache-busting failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("deploy-cache-busting passed: " + tests.length + " checks");
})();
