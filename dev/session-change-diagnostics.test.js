/*
 * Session changes must say WHAT changed, and listeners must not overreact.
 *
 * Production showed bursts of clarity:session-changed every ~10 seconds during
 * play. Each one re-ran the payment pipeline and a full Supabase sync, and the
 * sync rows recorded only that a change happened - the flapping field was
 * invisible from the server, so every diagnosis was a guess.
 *
 * Two properties are pinned here:
 *
 *   1. Diagnosis: the session module records which identity fields flipped
 *      (with from/to) and the sync payload forwards it, so the next occurrence
 *      names its own cause in app_sync_events.
 *
 *   2. Damping: the payments listener re-runs its full pipeline only when WHO
 *      is signed in changed. accountRole is partly derived from payment status
 *      itself (player -> subscribedPlayer), so refreshing on a role-only change
 *      is the feedback edge of a loop: refresh -> applyStatus ->
 *      ClaritySession.sync -> session-changed -> refresh.
 *
 * Run: node dev/session-change-diagnostics.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const session = strip(read("scripts/clarity-session.js"));
const cloudSync = strip(read("scripts/clarity-cloud-sync.js"));
const payments = strip(read("scripts/clarity-payments.js"));
const server = strip(read("functions/account-sync.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("a session change names the fields that changed", () => {
  assert.ok(/function changedFields\(/.test(session), "clarity-session has no changedFields diff");
  assert.ok(
    /changedFields:\s*diff\.slice\(\)/.test(session),
    "the session-changed event detail does not carry changedFields"
  );
  assert.ok(
    /__gdLastSessionChange/.test(session),
    "the last change is not exposed for the sync payload to read"
  );
  assert.ok(
    /change\.from\[|from\[diff\[i\]\]/.test(session.replace(/\s+/g, "")) || /change\.from/.test(session),
    "from/to values are not recorded — fields alone cannot distinguish flap directions"
  );
});

test("sameSession and the diff cannot drift apart", () => {
  assert.ok(
    /function sameSession\(a, b\)\s*\{\s*return !!a && !!b && changedFields\(a, b\)\.length === 0;\s*\}/.test(session),
    "sameSession no longer defers to changedFields — two definitions of 'changed' will diverge"
  );
});

test("the sync payload forwards the change and the server stores it", () => {
  assert.ok(/sessionChange:/.test(cloudSync), "payloadFor does not include sessionChange");
  assert.ok(/__gdLastSessionChange/.test(cloudSync), "payloadFor does not read the recorded change");
  assert.ok(/sessionChange/.test(server), "account-sync drops sessionChange instead of storing it");
  assert.ok(
    /slice\(0,\s*5\)/.test(server),
    "the server does not cap the fields list — an untrusted client could stuff the row"
  );
});

test("payments only re-runs its pipeline when the signed-in identity changed", () => {
  const listener = /addEventListener\("clarity:session-changed",[\s\S]*?\}, 50\);\s*\}\);/.exec(payments);
  assert.ok(listener, "payments session-changed listener not found");
  const body = listener[0];
  assert.ok(
    /identityChanged/.test(body) && /accountId/.test(body) && /isSignedIn/.test(body),
    "the listener has no identity gate — a role-only flap re-runs the full pipeline, which is the loop"
  );
  assert.ok(
    /if \(!identityChanged\) return;/.test(body),
    "the gate exists but does not stop refresh/referral/dashboard work"
  );
  assert.ok(
    !/changedFields\.indexOf\("accountRole"\)/.test(body) || !/accountRole"\) !== -1/.test(body),
    "accountRole re-triggers the pipeline — that is the feedback edge this exists to cut"
  );
  assert.ok(
    /!fields \|\|/.test(body),
    "events without changedFields no longer fall back to the old behaviour"
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
console.log("session-change-diagnostics passed: " + tests.length + " checks");
