/* A real account must never be identified as the seeded demo profile.
 *
 * On a fresh install gdInstallPlaceholderProfile seeds gd_placeholder_demo_player
 * and makes it active. The admin bootstrap then did:
 *
 *   const profile = ensureProfile();      // -> the placeholder
 *   const account = { profileId: profile.id, ... };
 *
 * so the account was permanently identified as the demo player. Everything
 * derived from the profile id inherited it: userId() became
 * "user-gd-placeholder-demo-player", course library keys were namespaced under
 * it, and every captured scan reached Supabase stamped
 * player_id=gd_placeholder_demo_player.
 *
 * The normal signup path already mints gdNewProfileId(). These lock bootstrap to
 * the same behaviour and cover the repair for accounts already stuck. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CORE = path.join(ROOT, "scripts", "gd-app-core.js");
const src = fs.readFileSync(CORE, "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Run the two real functions against a minimal harness, so behaviour is
   exercised rather than pattern-matched. gd-app-core is 25k lines of browser
   globals, so the functions are lifted out with their dependencies stubbed. */
function harness() {
  const state = {
    GD_PLACEHOLDER_PROFILE_ID: "gd_placeholder_demo_player",
    profiles: [],
    activeId: null,
    viewingProfileId: null,
    saves: 0,
    idSeq: 0
  };

  function extract(signature) {
    const idx = src.indexOf(signature);
    assert.notStrictEqual(idx, -1, "could not find " + signature);
    const end = src.indexOf("\n}", idx);
    assert.notStrictEqual(end, -1, "could not bound " + signature);
    return src.slice(idx, end + 2);
  }

  const code = [
    extract("function gdProfileForNewAccount()"),
    extract("function gdRepairPlaceholderAccountProfile(account)")
  ].join("\n");

  const scope = {
    GD_PLACEHOLDER_PROFILE_ID: state.GD_PLACEHOLDER_PROFILE_ID,
    GD_PROFILE_STATE: { get profiles() { return state.profiles; }, set profiles(v) { state.profiles = v; },
      get activeId() { return state.activeId; }, set activeId(v) { state.activeId = v; } },
    GD_ACCOUNT_STATE: { get viewingProfileId() { return state.viewingProfileId; },
      set viewingProfileId(v) { state.viewingProfileId = v; } },
    ensureProfile: function () { return state.profiles.find(function (p) { return p.id === state.activeId; }) || null; },
    gdProfileById: function (id) { return state.profiles.find(function (p) { return p.id === id; }) || null; },
    gdNewProfileId: function () { state.idSeq += 1; return "player" + (40 + state.idSeq); },
    gdDefaultProfile: function () { state.idSeq += 1; return { id: "player" + (40 + state.idSeq), name: "Demo Player", handicap: "8.4", placeholderProfile: true }; },
    savePlayerProfiles: function () { state.saves += 1; },
    gdAccountsSave: function () { state.saves += 1; }
  };

  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const build = new Function(names.join(","), code + "\nreturn {gdProfileForNewAccount:gdProfileForNewAccount,gdRepairPlaceholderAccountProfile:gdRepairPlaceholderAccountProfile};");
  return { api: build.apply(null, names.map(function (n) { return scope[n]; })), state: state };
}

test("bootstrap does not adopt the seeded placeholder", () => {
  const h = harness();
  h.state.profiles = [{ id: "gd_placeholder_demo_player", name: "Demo Player", placeholderProfile: true }];
  h.state.activeId = "gd_placeholder_demo_player";

  const profile = h.api.gdProfileForNewAccount();
  assert.notStrictEqual(
    profile.id, "gd_placeholder_demo_player",
    "a new account must not be identified as the demo player"
  );
  assert.strictEqual(profile.placeholderProfile, false, "and must not still be flagged as a placeholder");
});

test("a real active profile is used as-is", () => {
  const h = harness();
  h.state.profiles = [{ id: "player47", name: "Sam", placeholderProfile: false }];
  h.state.activeId = "player47";
  assert.strictEqual(
    h.api.gdProfileForNewAccount().id, "player47",
    "an existing real profile must not be replaced - that would orphan the user's data"
  );
});

test("an account already stuck on the placeholder is repaired", () => {
  const h = harness();
  h.state.profiles = [{ id: "gd_placeholder_demo_player", name: "Sam Hale", handicap: "8.4", email: "s@e.com" }];
  h.state.activeId = "gd_placeholder_demo_player";
  h.state.viewingProfileId = "gd_placeholder_demo_player";
  const account = { accountId: "acct_1", profileId: "gd_placeholder_demo_player", name: "Sam Hale", email: "s@e.com" };

  assert.strictEqual(h.api.gdRepairPlaceholderAccountProfile(account), true, "repair should report that it acted");
  assert.notStrictEqual(account.profileId, "gd_placeholder_demo_player", "the account must be re-pointed");
  assert.strictEqual(
    h.state.profiles.some(function (p) { return p.id === "gd_placeholder_demo_player"; }), false,
    "the placeholder id must not survive as a real profile"
  );
  assert.strictEqual(h.state.activeId, account.profileId, "active profile follows the repair");
  assert.strictEqual(h.state.viewingProfileId, account.profileId, "viewing profile follows the repair");
});

test("the repair carries the user's data across", () => {
  const h = harness();
  h.state.profiles = [{ id: "gd_placeholder_demo_player", name: "Sam Hale", handicap: "8.4", bag: ["7i"], email: "s@e.com" }];
  h.state.activeId = "gd_placeholder_demo_player";
  const account = { accountId: "acct_1", profileId: "gd_placeholder_demo_player", name: "Sam Hale", email: "s@e.com" };
  h.api.gdRepairPlaceholderAccountProfile(account);
  const moved = h.state.profiles.find(function (p) { return p.id === account.profileId; });
  assert.ok(moved, "the replacement profile must exist");
  assert.deepStrictEqual(moved.bag, ["7i"], "bag must survive the re-id");
  assert.strictEqual(moved.name, "Sam Hale", "name must survive");
});

test("the repair is a no-op for a healthy account", () => {
  const h = harness();
  h.state.profiles = [{ id: "player47", name: "Sam" }];
  const account = { accountId: "acct_1", profileId: "player47" };
  assert.strictEqual(h.api.gdRepairPlaceholderAccountProfile(account), false, "must not touch a healthy account");
  assert.strictEqual(account.profileId, "player47");
});

test("the repair runs whenever an account resolves its profile", () => {
  const idx = src.indexOf("function gdAccountEnsureProfile(account){");
  assert.notStrictEqual(idx, -1);
  const fn = src.slice(idx, idx + 300);
  assert.ok(
    /gdRepairPlaceholderAccountProfile\(account\)/.test(fn),
    "hooking the repair here means existing installs self-heal on next load"
  );
});

test("bootstrap no longer calls ensureProfile directly for a new account", () => {
  assert.ok(
    /const profile=gdProfileForNewAccount\(\);/.test(src),
    "the admin bootstrap must use the guarded helper"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("placeholder-profile-identity failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("placeholder-profile-identity passed: " + tests.length + " checks");
})();
