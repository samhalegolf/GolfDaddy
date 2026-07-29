/*
 * Restoring a lost player list must never destroy a present one.
 *
 * The bug this fixes: gd_player_profiles_v27 is local-only, sync pushed it up
 * and nothing read it back, so any storage wipe rendered the list as 0 and the
 * app minted a replacement profile with a fresh random id. Seven "Sam Hale"
 * rows accumulated on one account that way.
 *
 * The fix is deliberately NOT a two-way sync, and that restraint is the thing
 * worth pinning. There is no server-side profile delete, so a merge would
 * resurrect locally-deleted players on every launch, and would overwrite offline
 * edits with staler server copies. Filling only an empty list cannot do either.
 *
 * Both failure modes are silent and only reachable with real data, so they are
 * asserted structurally here and exercised behaviourally against a stubbed
 * storage + fetch below.
 *
 * Run: node dev/profile-hydrate.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const clientPath = path.join(ROOT, "scripts", "clarity-profile-hydrate.js");
const serverPath = path.join(ROOT, "functions", "account-profiles.js");

const client = fs.readFileSync(clientPath, "utf8");
const server = fs.readFileSync(serverPath, "utf8");
const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const netlify = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");

function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const serverCode = stripComments(server);

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* ---------- structure ---------- */

test("the endpoint is read-only", () => {
  ["DELETE", "PATCH", "PUT"].forEach((verb) => {
    assert.ok(
      !new RegExp('method:\\s*"' + verb + '"').test(serverCode),
      "account-profiles.js issues a " + verb + " — restoring a list must not be able to damage it"
    );
  });
  assert.ok(
    !/on_conflict|Prefer/.test(serverCode),
    "account-profiles.js looks like it upserts; it should only read"
  );
});

test("identity comes from the token, never the body", () => {
  assert.ok(
    /encodeFilter\(authUserId\)/.test(serverCode),
    "the account is not resolved from the validated token's user id"
  );
  assert.ok(
    !/body\.accountId|body\.account_id/.test(serverCode),
    "an account id is read from the body — anyone could read anyone else's players"
  );
});

test("the endpoint is wired up", () => {
  assert.ok(
    /scripts\/clarity-profile-hydrate\.js/.test(indexHtml),
    "clarity-profile-hydrate.js is not loaded by index.html"
  );
  assert.ok(
    /from = "\/api\/account-profiles"/.test(netlify),
    "no /api/account-profiles redirect — the client would 404"
  );
});

/* ---------- behaviour ---------- */

function run(opts) {
  const store = { value: opts.stored == null ? null : JSON.stringify(opts.stored) };
  let fetchCalls = 0;
  const events = [];

  const sandbox = {
    console,
    setTimeout: (fn) => { sandbox.__scheduled = fn; },
    localStorage: {
      getItem: (k) => (k === "gd_player_profiles_v27" ? store.value : null),
      setItem: (k, v) => { if (k === "gd_player_profiles_v27") store.value = v; }
    },
    document: { readyState: "complete", addEventListener() {} },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    fetch: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => opts.response };
    }
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (type, fn) => { events.push(type); };
  sandbox.window.dispatchEvent = () => {};
  /* Not `opts.token || "tok"` — that turns the deliberately-empty token of the
     signed-out case back into a valid one, and the test passes vacuously. */
  sandbox.window.ClaritySupabaseAuth = {
    freshAccessToken: async () => (opts.token === undefined ? "tok" : opts.token)
  };

  vm.createContext(sandbox);
  vm.runInContext(client, sandbox);
  return { sandbox, store, fetchCalls: () => fetchCalls, events };
}

test("an empty list is restored from the server", async () => {
  const ctx = run({
    stored: { profiles: [], activeId: null },
    response: {
      ok: true,
      accountId: "acct_x",
      activeProfileId: "player41",
      profiles: [
        { profile_id: "player41", name: "Sam Hale", profile_json: { id: "player41", name: "Sam Hale", bag: [1, 2] } },
        { profile_id: "player22", name: "Sam Hale", profile_json: null, handedness: "left" }
      ]
    }
  });
  const did = await ctx.sandbox.ClarityProfileHydrate.hydrate("test");
  assert.strictEqual(did, true, "hydrate did not restore an empty list");
  const written = JSON.parse(ctx.store.value);
  assert.strictEqual(written.profiles.length, 2, "wrong number of profiles restored");
  assert.strictEqual(written.activeId, "player41", "activeId did not follow the account's profile_id");
  assert.deepStrictEqual(
    written.profiles[0].bag, [1, 2],
    "profile_json was not used, so the restore lost fields the columns never held"
  );
  assert.strictEqual(
    written.profiles[1].handedness, "left",
    "column fallback did not apply for a row without profile_json"
  );
});

test("a populated list is never touched, and no request is even made", async () => {
  const existing = { profiles: [{ id: "player77", name: "Real Local Player" }], activeId: "player77" };
  const ctx = run({
    stored: existing,
    response: { ok: true, accountId: "acct_x", activeProfileId: "player41", profiles: [{ profile_id: "player41" }] }
  });
  const did = await ctx.sandbox.ClarityProfileHydrate.hydrate("test");
  assert.strictEqual(did, false, "hydrate overwrote a populated list");
  assert.deepStrictEqual(
    JSON.parse(ctx.store.value), existing,
    "the local list was modified — deleted players would come back and offline edits would be lost"
  );
  assert.strictEqual(ctx.fetchCalls(), 0, "a request was made even though the list was populated");
});

test("an empty server response leaves local state alone", async () => {
  const ctx = run({
    stored: { profiles: [], activeId: null },
    response: { ok: true, accountId: "acct_x", activeProfileId: "", profiles: [] }
  });
  const did = await ctx.sandbox.ClarityProfileHydrate.hydrate("test");
  assert.strictEqual(did, false, "hydrate claimed success with nothing to restore");
});

test("no token means no request", async () => {
  const ctx = run({ stored: { profiles: [] }, token: "", response: { ok: true, profiles: [] } });
  const did = await ctx.sandbox.ClarityProfileHydrate.hydrate("test");
  assert.strictEqual(did, false, "hydrate proceeded without a session");
  assert.strictEqual(ctx.fetchCalls(), 0, "a request was made without an access token");
});

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      console.log("  ok  " + entry.name);
    } catch (error) {
      failed += 1;
      console.error("  FAIL  " + entry.name + "\n        " + (error && error.message));
    }
  }
  if (failed) process.exit(1);
  console.log("profile-hydrate passed: " + tests.length + " checks");
})();
