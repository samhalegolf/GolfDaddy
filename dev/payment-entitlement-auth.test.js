/* payment-entitlement: you can only ask about your own paid access.
 *
 * Until 2026-07-27 this endpoint performed NO authentication of any kind. It did
 * not import authenticatedAccount or resolveAccount and never looked at the
 * Authorization header. It read identity straight out of the request body -
 * accountId / userId / email / accountEmail - and handed it to readPaidAccess,
 * returning the result verbatim.
 *
 * readPaidAccess returns raw database rows: the user_entitlements rows and
 * caddie_memberships selected with `select=*`, carrying Stripe subscription and
 * invoice identifiers, billing period dates, grace periods and entitlement
 * metadata. So an unauthenticated POST carrying a member's email address - not a
 * secret - returned that member's complete payment state. Same family as the
 * referrals, payment-admin and auth-update-account bypasses closed the same day,
 * and the last endpoint in the payment surface reading identity from the body.
 *
 * The load-bearing assertions are negative: a spoofed body reaches no database
 * read at all, and a signed-in caller is answered about themselves even when the
 * body names someone else. */
const assert = require("assert");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "functions", "payment-entitlement.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

const VICTIM = { account_id: "acct_victim", email: "victim@example.com", profile_id: "prof_victim" };
const CALLER = { account_id: "acct_caller", email: "caller@example.com", profile_id: "prof_caller" };

/* What the old handler leaked. Shaped like a real readPaidAccess result so the
   assertions below are about the endpoint, not about a toy payload. */
const VICTIM_ACCESS = {
  configured: true,
  active: true,
  paymentState: "membership_active",
  entitlements: [{ id: "ent_1", product_key: "monthly_membership", user_id: VICTIM.account_id }],
  membership: {
    status: "active",
    stripe_subscription_id: "sub_victim_secret",
    stripe_customer_id: "cus_victim_secret",
    last_paid_invoice_id: "in_victim_secret"
  },
  memberships: [],
  checkedAt: "2026-07-27T00:00:00.000Z"
};

function loadEndpoint(stub) {
  delete require.cache[FN];
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === FN) {
      if (request === "./payment-utils") return stub;
      if (request === "./alert-utils") return { sendSystemAlert: async function () { stub.calls.alerts += 1; return true; } };
    }
    return originalLoad.apply(this, arguments);
  };
  try { return require(FN); }
  finally { Module._load = originalLoad; }
}

function baseStub(account, overrides) {
  const calls = { reads: [], authCalls: 0, alerts: 0 };
  return Object.assign({
    calls: calls,
    /* The real one validates the bearer token against /auth/v1/user and returns
       the app_accounts row it belongs to. It takes no body and no header
       identity - the stub ignores the event entirely, which is the point. */
    authenticatedAccount: async function () { calls.authCalls += 1; return account; },
    hasSupabase: function () { return true; },
    json: function (status, body) { return { statusCode: status, body: JSON.stringify(body) }; },
    readPaidAccess: async function (identity) {
      calls.reads.push(identity);
      return identity && identity.accountId === VICTIM.account_id ? VICTIM_ACCESS : { configured: true, active: false, paymentState: "free_access", entitlements: [], membership: null, memberships: [] };
    },
    text: function (v, limit) { const s = String(v || "").trim(); return s.length > limit ? s.slice(0, limit) : s; }
  }, overrides || {});
}

/* A request shaped exactly like the old exploit: no credential, the victim named
   every way the handler used to read identity. */
function spoofedEvent(extra) {
  return {
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify(Object.assign({
      accountId: VICTIM.account_id,
      userId: VICTIM.account_id,
      email: VICTIM.email,
      accountEmail: VICTIM.email,
      profileId: VICTIM.profile_id
    }, extra || {}))
  };
}

test("no token: a spoofed body cannot read someone else's payment state", async () => {
  const stub = baseStub(null);
  const res = await loadEndpoint(stub).handler(spoofedEvent());
  assert.strictEqual(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.code, "token_required");
  assert.strictEqual(stub.calls.reads.length, 0, "an unauthenticated request must not reach the database");
  assert.ok(!("entitlements" in body), "entitlements must not leak");
  assert.ok(!("membership" in body) && !("memberships" in body), "membership rows must not leak");
  assert.ok(!("paymentState" in body), "not even the payment state may leak");
  assert.ok(!/sub_victim_secret|cus_victim_secret|in_victim_secret/.test(res.body),
    "Stripe identifiers must not appear anywhere in the response");
});

test("no token: a checkout session id alone is not a credential", async () => {
  /* The old handler accepted a body with only a checkoutSessionId. It never
     queried it - the id was echoed back and readPaidAccess got no identity - so
     nothing is lost by refusing, and leaving it open would be a way in. */
  const stub = baseStub(null);
  const res = await loadEndpoint(stub).handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ checkoutSessionId: "cs_test_123" })
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(stub.calls.reads.length, 0);
});

test("no token: the request raises no admin alert", async () => {
  /* Alerting on a routine 401 would let anyone flood the inbox by polling, and
     tokens legitimately expire hourly. */
  const stub = baseStub(null);
  await loadEndpoint(stub).handler(spoofedEvent());
  assert.strictEqual(stub.calls.alerts, 0, "an unauthenticated poll must not email an admin");
});

test("a rejected token is refused cleanly rather than crashing the handler", async () => {
  /* authenticatedAccount THROWS on a bad token rather than returning null, so an
     unguarded call would reject the whole function and surface as a 500. */
  const err = new Error("Sign in again before buying access");
  err.status = 401;
  const stub = baseStub(null, { authenticatedAccount: async function () { throw err; } });
  const res = await loadEndpoint(stub).handler(spoofedEvent());
  assert.strictEqual(res.statusCode, 401, "a rejected token must be a clean 401, not an unhandled throw");
  assert.strictEqual(stub.calls.reads.length, 0);
  assert.strictEqual(stub.calls.alerts, 0, "a stale token is not an admin-alert event");
});

test("a misconfigured server fails closed rather than trusting the body", async () => {
  const err = new Error("Supabase Auth is not configured for payment identity verification");
  err.status = 503;
  const stub = baseStub(null, { authenticatedAccount: async function () { throw err; } });
  const res = await loadEndpoint(stub).handler(spoofedEvent());
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(stub.calls.reads.length, 0, "identity must never fall back to the request body");
});

test("a signed-in caller is answered about themselves, not about the body", async () => {
  const stub = baseStub(CALLER);
  const res = await loadEndpoint(stub).handler(spoofedEvent());
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(stub.calls.reads.length, 1);
  const asked = stub.calls.reads[0];
  assert.strictEqual(asked.accountId, CALLER.account_id, "the token owner is the subject");
  assert.strictEqual(asked.accountEmail, CALLER.email);
  assert.notStrictEqual(asked.accountId, VICTIM.account_id, "the spoofed account must be ignored");
  assert.notStrictEqual(asked.accountEmail, VICTIM.email);
  assert.notStrictEqual(asked.profileId, VICTIM.profile_id, "profile identity must not come from the body either");
  assert.ok(!/sub_victim_secret/.test(res.body), "the victim's state must not be returned to another caller");
});

test("profile-scoped entitlements still resolve, from the account row", async () => {
  /* The account row carries profile_id (see functions/account-delete.js, which
     deletes user_entitlements by it), so dropping the body's profileId must not
     lose entitlements attached that way. */
  const stub = baseStub(CALLER);
  await loadEndpoint(stub).handler(spoofedEvent());
  assert.strictEqual(stub.calls.reads[0].profileId, CALLER.profile_id,
    "profile_id must be taken from the authenticated account");
});

test("the checkout session id is still echoed for the return flow", async () => {
  const stub = baseStub(CALLER);
  const res = await loadEndpoint(stub).handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ checkoutSessionId: "cs_test_123" })
  });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(JSON.parse(res.body).checkoutSessionId, "cs_test_123",
    "the post-checkout redirect correlates its response by this id");
});

test("the endpoint no longer reads identity from the request body", () => {
  const fs = require("fs");
  const src = fs.readFileSync(FN, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(/authenticatedAccount/.test(code), "identity must come from the validated token");
  ["payload.accountId", "payload.userId", "payload.email", "payload.accountEmail", "payload.profileId"].forEach(function (expr) {
    assert.ok(!code.includes(expr), "reading " + expr + " back would reopen the disclosure");
  });
  assert.ok(!/x-clarity-account-id|x-clarity-account-email/i.test(code),
    "identity must not come from request headers either");
});

test("the status client sends a refreshable token and no account", () => {
  /* Paid features lock when this call fails, so an expired token must refresh
     and retry rather than read as "no access". Native copies are gitignored
     build artifacts, so they are checked only when present. */
  const fs = require("fs");
  const clients = [
    path.join(ROOT, "scripts", "clarity-payments.js"),
    path.join(ROOT, "ios", "App", "App", "public", "scripts", "clarity-payments.js"),
    path.join(ROOT, "android", "app", "src", "main", "assets", "public", "scripts", "clarity-payments.js")
  ];
  let checked = 0;
  clients.forEach(function (file) {
    if (!fs.existsSync(file)) return;
    checked += 1;
    const src = fs.readFileSync(file, "utf8");
    const start = src.indexOf("async function refresh(opts)");
    assert.notStrictEqual(start, -1, "refresh should exist in " + file);
    const rest = src.slice(start);
    const fn = rest.slice(0, rest.search(/\n  (?:async )?function /));
    assert.ok(/authedHeaders\(false\)/.test(fn), "the status call must refresh an expired token: " + file);
    assert.ok(/response\.status === 401[\s\S]*authedHeaders\(true\)/.test(fn),
      "a just-expired session must not read as no-access: " + file);
    const sent = fn.split("\n").filter(function (l) { return /var requestBody = /.test(l); })[0] || "";
    assert.ok(sent, "the body should be built once and reused on retry: " + file);
    assert.ok(!/accountPayload\(\)/.test(sent) && !/\baccountId\b/.test(sent),
      "the status call must not name an account in the body: " + sent.trim() + " [" + file + "]");
  });
  assert.ok(checked > 0, "at least the source client must be present");
});

test("the unrefreshed header helper is gone from the client", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "scripts", "clarity-payments.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/function requestHeaders/.test(code),
    "a helper that sends a possibly-expired token invites reuse now that every endpoint rejects one");
  assert.ok(!/requestHeaders\(\)/.test(code), "nothing should call it");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("payment-entitlement-auth failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("payment-entitlement-auth passed: " + tests.length + " checks");
})();
