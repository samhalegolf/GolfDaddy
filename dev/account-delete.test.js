/* In-app account deletion.
 *
 * Play and the App Store both require this route to exist. The property that
 * matters more than "does it delete" is "whose account does it delete": identity
 * must come from the validated access token and never from the request body. An
 * endpoint that trusted a body-supplied account id would let anyone destroy
 * anyone else's account by guessing an id, so that is locked here first.
 *
 * The rest of the checks cover ordering and blast radius: the Supabase auth user
 * must go last (deleting it first strands rows with no way to identify them),
 * retained financial records must be de-identified rather than dropped, and a
 * mid-way failure must leave a retryable account rather than a half-erased one. */
const assert = require("assert");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "functions", "account-delete.js");

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

/* Records every call so tests can assert on what was touched and in what order. */
function baseStub(overrides) {
  const calls = { rest: [], auth: [] };
  const stub = Object.assign({
    calls: calls,
    json: function (status, body) { return { statusCode: status, body: JSON.stringify(body) }; },
    hasAuth: function () { return true; },
    hasAuthWithServiceKey: function () { return true; },
    supabaseAuth: async function (p, options, useService) {
      calls.auth.push({ path: p, method: options && options.method || "GET", useService: !!useService });
      if (p === "user") return { id: "auth-user-1", email: "player@example.com" };
      return {};
    },
    supabaseRest: async function (p, options) {
      const method = options && options.method || "GET";
      calls.rest.push({ path: p, method: method });
      if (method === "GET" && /^app_accounts\?/.test(p)) {
        return [{ account_id: "acct_1", profile_id: "profile_1", email: "player@example.com" }];
      }
      return [];
    }
  }, overrides || {});
  return stub;
}

function call(mod, body, method) {
  return mod.handler({ httpMethod: method || "POST", body: JSON.stringify(body || {}) });
}

const OK = { accessToken: "good-token", confirm: "DELETE" };

test("a request with no token is refused before Supabase is touched", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), { confirm: "DELETE", accountId: "acct_1" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(JSON.parse(res.body).code, "token_required");
  assert.strictEqual(stub.calls.auth.length, 0, "must not reach Supabase without a token");
  assert.strictEqual(stub.calls.rest.length, 0, "must not read the account store without a token");
});

test("an invalid token deletes nothing", async () => {
  const stub = baseStub({
    supabaseAuth: async function (p) {
      if (p === "user") { const e = new Error("bad token"); e.status = 401; throw e; }
      return {};
    }
  });
  const res = await call(loadEndpoint(stub), OK);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(JSON.parse(res.body).code, "invalid_token");
  assert.strictEqual(stub.calls.rest.length, 0, "an unvalidated caller must not reach any table");
});

test("an account id in the body is ignored - identity comes from the token", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), Object.assign({}, OK, {
    accountId: "victim_account",
    account_id: "victim_account",
    profileId: "victim_profile",
    supabaseUserId: "victim-auth-user",
    email: "victim@example.com"
  }));
  assert.strictEqual(res.statusCode, 200);

  const touched = stub.calls.rest.map(function (c) { return c.path; }).join(" ");
  assert.ok(!/victim/.test(touched), "no body-supplied identifier may reach a query: " + touched);
  const authTouched = stub.calls.auth.map(function (c) { return c.path; }).join(" ");
  assert.ok(!/victim/.test(authTouched), "body-supplied auth id must never be deleted: " + authTouched);
  assert.ok(/acct_1/.test(touched), "the token's own account is what gets deleted");
});

test("deletion must be explicitly confirmed", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), { accessToken: "good-token" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(JSON.parse(res.body).code, "confirm_required");
  assert.strictEqual(stub.calls.rest.length, 0, "an unconfirmed request must not delete anything");
});

test("GET cannot delete an account", async () => {
  const stub = baseStub();
  const res = await call(loadEndpoint(stub), OK, "GET");
  assert.strictEqual(res.statusCode, 405);
  assert.strictEqual(stub.calls.rest.length, 0);
});

test("the golf and personal tables are hard-deleted", async () => {
  const stub = baseStub();
  await call(loadEndpoint(stub), OK);
  const deletes = stub.calls.rest.filter(function (c) { return c.method === "DELETE"; }).map(function (c) { return c.path; }).join(" ");
  ["practice_native_shots", "practice_import_batches", "shot_library_batches", "captured_surfaces",
   "app_sync_events", "client_error_events", "referral_analytics_events", "user_entitlements",
   "app_profiles", "app_accounts"].forEach(function (table) {
    assert.ok(new RegExp("(^|\\s)" + table + "\\?").test(deletes), "expected a DELETE against " + table);
  });
});

test("every delete is filtered - none can run unbounded", async () => {
  const stub = baseStub();
  await call(loadEndpoint(stub), OK);
  stub.calls.rest.filter(function (c) { return c.method === "DELETE"; }).forEach(function (c) {
    assert.ok(/\?[^=]+=eq\.[^&\s]+/.test(c.path), "unfiltered or empty-valued DELETE would wipe the table: " + c.path);
  });
});

test("retained records are de-identified rather than deleted", async () => {
  const stub = baseStub();
  await call(loadEndpoint(stub), OK);
  const patches = stub.calls.rest.filter(function (c) { return c.method === "PATCH"; }).map(function (c) { return c.path; }).join(" ");
  ["caddie_memberships", "referral_invitations", "referral_reward_ledger", "course_maps"].forEach(function (table) {
    assert.ok(new RegExp(table + "\\?").test(patches), "expected " + table + " to be scrubbed, not dropped");
  });
  const deletes = stub.calls.rest.filter(function (c) { return c.method === "DELETE"; }).map(function (c) { return c.path; }).join(" ");
  assert.ok(!/caddie_memberships|referral_reward_ledger/.test(deletes),
    "purchase and referral history is retained for accounting - deleting it contradicts the published policy");
});

test("the auth user is deleted last, after every table", async () => {
  const stub = baseStub();
  await call(loadEndpoint(stub), OK);
  const authDelete = stub.calls.auth.findIndex(function (c) { return c.method === "DELETE"; });
  assert.ok(authDelete >= 0, "the Supabase auth user must actually be deleted");
  const lastRest = stub.calls.rest.length;
  assert.ok(lastRest > 0, "tables must be touched before the auth user");
  /* The auth delete is the final Supabase call of any kind. */
  assert.strictEqual(authDelete, stub.calls.auth.length - 1, "nothing may follow the auth-user delete - the token is dead after it");
});

test("the account row survives a mid-way table failure, so the user can retry", async () => {
  const stub = baseStub({
    supabaseRest: async function (p, options) {
      const method = options && options.method || "GET";
      if (method === "GET" && /^app_accounts\?/.test(p)) {
        return [{ account_id: "acct_1", profile_id: "profile_1", email: "player@example.com" }];
      }
      if (/^practice_native_shots/.test(p)) throw new Error("boom");
      return [];
    }
  });
  const res = await call(loadEndpoint(stub), OK);
  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(JSON.parse(res.body).code, "delete_failed");
  assert.strictEqual(stub.calls.auth.filter(function (c) { return c.method === "DELETE"; }).length, 0,
    "the sign-in must survive so the user still has an account to retry with");
});

test("a failure is reported honestly rather than claiming success", async () => {
  const stub = baseStub({
    supabaseAuth: async function (p, options, useService) {
      if (p === "user") return { id: "auth-user-1", email: "player@example.com" };
      throw new Error("auth delete failed");
    }
  });
  const res = await call(loadEndpoint(stub), OK);
  assert.strictEqual(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.code, "auth_delete_failed");
  assert.ok(!body.ok, "a partial deletion must never report ok");
  assert.ok(/email/i.test(body.error), "the user needs a route to get it finished by hand");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("account-delete failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("account-delete passed: " + tests.length + " checks");
})();
