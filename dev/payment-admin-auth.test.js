/* payment-admin: billing administration is gated on a validated token, not on a
   request header.
 *
 * Until 2026-07-27 adminContext read X-Clarity-Account-Id / X-Clarity-Account-Email
 * from the REQUEST HEADERS, looked that account up, and granted admin if the row
 * said admin. Nothing proved the caller owned the account. An unauthenticated
 * POST carrying the admin's email address - printed on our own privacy and
 * support pages, so not a secret - was full billing-admin access: issuing free
 * memberships, granting and revoking entitlements, rewriting products.
 *
 * GET was worse still: readSettings ran BEFORE the isAdmin check, so product
 * configuration, webhook failure counts and the list of which server secrets are
 * present went to any caller at all.
 *
 * The load-bearing assertions here are negative ones - that a spoofed header
 * reaches nothing, and that no privileged handler runs for a caller who is not a
 * proven admin. */
const assert = require("assert");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "functions", "payment-admin.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Every action the endpoint dispatches. Each must be refused for a non-admin;
   listing them explicitly means a newly added action that skips the gate shows
   up here as an omission rather than passing silently. */
const PRIVILEGED_ACTIONS = [
  "upsertProduct",
  "setProductActive",
  "issueFreePass",
  "queryEntitlements",
  "manualGrantPermission",
  "manualRevokePermission",
  "seedDefaults"
];

function loadEndpoint(stub) {
  delete require.cache[FN];
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === FN) {
      if (request === "./payment-utils") return stub;
      if (request === "./alert-utils") return { sendSystemAlert: async function () { return true; } };
    }
    return originalLoad.apply(this, arguments);
  };
  try { return require(FN); }
  finally { Module._load = originalLoad; }
}

function baseStub(account, overrides) {
  const calls = { fetches: [], authCalls: 0 };
  return Object.assign({
    calls: calls,
    ADMIN_COMPED_MEMBERSHIP_KEY: "admin_comped_membership",
    MONTHLY_MEMBERSHIP_KEY: "clarity_membership_monthly",
    MONTH_PASS_KEY: "clarity_month_pass",
    /* The real one validates the bearer token against /auth/v1/user and returns
       the app_accounts row for whoever the token belongs to. Headers are not an
       input, which is the whole point - the stub takes no event data at all. */
    authenticatedAccount: async function () { calls.authCalls += 1; return account; },
    email: function (v) { return String(v || "").trim().toLowerCase(); },
    encodeFilter: function (v) { return encodeURIComponent(String(v || "")); },
    env: function () { return ""; },
    hasSupabase: function () { return true; },
    isStripePriceId: function (v) { return /^price_/.test(String(v || "")); },
    json: function (status, body) { return { statusCode: status, body: JSON.stringify(body) }; },
    normaliseProductKey: function (v) { return String(v || "").trim(); },
    productPriceId: function () { return ""; },
    supabaseFetch: async function (p, options) {
      calls.fetches.push({ path: p, method: options && options.method || "GET" });
      return [];
    },
    text: function (v, limit) { const s = String(v || "").trim(); return s.length > limit ? s.slice(0, limit) : s; }
  }, overrides || {});
}

const ADMIN = { account_id: "acct_admin", email: "boss@example.com", name: "Boss", role: "admin" };
const PLAYER = { account_id: "acct_player", email: "player@example.com", name: "Player", role: "player" };
const COACH = { account_id: "acct_coach", email: "coach@example.com", name: "Coach", role: "coach" };

/* A request shaped exactly like the old exploit. */
function spoofedEvent(method, body) {
  return {
    httpMethod: method || "POST",
    headers: {
      "x-clarity-account-id": "acct_admin",
      "x-clarity-account-email": "boss@example.com"
    },
    body: JSON.stringify(body || {})
  };
}

test("no token: GET is refused and discloses no settings", async () => {
  const stub = baseStub(null);
  const res = await loadEndpoint(stub).handler(spoofedEvent("GET"));
  assert.strictEqual(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.code, "token_required");
  assert.ok(!("products" in body), "product configuration must not leak to an unauthenticated caller");
  assert.ok(!("serverManagedSecrets" in body), "the secret inventory must not leak");
  assert.ok(!("stripeConnected" in body), "infrastructure diagnostics must not leak");
});

test("no token: every privileged action is refused", async () => {
  for (const action of PRIVILEGED_ACTIONS) {
    const stub = baseStub(null);
    const res = await loadEndpoint(stub).handler(spoofedEvent("POST", { action: action }));
    assert.strictEqual(res.statusCode, 401, action + " should be 401");
    assert.strictEqual(stub.calls.fetches.length, 0, action + " must not touch the database");
  }
});

test("the spoofable headers grant nothing on their own", async () => {
  /* Identical to the old working exploit: admin id and email in the headers, no
     credential of any kind. */
  const stub = baseStub(null);
  const res = await loadEndpoint(stub).handler(spoofedEvent("POST", { action: "issueFreePass", email: "attacker@example.com" }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(stub.calls.fetches.length, 0, "a header-only request must reach no query at all");
});

test("a signed-in player cannot administer billing", async () => {
  for (const action of PRIVILEGED_ACTIONS) {
    const stub = baseStub(PLAYER);
    const res = await loadEndpoint(stub).handler(spoofedEvent("POST", { action: action }));
    assert.strictEqual(res.statusCode, 403, action + " should be 403 for a player");
    assert.strictEqual(stub.calls.fetches.length, 0, action + " must not run for a player");
  }
});

test("a coach is staff but not an admin", async () => {
  const stub = baseStub(COACH);
  const res = await loadEndpoint(stub).handler(spoofedEvent("POST", { action: "seedDefaults" }));
  assert.strictEqual(res.statusCode, 403, "isStaff must not be mistaken for isAdmin");
});

test("a signed-in player cannot read settings either", async () => {
  const stub = baseStub(PLAYER);
  const res = await loadEndpoint(stub).handler(spoofedEvent("GET"));
  assert.strictEqual(res.statusCode, 403);
  const body = JSON.parse(res.body);
  assert.ok(!("products" in body), "a non-admin must not receive product configuration");
});

test("a genuine admin can still read settings", async () => {
  const stub = baseStub(ADMIN);
  const res = await loadEndpoint(stub).handler({ httpMethod: "GET", headers: {}, body: "" });
  assert.strictEqual(res.statusCode, 200, "the admin panel must keep working: " + res.body);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.isAdmin, true);
  assert.ok("products" in body, "an admin should receive the product list");
});

test("a genuine admin is identified without any header", async () => {
  /* Proves identity is taken from the token: the event carries no X-Clarity-*
     headers at all, and the admin is still resolved. */
  const stub = baseStub(ADMIN);
  const res = await loadEndpoint(stub).handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "seedDefaults" }) });
  assert.notStrictEqual(res.statusCode, 401, "a header-less admin must not be rejected");
  assert.notStrictEqual(res.statusCode, 403, "a header-less admin must not be rejected");
  assert.strictEqual(stub.calls.authCalls, 1, "the token is the only identity check");
});

test("an unknown action from an admin does not fall through to success", async () => {
  const stub = baseStub(ADMIN);
  const res = await loadEndpoint(stub).handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "notARealAction" }) });
  assert.notStrictEqual(res.statusCode, 200, "an unrecognised action must not report success");
});

test("the endpoint no longer reads identity from headers", () => {
  const fs = require("fs");
  const src = fs.readFileSync(FN, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/x-clarity-account-id|x-clarity-account-email/i.test(code),
    "reading these headers back would reopen the bypass");
  assert.ok(/authenticatedAccount/.test(code), "identity must come from the validated token");
});

test("the admin client sends a refreshable token and no identity headers", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "scripts", "clarity-payments.js"), "utf8");
  const idx = src.indexOf("async function adminHeaders");
  assert.ok(idx !== -1, "adminHeaders should still exist");
  const fn = src.slice(idx, idx + 400);
  assert.ok(/authedHeaders/.test(fn), "the admin call must use the refresh-aware header helper");
  assert.ok(!/X-Clarity-Account-(Id|Email)/i.test(fn),
    "sending these again would make a removed authentication path look supported");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("payment-admin-auth failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("payment-admin-auth passed: " + tests.length + " checks");
})();
