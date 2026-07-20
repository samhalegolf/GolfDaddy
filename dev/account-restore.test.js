/* Restore an account onto a device that does not have it locally.
 *
 * A coach-invited user on a fresh phone followed the setup link, the client
 * looked for their account in local storage, did not find it, and called
 * ClarityCloudSync.restoreAccounts - which was never defined. It silently
 * no-opped and the user was told their account could not be found.
 *
 * The security-critical property is that the fix does NOT introduce an
 * account-lookup-by-email: the Supabase recovery token is the proof of identity,
 * and the endpoint returns only the account that token owns. These check both
 * that the restore works AND that it refuses to leak an account without a token. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "functions", "auth-restore-account.js");
const UTILS = path.join(ROOT, "functions", "auth-utils.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Load the endpoint with auth-utils stubbed. */
function loadEndpoint(stub) {
  delete require.cache[FN];
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === FN && request === "./auth-utils") return stub;
    return originalLoad.apply(this, arguments);
  };
  try { return require(FN); }
  finally { Module._load = originalLoad; }
}

function baseStub(overrides) {
  return Object.assign({
    email: function (v) { return String(v || "").trim().toLowerCase(); },
    json: function (status, body) { return { statusCode: status, body: JSON.stringify(body) }; },
    hasAuth: function () { return true; },
    hasAuthWithServiceKey: function () { return true; },
    supabaseAuth: async function () { throw new Error("not stubbed"); },
    upsertAccount: async function () { throw new Error("not stubbed"); }
  }, overrides || {});
}

function call(mod, body, method) {
  return mod.handler({ httpMethod: method || "POST", body: JSON.stringify(body || {}) });
}

test("a request with no token is refused, not turned into an email lookup", async () => {
  let supabaseAuthCalled = false;
  const stub = baseStub({ supabaseAuth: async function () { supabaseAuthCalled = true; return {}; } });
  const mod = loadEndpoint(stub);
  const res = await call(mod, { email: "someone@example.com" });
  assert.strictEqual(res.statusCode, 400, "no token must be a 400");
  assert.strictEqual(JSON.parse(res.body).code, "token_required");
  assert.strictEqual(supabaseAuthCalled, false, "must not even reach Supabase - a bare email must never resolve to an account");
});

test("an invalid or expired token is rejected", async () => {
  const stub = baseStub({
    supabaseAuth: async function () { const e = new Error("bad jwt"); e.status = 401; throw e; }
  });
  const mod = loadEndpoint(stub);
  const res = await call(mod, { accessToken: "expired-token" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(JSON.parse(res.body).code, "invalid_token");
});

test("a valid token returns the account that token owns", async () => {
  let verifiedWith = null;
  let upsertedUser = null;
  const stub = baseStub({
    supabaseAuth: async function (pathArg, options) {
      verifiedWith = { pathArg, auth: options && options.headers && options.headers.Authorization };
      return { id: "auth-user-1", email: "invited@example.com", user_metadata: { name: "Invited Player", role: "player" } };
    },
    upsertAccount: async function (authUser) {
      upsertedUser = authUser;
      return { account: { accountId: "acct_1", email: authUser.email, profileId: "prof_1" }, profile: { id: "prof_1" } };
    }
  });
  const mod = loadEndpoint(stub);
  const res = await call(mod, { accessToken: "valid-recovery-token" });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.account.accountId, "acct_1");
  assert.strictEqual(verifiedWith.pathArg, "user", "must validate against /auth/v1/user");
  assert.strictEqual(verifiedWith.auth, "Bearer valid-recovery-token", "the user token, not a service key, must authorise the lookup");
  assert.strictEqual(upsertedUser.id, "auth-user-1", "the account must be derived from the token-verified identity");
});

test("the account returned is the token's, never a client-supplied email's", async () => {
  /* The client sends both a token and (harmlessly) an email; the account must
     come from the token identity, so a mismatched email cannot redirect it. */
  const stub = baseStub({
    supabaseAuth: async function () { return { id: "u", email: "real-owner@example.com" }; },
    upsertAccount: async function (authUser) {
      return { account: { accountId: "acct_owner", email: authUser.email }, profile: { id: "p" } };
    }
  });
  const mod = loadEndpoint(stub);
  const res = await call(mod, { accessToken: "t", email: "attacker-target@example.com" });
  assert.strictEqual(JSON.parse(res.body).account.email, "real-owner@example.com",
    "the client email must be ignored in favour of the token-verified identity");
});

test("only POST is allowed", async () => {
  const mod = loadEndpoint(baseStub());
  const res = await call(mod, {}, "GET");
  assert.strictEqual(res.statusCode, 405);
});

test("unconfigured Supabase fails clearly", async () => {
  const mod = loadEndpoint(baseStub({ hasAuth: function () { return false; } }));
  const res = await call(mod, { accessToken: "t" });
  assert.strictEqual(res.statusCode, 503);
});

/* --- client wiring --- */

test("restoreAccounts is defined and exported by the cloud sync module", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "clarity-cloud-sync.js"), "utf8");
  assert.ok(/async function restoreAccounts\(reason\)/.test(src), "must be defined - it was called but never defined");
  assert.ok(/restoreAccounts: restoreAccounts/.test(src), "must be on the exported surface, or the typeof guards stay false forever");
});

test("restoreAccounts requires the recovery token and merges without activating", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "clarity-cloud-sync.js"), "utf8");
  const idx = src.indexOf("async function restoreAccounts(reason)");
  const fn = src.slice(idx, idx + 2200);
  assert.ok(/recoveryAccessToken\(\)/.test(fn), "must read the token, not trust an email");
  assert.ok(/no_token/.test(fn), "no token must return a clean no-op, not attempt a lookup");
  assert.ok(/auth-restore-account/.test(fn), "must call the token-gated endpoint");
  assert.ok(/activate:\s*false/.test(fn), "restore must not auto-activate - the setup flow completes sign-in itself");
});

test("a failed restore reports rather than swallowing", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "clarity-cloud-sync.js"), "utf8");
  const idx = src.indexOf("async function restoreAccounts(reason)");
  const fn = src.slice(idx, idx + 2200);
  assert.ok(/ClarityErrorReporter/.test(fn), "a silent restore failure is exactly the class the audit is closing");
});

test("the redundant login-path fallback was removed", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-auth-account-shell.js"), "utf8");
  assert.ok(
    !/restoreAccounts\('login'\)/.test(src),
    "login already merges the account on success; the fallback could not help and should be gone"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("account-restore failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("account-restore passed: " + tests.length + " checks");
})();
