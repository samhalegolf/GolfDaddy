/* Auth token refresh must not sign a valid user out over a transient failure.
 *
 * The refresh path deleted the stored session on ANY non-OK response, so a
 * Supabase 500/429 blip was indistinguishable from a genuinely revoked token -
 * a valid user was silently logged out of paid/referral features and stayed out
 * after Supabase recovered. And a config-fetch failure was swallowed to "",
 * reading as signed out with no report - the CORS silent-failure class again.
 *
 * The fix: only a definitive 400/401 deletes the session; 5xx/429/network keep
 * it and report. These run the real doRefreshSession with fetch stubbed. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "scripts", "clarity-supabase-auth.js"), "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Lift doRefreshSession and its helpers into an isolated scope with a fake
   localStorage, fetch, and reporter. */
function build(opts) {
  const store = Object.assign({}, opts.session ? { "clarity:supabase-auth-session:v1": JSON.stringify(opts.session) } : {});
  const removed = [];
  const reports = [];

  const idx = SRC.indexOf("function reportAuth(");
  const end = SRC.indexOf("\n  // De-duped", idx);
  const region = SRC.slice(idx, end);

  const scope = {
    SESSION_KEY: "clarity:supabase-auth-session:v1",
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { removed.push(k); delete store[k]; }
    },
    loadJson: function (k, fb) { try { return JSON.parse(store[k]); } catch (_e) { return fb; } },
    saveJson: function (k, v) { store[k] = JSON.stringify(v); },
    safe: function (fn, fb) { try { return fn(); } catch (_e) { return fb; } },
    nowISO: function () { return "2026-07-21T00:00:00.000Z"; },
    publicAuthConfig: opts.publicAuthConfig || (async function () { return { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" }; }),
    fetch: opts.fetch || (async function () { throw new Error("no fetch stub"); }),
    window: { ClarityErrorReporter: { report: function (m, d) { reports.push({ m: m, d: d }); } } }
  };

  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const factory = new Function(names.join(","), region + "\nreturn doRefreshSession;");
  const doRefreshSession = factory.apply(null, names.map(function (n) { return scope[n]; }));
  return { doRefreshSession: doRefreshSession, removed: removed, reports: reports, store: store };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status: status, json: async function () { return body || {}; } };
}

test("a genuine 400 revocation deletes the session (as before)", async () => {
  const h = build({
    session: { refresh_token: "rt", access_token: "old" },
    fetch: async function () { return jsonResponse(400, { error: "invalid_grant" }); }
  });
  const token = await h.doRefreshSession();
  assert.strictEqual(token, "");
  assert.ok(h.removed.indexOf("clarity:supabase-auth-session:v1") !== -1, "a definitively bad token must be cleared");
});

test("a 401 also deletes the session", async () => {
  const h = build({
    session: { refresh_token: "rt" },
    fetch: async function () { return jsonResponse(401, { msg: "unauthorized" }); }
  });
  await h.doRefreshSession();
  assert.ok(h.removed.length, "401 is a definitive auth rejection");
});

test("a transient 500 does NOT delete the session", async () => {
  const h = build({
    session: { refresh_token: "rt", access_token: "old" },
    fetch: async function () { return jsonResponse(500, { error: "internal" }); }
  });
  const token = await h.doRefreshSession();
  assert.strictEqual(token, "", "no token this attempt");
  assert.deepStrictEqual(h.removed, [], "a valid user must NOT be logged out over a Supabase blip");
  assert.ok(h.reports.some(function (r) { return /transient 500/.test(r.m); }), "the transient failure must be reported");
});

test("a 429 rate-limit keeps the session", async () => {
  const h = build({
    session: { refresh_token: "rt" },
    fetch: async function () { return jsonResponse(429, {}); }
  });
  await h.doRefreshSession();
  assert.deepStrictEqual(h.removed, [], "rate limiting is transient, not a revocation");
});

test("a network error keeps the session and reports", async () => {
  const h = build({
    session: { refresh_token: "rt" },
    fetch: async function () { throw new Error("network down"); }
  });
  const token = await h.doRefreshSession();
  assert.strictEqual(token, "");
  assert.deepStrictEqual(h.removed, [], "a dropped connection must not sign the user out");
  assert.ok(h.reports.some(function (r) { return /network/.test(r.m); }), "must report the network failure");
});

test("a config-fetch failure is reported, not silently swallowed", async () => {
  const h = build({
    session: { refresh_token: "rt" },
    publicAuthConfig: async function () { throw new Error("config unreachable"); }
  });
  const token = await h.doRefreshSession();
  assert.strictEqual(token, "");
  assert.deepStrictEqual(h.removed, [], "config being down is not a reason to sign out");
  assert.ok(h.reports.some(function (r) { return /config fetch failed/.test(r.m); }), "the swallowed config failure must now surface");
});

test("a successful refresh returns and stores the new token", async () => {
  const h = build({
    session: { refresh_token: "rt", access_token: "old" },
    fetch: async function () { return jsonResponse(200, { access_token: "new-token", refresh_token: "rt2", expires_in: 3600 }); }
  });
  const token = await h.doRefreshSession();
  assert.strictEqual(token, "new-token");
  assert.deepStrictEqual(h.removed, []);
  assert.ok(/new-token/.test(h.store["clarity:supabase-auth-session:v1"]), "the new session must be saved");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("auth-refresh-resilience failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("auth-refresh-resilience passed: " + tests.length + " checks");
})();
