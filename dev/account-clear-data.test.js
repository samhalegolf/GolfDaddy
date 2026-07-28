/*
 * Clearing golf data must not become a quiet account deletion.
 *
 * Play's Data safety form distinguishes deleting an account from deleting some
 * of its data, and clarity-account-clear-data.js is the second one. The two
 * flows sit next to each other in the same settings menu, share a stylesheet and
 * were written from the same template, so the ways they can converge are all
 * copy-paste shaped:
 *
 *   - the clear endpoint growing a DELETE against app_accounts or app_profiles
 *   - the client falling back to localStorage.clear(), which drops the auth
 *     session and signs the user out of the account they chose to keep
 *   - the two confirmation words drifting to the same string, so muscle memory
 *     from one carries into the other
 *
 * None of those surface in normal use. A signed-out user who "only cleared their
 * data" reports it as a bug months later, if at all. So they are asserted here
 * rather than left to review.
 *
 * Run: node dev/account-clear-data.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const serverPath = path.join(ROOT, "functions", "account-clear-data.js");
const clientPath = path.join(ROOT, "scripts", "clarity-account-clear-data.js");
const deleteServerPath = path.join(ROOT, "functions", "account-delete.js");
const deleteClientPath = path.join(ROOT, "scripts", "clarity-account-delete.js");
const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const server = fs.readFileSync(serverPath, "utf8");
const client = fs.readFileSync(clientPath, "utf8");
const deleteServer = fs.readFileSync(deleteServerPath, "utf8");
const deleteClient = fs.readFileSync(deleteClientPath, "utf8");

/* These modules explain in prose exactly what they must not do - "a blanket
   clear would drop the auth session" and so on. Matching raw source therefore
   finds the comment warning against the bug and reports it as the bug. Assert
   against code only. */
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const serverCode = stripComments(server);
const clientCode = stripComments(client);
const deleteClientCode = stripComments(deleteClient);

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("the clear endpoint never deletes the account or profile row", () => {
  ["app_accounts", "app_profiles", "user_entitlements", "caddie_memberships"].forEach((table) => {
    assert.ok(
      !new RegExp('deleteWhere\\(\\s*"' + table + '"').test(serverCode),
      "account-clear-data.js deletes from " + table + " — that is a deletion, not a clear"
    );
    assert.ok(
      new RegExp('PROTECTED_TABLES[\\s\\S]*"' + table + '"').test(serverCode),
      table + " is not listed in PROTECTED_TABLES, so nothing stops a future delete against it"
    );
  });
  assert.ok(
    /PROTECTED_TABLES\.indexOf\(table\)\s*!==\s*-1/.test(serverCode),
    "deleteWhere does not refuse protected tables at runtime"
  );
});

test("the clear endpoint does not touch the Supabase auth user", () => {
  assert.ok(
    /admin\/users\//.test(deleteServer),
    "account-delete.js no longer removes the auth user — this test's premise has moved"
  );
  assert.ok(
    !/admin\/users\//.test(serverCode),
    "account-clear-data.js deletes the Supabase auth user — the sign-in must survive a clear"
  );
});

test("identity comes from the token, never the request body", () => {
  assert.ok(
    /encodeFilter\(authUserId\)/.test(serverCode),
    "the account is not resolved from the validated token's user id"
  );
  assert.ok(
    !/body\.accountId|body\.account_id/.test(serverCode),
    "an account id is read from the request body — anyone could clear anyone else's data"
  );
});

test("the two flows use different confirmation words", () => {
  const clearWord = /toUpperCase\(\)\s*!==\s*"([A-Z]+)"/.exec(server);
  const deleteWord = /toUpperCase\(\)\s*!==\s*"([A-Z]+)"/.exec(deleteServer);
  assert.ok(clearWord && deleteWord, "could not find a confirmation word in one of the endpoints");
  assert.strictEqual(clearWord[1], "CLEAR", "the clear endpoint does not require CLEAR");
  assert.strictEqual(deleteWord[1], "DELETE", "the delete endpoint no longer requires DELETE");
  assert.notStrictEqual(
    clearWord[1],
    deleteWord[1],
    "both flows take the same confirmation word — typing one would confirm the other"
  );
});

test("the client never blanket-clears storage", () => {
  assert.ok(
    /localStorage\.clear\(\)/.test(deleteClientCode),
    "account deletion no longer clears storage — this test's premise has moved"
  );
  assert.ok(
    !/localStorage\.clear\(\)|sessionStorage\.clear\(\)/.test(clientCode),
    "clarity-account-clear-data.js calls storage.clear() — that would sign the user out"
  );
});

test("the auth session key survives a clear", () => {
  assert.ok(
    /"clarity:supabase-auth-session:v1"/.test(client),
    "the Supabase auth session key is not in the PRESERVE list"
  );
  /* The preserved keys must actually be reachable by the pattern, or preserving
     them is meaningless decoration. */
  const pattern = /^(gd_|clarity|Clarity|GolfDaddy)/;
  const preserveBlock = /var PRESERVE = \[([\s\S]*?)\];/.exec(client);
  assert.ok(preserveBlock, "PRESERVE list not found");
  const keys = preserveBlock[1].match(/"([^"]+)"/g).map((s) => s.replace(/"/g, ""));
  assert.ok(keys.length >= 5, "PRESERVE list is suspiciously short");
  keys.forEach((key) => {
    assert.ok(
      pattern.test(key),
      'preserved key "' + key + '" does not match the Clarity key pattern, so it was never at risk'
    );
  });
});

test("the clear pattern matches the backup module's idea of Clarity data", () => {
  const backup = fs.readFileSync(path.join(ROOT, "scripts", "clarity-backup.js"), "utf8");
  const backupPattern = /var KEY_PATTERN = (\/[^\n]+\/);/.exec(backup);
  const clearPattern = /var KEY_PATTERN = (\/[^\n]+\/);/.exec(client);
  assert.ok(backupPattern && clearPattern, "KEY_PATTERN missing from one of the modules");
  assert.strictEqual(
    clearPattern[1],
    backupPattern[1],
    "what a backup captures and what a clear removes have drifted apart"
  );
});

test("the client is loaded by index.html", () => {
  assert.ok(
    /scripts\/clarity-account-clear-data\.js/.test(indexHtml),
    "clarity-account-clear-data.js is not loaded — the settings row would never appear"
  );
});

test("the server confirms before the client wipes the device", () => {
  const wipeIndex = client.indexOf("clearLocal()");
  const fetchIndex = client.indexOf("await fetch(ENDPOINT");
  assert.ok(fetchIndex !== -1 && wipeIndex !== -1, "could not locate the request and the wipe");
  assert.ok(
    fetchIndex < client.lastIndexOf("clearLocal()"),
    "local data is wiped before the server confirms — a failed request would look like success"
  );
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
console.log("account-clear-data passed: " + tests.length + " checks");
