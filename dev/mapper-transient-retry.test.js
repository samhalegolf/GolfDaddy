/* Retrying a mapping run that failed for a reason that was not the course's fault.
 *
 * Every job error ended the same way - status "failed", permanently, attempts
 * still 0. Royal Auckland died on "Overpass 504": a shared public endpoint was
 * busy for fifty-four seconds. That says nothing about the course, and nothing
 * ever tried again.
 *
 * Large courses feel this hardest, which is why the multi-nine ones were the
 * ones failing. A site bigger than the default 1400m circle gets re-queried on
 * its footprint bbox, and a third time with WIDER_RETRY_PAD_M when it comes up
 * short of the expected hole count - so a 27-hole complex sends three
 * progressively larger Overpass queries, and large queries are the ones that
 * time out.
 *
 * The counterweight is that a genuinely terminal failure must NOT be retried:
 * "no OSM hole geometry within range" will be just as true in twelve minutes,
 * and retrying it would burn the shared Overpass endpoint for nothing. Both
 * halves are asserted with the real error strings out of course_mapper_jobs. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WORKER = path.join(ROOT, "functions", "course-mapper-worker-background.mjs");
const src = fs.readFileSync(WORKER, "utf8");

/* Lift the classifier out of the module - importing the worker would pull in
   Supabase and Overpass clients for a pure-function test. */
function loadClassifier() {
  const start = src.indexOf("function transientMapperFailure(error) {");
  assert.notStrictEqual(start, -1, "transientMapperFailure must exist");
  const end = src.indexOf("\n}", start);
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(start, end + 2) + "\nreturn transientMapperFailure;")();
}

const isTransient = loadClassifier();
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("the real Royal Auckland failure is retryable", () => {
  /* Verbatim from course_mapper_jobs.error. */
  assert.strictEqual(isTransient(new Error("Overpass 504")), true);
  const withStatus = new Error("Overpass 504");
  withStatus.status = 504;
  assert.strictEqual(isTransient(withStatus), true);
});

test("the real North Shore and Howeston failures are NOT retryable", () => {
  /* Both verbatim from course_mapper_jobs.error. Geometry that does not exist
     will not exist on the fourth attempt either. */
  assert.strictEqual(
    isTransient(new Error("no numbered hole geometry found for north-shore (no OSM hole geometry within range)")),
    false
  );
  assert.strictEqual(
    isTransient(new Error("no numbered hole geometry found for howeston (geometry resolver status: geometry-resolved-numbering-unavailable (no shared scorecard found))")),
    false
  );
});

test("upstream back-pressure and network faults are retryable", () => {
  [429, 502, 503, 504].forEach(function (status) {
    const err = new Error("Overpass " + status);
    err.status = status;
    assert.strictEqual(isTransient(err), true, "status " + status + " must retry");
  });
  ["fetch failed", "socket hang up", "ETIMEDOUT", "ECONNRESET", "request timed out", "Too Many Requests"]
    .forEach(function (message) {
      assert.strictEqual(isTransient(new Error(message)), true, "must retry: " + message);
    });
});

test("a 4xx that is the request's own fault is not retried", () => {
  [400, 404].forEach(function (status) {
    const err = new Error("Overpass " + status);
    err.status = status;
    assert.strictEqual(isTransient(err), false, "status " + status + " must not retry");
  });
});

test("an unrecognised error stays terminal", () => {
  /* Allowlist, not denylist: something nobody classified must surface as a
     failure rather than loop forever. */
  assert.strictEqual(isTransient(new Error("something nobody has seen before")), false);
  assert.strictEqual(isTransient(null), false);
  assert.strictEqual(isTransient(undefined), false);
});

test("a course with no location is not retried", () => {
  /* Thrown by runMapperJob before any network call. Retrying cannot add a
     coordinate. */
  assert.strictEqual(
    isTransient(new Error("course royal-auckland has no known location in course_maps - cannot query Overpass")),
    false
  );
});

test("retries are bounded and requeue rather than fail", () => {
  assert.ok(/const MAX_TRANSIENT_ATTEMPTS = \d+;/.test(src), "the cap must be explicit");
  const cap = Number(src.match(/const MAX_TRANSIENT_ATTEMPTS = (\d+);/)[1]);
  assert.ok(cap >= 2 && cap <= 8, "cap should be small enough to stay polite to Overpass, got " + cap);
  assert.ok(
    /retryable\s*\?\s*\{ status: "queued"/.test(src),
    "a retryable failure must go back on the queue, not be marked failed"
  );
  assert.ok(
    /attempts < MAX_TRANSIENT_ATTEMPTS/.test(src),
    "retrying must be bounded"
  );
});

test("the attempt counter is shared with the stale reaper", () => {
  /* Two counters would let a job be retried 4 times by one path and 8 by the
     other without either noticing. */
  const reaper = src.slice(src.indexOf("async function reapStaleJobs()"));
  assert.ok(/Number\(row\.result\.attempts\)/.test(reaper.slice(0, 600)), "reaper reads result.attempts");
  assert.ok(/Number\(job\.result\.attempts\)/.test(src), "the failure path must read the same counter");
});

test("a failure that exhausted its retries says so", () => {
  assert.ok(
    /\(after " \+ attempts \+ " attempts\)/.test(src),
    "the final error must record that it was tried more than once"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("mapper-transient-retry failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("mapper-transient-retry passed: " + tests.length + " checks");
})();
