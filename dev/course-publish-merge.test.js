/* Publishing a course map is identical for every actor, and never destructive.
 *
 * Two bugs, one fix. The admin path used to REPLACE the whole course wholesale,
 * so publishing a session with 4 holes mapped wiped the 13 already published -
 * takapuna silently collapsed from 17 holes to 4, and play (which reads the
 * published map) could only load 4. And more fundamentally, admin was a
 * different code path at all, when play/scan/publish are meant to behave the
 * same for everyone - dedupe across sessions is a backend job, not something
 * this endpoint decides per-actor.
 *
 * So the merge is now the same additive union for admin and non-admin alike.
 * These lock both properties. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "functions", "course-maps.mjs"), "utf8");

/* Evaluate the whole module body (top level is only const + function decls; the
   dynamic import lives inside store() and never runs here) with the ESM export
   keywords stripped (and the ESM imports dropped - nothing the merge calls lives
   behind one), then pull mergeGeneratedCourse and every helper it needs. */
function loadMerge() {
  const body = SRC
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
    .replace(/export default /g, "")
    .replace(/^export /gm, "");
  // eslint-disable-next-line no-new-func
  return new Function(body + "\nreturn mergeGeneratedCourse;")();
}

const merge = loadMerge();
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function course(nums) {
  const holes = {}; const objects = {};
  nums.forEach(function (n) {
    holes[n] = { holeNumber: n, green: "g" + n, greenCenter: { lat: -36 - n / 1000, lng: 174 }, greenShape: [{ lat: -36, lng: 174 }, { lat: -36.001, lng: 174 }, { lat: -36, lng: 174.001 }], confirmed: true };
    objects["green-" + n] = { id: "green-" + n, type: "green", holeNumber: n };
  });
  return { id: "published::takapuna", courseId: "takapuna", holes: holes, objects: objects };
}

test("a partial publish over a fuller map keeps every existing hole", () => {
  const existing = course([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]);
  const incoming = course([1,2,3,4]);
  const result = merge(existing, incoming);
  const holes = Object.keys(result.course.holes).map(Number).sort(function (a, b) { return a - b; });
  assert.strictEqual(holes.length, 17, "publishing 4 holes must not wipe the other 13; got " + holes.length);
});

test("a fuller scan over a partial map adds the missing holes", () => {
  const existing = course([1,2,3,4]);
  const incoming = course([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]);
  const result = merge(existing, incoming);
  const holes = Object.keys(result.course.holes).map(Number).sort(function (a, b) { return a - b; });
  assert.strictEqual(holes.length, 17, "the 13 new holes must be added - this is how takapuna rebuilds");
});

test("publishing a brand-new course creates it", () => {
  const result = merge(null, course([1,2]));
  assert.ok(result.course, "a first publish must succeed");
  assert.strictEqual(Object.keys(result.course.holes).length, 2);
});

test("the endpoint uses ONE merge for all actors, not an admin branch", () => {
  assert.ok(
    /const merge = mergeGeneratedCourse\(existingCourse, course\);/.test(SRC),
    "the merge must not branch on adminActor - play/scan/publish are the same for everyone"
  );
  /* The merge is only a merge if it is what gets WRITTEN. Supabase is the authoritative store
     and its upsert replaces objects_json wholesale, so writing the raw incoming payload here
     silently discards everything the client did not send - which is every server-collected
     fairway/bunker/water surface, since no client ever holds those. Millbrook lost 278 of them
     to one phone scan on 2026-09-02 and its Watch maps baked with no hazards. */
  assert.ok(
    /await writeSupabaseCourse\(merge\.course\);/.test(SRC),
    "publish must write the MERGED course to Supabase, never the raw incoming payload"
  );
  assert.ok(
    !/await writeSupabaseCourse\(course\);/.test(SRC),
    "the raw incoming course must never reach Supabase - it wipes server-collected surfaces"
  );
  assert.ok(!/mergeAdminPublish/.test(SRC), "the destructive admin-only merge must be gone entirely");
  assert.ok(
    !/adminActor\s*\?\s*mergeAdminPublish/.test(SRC) && !/adminActor[\s\S]{0,40}\{ course,/.test(SRC),
    "no actor may get a wholesale-replace path"
  );
});

test("admin is still privileged only for delete, not for the merge", () => {
  /* Admin remains gated for the explicit destructive delete action - that is a
     deliberate privileged op, unlike the accidental destruction the wholesale
     replace caused. */
  assert.ok(/action === "delete"[\s\S]{0,200}adminActor/.test(SRC), "delete stays admin-only");
});

test("admin identity is proven against Supabase Auth, never taken from the body", () => {
  /* The old isAdminActor() read actor.email/actor.role straight off the request
     body, so any anonymous caller could claim admin and delete any course map.
     Admin must now come from a validated access token. */
  assert.ok(!/function isAdminActor/.test(SRC), "the body-asserted admin check must be gone");
  assert.ok(/verifiedAdminEmail/.test(SRC), "admin must be established by verifiedAdminEmail()");
  assert.ok(/auth\/v1\/user/.test(SRC), "the caller's token must be validated against Supabase Auth");
  assert.ok(
    /const adminActor = !!adminEmail/.test(SRC),
    "adminActor must derive from the verified email, not from payload.actor"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("course-publish-merge failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("course-publish-merge passed: " + tests.length + " checks");
})();
