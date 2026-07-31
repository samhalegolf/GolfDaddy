/* auth-update-account: you may only ever update your own account, and you may
   never change what that account is allowed to do.
 *
 * Two real vulnerabilities are locked closed here, both found 2026-07-27.
 *
 * 1. Account takeover. The handler took `supabaseUserId` from the POST body and
 *    passed it to the Supabase Admin API with the service role key, with no
 *    proof the caller owned it. An unauthenticated POST carrying a victim's user
 *    id could set their password or move their email to an attacker's address.
 *
 * 2. Privilege escalation. It also accepted `role` from the body, and
 *    payment-admin.js reads app_accounts.role to decide who is an admin - so the
 *    same request could hand the caller the admin role.
 *
 * The tests that matter most assert what did NOT happen: that no admin call is
 * made for an unauthenticated or mismatched request, and that a body-supplied
 * role never reaches the write. */
const assert = require("assert");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "functions", "auth-update-account.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

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

const OWNER = { id: "auth-user-owner", email: "owner@example.com" };

function baseStub(overrides) {
  const calls = { auth: [], rest: [], upserts: [] };
  return Object.assign({
    calls: calls,
    json: function (status, body) { return { statusCode: status, body: JSON.stringify(body) }; },
    text: function (v, limit) { const s = String(v || "").trim(); return s.length > limit ? s.slice(0, limit) : s; },
    email: function (v) { return String(v || "").trim().toLowerCase(); },
    /* Mirrors auth-utils.role - normalises to the four roles the schema allows. */
    role: function (v) {
      const raw = String(v || "player").trim().toLowerCase().replace(/[\s_-]+/g, "");
      if (raw === "admin") return "admin";
      if (raw === "coach") return "coach";
      if (raw === "subscribed" || raw === "subscriber" || raw === "subscribedplayer") return "subscribedPlayer";
      return "player";
    },
    hasAuth: function () { return true; },
    hasAuthWithServiceKey: function () { return true; },
    supabaseAuth: async function (p, options, useService) {
      calls.auth.push({ path: p, method: options && options.method || "GET", useService: !!useService, body: options && options.body || "" });
      if (p === "user") return OWNER;
      return { id: OWNER.id, email: OWNER.email };
    },
    supabaseRest: async function (p, options) {
      calls.rest.push({ path: p, method: options && options.method || "GET" });
      /* The account already exists as an ordinary player. */
      return [{ role: "player" }];
    },
    upsertAccount: async function (authUser, input) {
      calls.upserts.push({ authUser: authUser, input: input });
      return { account: { accountId: "acct_1" }, profile: { id: "profile_1" } };
    }
  }, overrides || {});
}

function call(mod, body, method) {
  return mod.handler({ httpMethod: method || "POST", body: JSON.stringify(body || {}) });
}

/* Every admin-API write this endpoint can make. */
function adminWrites(stub) {
  return stub.calls.auth.filter(function (c) { return /^admin\//.test(c.path); });
}

test("a request with no token cannot touch the admin API", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), { supabaseUserId: "victim-user", password: "attacker-chosen" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(JSON.parse(res.body).code, "token_required");
  assert.strictEqual(adminWrites(stub).length, 0, "this is the takeover: an unauthenticated body must never reach admin/users");
});

test("an invalid token cannot touch the admin API", async () => {
  const stub = baseStub({
    supabaseAuth: async function (p, options, useService) {
      if (p === "user") { const e = new Error("bad token"); e.status = 401; throw e; }
      throw new Error("must not be reached");
    }
  });
  const res = await call(loadEndpoint(stub), { accessToken: "forged", supabaseUserId: "victim-user", password: "attacker-chosen" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(JSON.parse(res.body).code, "invalid_token");
});

test("a token for one user cannot update a different user", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), {
    accessToken: "valid-owner-token",
    supabaseUserId: "someone-elses-user-id",
    password: "attacker-chosen"
  });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(JSON.parse(res.body).code, "user_mismatch");
  assert.strictEqual(adminWrites(stub).length, 0, "a mismatched id must be refused before any write");
});

test("the user id written is the token's, never the body's", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), { accessToken: "valid-owner-token", name: "Owner" });
  assert.strictEqual(res.statusCode, 200);
  const writes = adminWrites(stub);
  assert.strictEqual(writes.length, 1);
  assert.ok(writes[0].path.indexOf(OWNER.id) !== -1, "expected the token's user id in " + writes[0].path);
});

test("a player asking for admin does not get it", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), {
    accessToken: "valid-owner-token",
    name: "Climber",
    role: "admin"
  });
  assert.strictEqual(res.statusCode, 200);

  const written = adminWrites(stub).map(function (c) { return String(c.body || ""); }).join(" ");
  assert.ok(!/admin/.test(written), "body role reached the auth metadata write: " + written);

  const upsertRoles = stub.calls.upserts.map(function (u) { return u.input && u.input.role; });
  assert.ok(upsertRoles.every(function (r) { return r !== "admin"; }),
    "body role reached upsertAccount, which writes app_accounts.role - that is the admin grant");
});

test("a coach asking for admin keeps coach", async () => {
  const stub = baseStub({
    supabaseRest: async function () { return [{ role: "coach" }]; }
  });
  await call(loadEndpoint(stub), { accessToken: "valid-owner-token", name: "Coach", role: "admin" });
  const written = adminWrites(stub).map(function (c) { return String(c.body || ""); }).join(" ");
  assert.ok(/coach/.test(written), "the stored role should be preserved, got: " + written);
  assert.ok(!/admin/.test(written), "a coach must not be able to promote itself: " + written);
});

test("an existing admin may still change its own account type", async () => {
  const stub = baseStub({
    supabaseRest: async function () { return [{ role: "admin" }]; }
  });
  const res = await call(loadEndpoint(stub), { accessToken: "valid-owner-token", role: "coach" });
  assert.strictEqual(res.statusCode, 200);
  const upsertRoles = stub.calls.upserts.map(function (u) { return u.input && u.input.role; });
  assert.ok(upsertRoles.indexOf("coach") !== -1,
    "an admin's own account-type control must keep working, got: " + JSON.stringify(upsertRoles));
});

test("a failed role lookup refuses the change rather than granting it", async () => {
  const stub = baseStub({
    supabaseRest: async function () { throw new Error("database unavailable"); }
  });
  const res = await call(loadEndpoint(stub), { accessToken: "valid-owner-token", role: "admin" });
  assert.strictEqual(res.statusCode, 200);
  const written = adminWrites(stub).map(function (c) { return String(c.body || ""); }).join(" ");
  assert.ok(!/admin/.test(written), "an unreadable role must never be treated as admin: " + written);
});

test("GET cannot update an account", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), { accessToken: "valid-owner-token" }, "GET");
  assert.strictEqual(res.statusCode, 405);
  assert.strictEqual(adminWrites(stub).length, 0);
});

test("a short password is still rejected", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), { accessToken: "valid-owner-token", password: "short" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(adminWrites(stub).length, 0);
});

test("the client sends an access token, and fails loudly without one", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "scripts", "clarity-supabase-auth.js"), "utf8");
  const idx = src.indexOf("async function updateAccount(data)");
  assert.ok(idx !== -1, "updateAccount should still exist");
  const fn = src.slice(idx, idx + 2200);
  assert.ok(/freshAccessToken\(\)/.test(fn), "the client must obtain a token or every update 401s");
  assert.ok(/accessToken:\s*token/.test(fn), "the token must actually be sent");
  assert.ok(/session_expired/.test(fn),
    "a missing token must surface as an explicit error - a silent no-op would look like a saved change");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("auth-update-account failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("auth-update-account passed: " + tests.length + " checks");
})();
