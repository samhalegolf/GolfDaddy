/*
 * A failed entitlement check must not revoke access.
 *
 * clarity-payments.refresh() used to force active:false and empty the
 * entitlements in its catch block, so a dropped request was indistinguishable
 * from a cancelled membership.
 *
 * That is not a rare edge on a golf course. Every signal blip flipped access
 * off, the next success flipped it back, and clarity-session derives
 * accountRole from hasActiveAccess() - so each flip read as an identity change
 * and fired clarity:session-changed. Its listeners re-run install(),
 * acceptStoredReferral(), refresh() and loadReferralDashboard() in
 * clarity-payments plus a full account sync in clarity-cloud-sync, which is
 * self-sustaining while the network stays flaky. Production sync rows showed
 * one session-changed per minute for seven consecutive minutes during a round.
 *
 * The rule this pins: only an authoritative server answer may downgrade access.
 * A transport failure preserves the last known-good status.
 *
 * Run: node dev/payment-access-failsafe.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "scripts", "clarity-payments.js"), "utf8");

function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const code = stripComments(source);

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* The catch block of refresh(): from "} catch (error) {" through the saveStatus
   call that follows it. Narrow, so an active:false elsewhere cannot mask a
   regression here or cause a false alarm. */
function refreshCatchBlock() {
  const marker = code.indexOf("async function refresh(");
  assert.ok(marker !== -1, "refresh() not found — this test needs rewriting");
  const catchAt = code.indexOf("} catch (error) {", marker);
  assert.ok(catchAt !== -1, "refresh() has no catch block");
  const end = code.indexOf("return status;", catchAt);
  assert.ok(end !== -1, "could not find the end of refresh()'s catch block");
  return code.slice(catchAt, end);
}

test("a failed refresh does not revoke access", () => {
  const block = refreshCatchBlock();
  assert.ok(
    !/active:\s*false/.test(block),
    "refresh()'s catch block forces active:false — a dropped request would revoke a paying user's access mid-round"
  );
  assert.ok(
    !/entitlements:\s*\[\]/.test(block),
    "refresh()'s catch block empties entitlements on a transport failure"
  );
});

test("a failed refresh still records that it failed", () => {
  const block = refreshCatchBlock();
  assert.ok(
    /connectionIssue:\s*true/.test(block),
    "the failure is not recorded, so the UI cannot tell stale access from confirmed access"
  );
  assert.ok(
    /Object\.assign\(\{\},\s*status,/.test(block),
    "the previous status is not carried forward, so known-good access is lost anyway"
  );
});

test("the success path is still able to downgrade", () => {
  /* Fail-safe must not become fail-open: when the server actually answers, its
     answer wins, including a downgrade to no access. */
  assert.ok(
    /if \(!response\.ok\) throw new Error/.test(code),
    "a non-ok response no longer throws — a server error would be treated as a status"
  );
  assert.ok(
    /pending = false; return saveStatus\(body\);/.test(code),
    "the success path no longer saves the server's body verbatim"
  );
});

test("signing out still clears access immediately", () => {
  /* This downgrade is authoritative and local - no request involved - so it must
     survive the fail-safe change. */
  assert.ok(
    /if \(!signedIn\.accountId && !signedIn\.email\) return saveStatus\(\{ active: false/.test(code),
    "a signed-out user no longer has access cleared"
  );
});

test("access is still read from the saved status", () => {
  assert.ok(
    /function hasActiveAccess\(\)[\s\S]{0,200}status && status\.active/.test(code),
    "hasActiveAccess no longer reads status.active — the fail-safe would be bypassed"
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
console.log("payment-access-failsafe passed: " + tests.length + " checks");
