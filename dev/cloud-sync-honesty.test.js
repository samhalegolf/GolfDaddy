/* Cloud sync must not report "Synced" when it dropped a change.
 *
 * A row the server rejected with 4xx was marked permanent and excluded from the
 * remaining queue - but if it was the only row, remaining.length was 0 and the
 * status was set to "Synced" with no error. The user's account/profile change
 * was silently discarded and the badge affirmatively said everything was saved.
 *
 * These run the real flushOutbox with post() and storage stubbed. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "scripts", "clarity-cloud-sync.js"), "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function build(opts) {
  const saved = [];
  const statuses = [];
  const reports = [];
  const outboxRows = opts.rows || [];

  const idx = SRC.indexOf("async function flushOutbox()");
  const end = SRC.indexOf("\n  }", idx);
  const region = SRC.slice(idx, end + 4);

  let postCall = 0;
  const scope = {
    outbox: function () { return outboxRows; },
    saveOutbox: function (rows) { saved.push(rows); },
    saveStatus: function (s) { statuses.push(s); },
    post: async function (payload) {
      const behaviour = opts.postBehaviour[postCall++];
      if (behaviour && behaviour.error) { const e = new Error(behaviour.message || "rejected"); e.status = behaviour.status; throw e; }
      return { ok: true };
    },
    adoptCanonicalIds: function () {},
    safe: function (fn, fb) { try { return fn(); } catch (_e) { return fb; } },
    window: { ClarityErrorReporter: { report: function (m, d) { reports.push({ m: m, d: d }); } } }
  };

  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const factory = new Function(names.join(","), region + "\nreturn flushOutbox;");
  const flushOutbox = factory.apply(null, names.map(function (n) { return scope[n]; }));
  return { flushOutbox: flushOutbox, saved: saved, statuses: statuses, reports: reports };
}

function lastStatus(h) { return h.statuses[h.statuses.length - 1]; }

test("a 4xx-rejected change is NOT reported as Synced", async () => {
  const h = build({
    rows: [{ payload: { a: 1 }, attempts: 0 }],
    postBehaviour: [{ error: true, status: 400, message: "missing field" }]
  });
  const result = await h.flushOutbox();
  assert.notStrictEqual(lastStatus(h).state, "synced", "a dropped change must never read as Synced");
  assert.strictEqual(lastStatus(h).state, "error", "the honest state is an error");
  assert.strictEqual(result.dropped, 1);
});

test("a dropped change is reported so the loss is visible", async () => {
  const h = build({
    rows: [{ payload: { a: 1 }, attempts: 0 }],
    postBehaviour: [{ error: true, status: 422, message: "unprocessable" }]
  });
  await h.flushOutbox();
  assert.ok(
    h.reports.some(function (r) { return /dropped a rejected change/.test(r.m); }),
    "a silently discarded user change is exactly the failure class being closed"
  );
});

test("a transient 5xx stays queued for retry, not dropped", async () => {
  const h = build({
    rows: [{ payload: { a: 1 }, attempts: 0 }],
    postBehaviour: [{ error: true, status: 503, message: "unavailable" }]
  });
  const result = await h.flushOutbox();
  assert.strictEqual(result.pending, 1, "a 5xx must be retried, not discarded");
  assert.strictEqual(result.dropped, 0);
  assert.strictEqual(lastStatus(h).state, "pending");
});

test("all rows succeeding reports Synced", async () => {
  const h = build({
    rows: [{ payload: { a: 1 }, attempts: 0 }, { payload: { b: 2 }, attempts: 0 }],
    postBehaviour: [{}, {}]
  });
  const result = await h.flushOutbox();
  assert.strictEqual(lastStatus(h).state, "synced", "a genuinely clean flush must still say Synced");
  assert.strictEqual(result.flushed, 2);
  assert.strictEqual(result.dropped, 0);
});

test("one dropped among several successes still refuses Synced", async () => {
  const h = build({
    rows: [{ payload: { a: 1 }, attempts: 0 }, { payload: { b: 2 }, attempts: 0 }],
    postBehaviour: [{}, { error: true, status: 400 }]
  });
  await h.flushOutbox();
  assert.strictEqual(lastStatus(h).state, "error", "a partial loss is still a loss - do not claim Synced");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("cloud-sync-honesty failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("cloud-sync-honesty passed: " + tests.length + " checks");
})();
