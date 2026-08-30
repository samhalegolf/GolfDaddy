/*
 * A signed-out session snapshot must be a clean guest.
 *
 * Logout clears the active account but deliberately leaves the profile store
 * behind, and GolfDaddyProfiles.active() falls back to the first stored
 * profile. clarity-session.js used to let that residual profile fill in
 * accountName / accountEmail / viewedProfileId / role for a signed-out
 * snapshot, which is how a logged-out play preview ended up headed with the
 * previous owner's name.
 *
 * Run: node dev/session-guest-snapshot.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function boot(state) {
  const window = {
    GolfDaddyAccounts: {
      current: () => state.account,
      state: () => state.accountState || {}
    },
    GolfDaddyProfiles: { active: () => state.profile },
    dispatchEvent: () => {},
    addEventListener: () => {}
  };
  window.window = window;
  const document = { readyState: "complete", body: { dataset: {} }, addEventListener: () => {} };
  const sandbox = { window, document, Date, String, JSON, Object, CustomEvent: function () {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "scripts", "clarity-session.js"), "utf8"), sandbox);
  return window.ClaritySession;
}

const residual = { id: "profile-a", name: "Alex", email: "alex@example.com", permission: "coach" };

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("signed out, a residual profile does not name or identify the session", () => {
  const session = boot({ account: null, profile: residual }).get();
  assert.strictEqual(session.isSignedIn, false);
  assert.strictEqual(session.accountName, "", "residual profile name leaked into accountName");
  assert.strictEqual(session.accountEmail, "", "residual profile email leaked into accountEmail");
  assert.strictEqual(session.viewedProfileId, "", "residual profile id leaked into viewedProfileId");
  assert.strictEqual(session.accountRole, "player", "residual profile permission leaked into the role");
  assert.strictEqual(session.isStaff, false);
});

test("signed in, the active profile still fills gaps the account leaves", () => {
  const session = boot({
    account: { accountId: "acc-1", profileId: "profile-a", role: "player", name: "", email: "" },
    profile: residual
  }).get();
  assert.strictEqual(session.isSignedIn, true);
  assert.strictEqual(session.accountName, "Alex");
  assert.strictEqual(session.accountEmail, "alex@example.com");
});

let failed = 0;
tests.forEach((entry) => {
  try {
    entry.fn();
    console.log("  ok  " + entry.name);
  } catch (error) {
    failed += 1;
    console.error("  FAIL  " + entry.name + "\n        " + (error && error.message));
  }
});
if (failed) process.exit(1);
console.log("session-guest-snapshot passed: " + tests.length + " checks");
