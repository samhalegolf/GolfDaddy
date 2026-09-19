/* Settings > Garmin Watch: the wrapper order, and the paid gate.
 *
 * THE BUG THIS EXISTS TO STOP COMING BACK. scripts/clarity-garmin.js wraps
 * window.gdPlayerSettingsShowSection, and so does clarity-payments.js. But
 * payments' install() re-captures whatever the current switcher is whenever
 * that is not its own, and it runs again on every clarity:session-changed. So
 * if Garmin wraps AFTER payments has installed, payments' next install takes
 * the Garmin wrapper as its "original" while the Garmin wrapper is still
 * holding payments' — and the two call each other until the stack blows. The
 * first version of that file did exactly this and died on the first click, with
 * a stack trace alternating between the two modules.
 *
 * The fix is ordering, not defence: the Garmin switcher is installed
 * synchronously at DOMContentLoaded, strictly before payments' own 150ms timer,
 * so payments wraps Garmin and its guard never fires again. That is a property
 * of WHEN the call is made, which no amount of reading the wrapper body will
 * tell you, so this test builds both wrappers and runs them.
 *
 * It also pins the two things a reader might otherwise "tidy" away:
 *   - the native entitlement flag defaults to false on both platforms, so the
 *     feature fails closed if the web layer never loads;
 *   - send() on both transports checks it, so a lapsed membership stops the
 *     watch receiving rather than only greying out a settings row.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const GARMIN_JS = path.join(ROOT, "scripts", "clarity-garmin.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Just enough DOM for the module to load and wrap the switcher. The menu row
   and the page need far more, but neither is involved in the wrapper cycle —
   the module skips both when no native plugin is present, which is the state
   this harness runs in. */
function makeSandbox() {
  const listeners = { document: {}, window: {} };
  const el = function () {
    return { hidden: true, className: "", innerHTML: "", style: {}, appendChild: function () {}, setAttribute: function () {} };
  };
  const documentStub = {
    readyState: "loading",
    addEventListener: function (name, fn) { (listeners.document[name] = listeners.document[name] || []).push(fn); },
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: el
  };
  const windowStub = {
    document: documentStub,
    addEventListener: function (name, fn) { (listeners.window[name] = listeners.window[name] || []).push(fn); },
    setTimeout: function () { return 0; },   /* the row installer never has to run here */
    Promise: Promise
  };
  windowStub.window = windowStub;
  const sandbox = {
    window: windowStub,
    document: documentStub,
    setTimeout: windowStub.setTimeout,
    Promise: Promise,
    console: console
  };
  sandbox.globalThis = sandbox;
  return {
    sandbox: sandbox,
    win: windowStub,
    fire: function (target, name) {
      (listeners[target][name] || []).forEach(function (fn) { fn({ type: name }); });
    }
  };
}

function loadGarmin(ctx) {
  vm.createContext(ctx.sandbox);
  vm.runInContext(fs.readFileSync(GARMIN_JS, "utf8"), ctx.sandbox, { filename: "clarity-garmin.js" });
}

/* A faithful miniature of clarity-payments.js's install(): it re-captures the
   current switcher whenever that is not its own, which is the half of the
   interaction that made the cycle possible. */
function makePayments(win, calls) {
  let original = null;
  function showSection(name) {
    calls.push("payments:" + name);
    if (original) original(name);
  }
  return function install() {
    if (win.gdPlayerSettingsShowSection !== showSection) {
      original = win.gdPlayerSettingsShowSection;
      win.gdPlayerSettingsShowSection = showSection;
    }
  };
}

test("the Garmin switcher is installed before payments, and the chain terminates", function () {
  const ctx = makeSandbox();
  const calls = [];
  ctx.win.gdPlayerSettingsShowSection = function base(name) { calls.push("base:" + name); };

  loadGarmin(ctx);
  /* DOMContentLoaded — the Garmin wrapper must go on NOW, not in a timer. */
  ctx.fire("document", "DOMContentLoaded");
  assert.notStrictEqual(
    ctx.win.gdPlayerSettingsShowSection.name, "base",
    "clarity-garmin.js did not wrap the switcher at DOMContentLoaded. If it was moved into a " +
    "setTimeout it now installs after clarity-payments, which recreates the mutual-recursion cycle."
  );

  /* Payments installs afterwards, as it really does (DOMContentLoaded + 150ms). */
  const paymentsInstall = makePayments(ctx.win, calls);
  paymentsInstall();

  calls.length = 0;
  ctx.win.gdPlayerSettingsShowSection("profile");   /* used to blow the stack */

  assert.deepStrictEqual(
    calls, ["payments:profile", "base:profile"],
    "the switcher chain should run payments -> garmin -> base exactly once each"
  );

  /* clarity:session-changed makes payments install() run again. Its guard must
     find itself already outermost and do nothing; if the Garmin wrapper had
     been installed late, this is the call that closed the loop. */
  paymentsInstall();
  calls.length = 0;
  ctx.win.gdPlayerSettingsShowSection("password");
  assert.deepStrictEqual(calls, ["payments:password", "base:password"], "a second payments install must not re-wrap");
});

test("wrapping happens once, however many times install() is called", function () {
  const ctx = makeSandbox();
  const calls = [];
  ctx.win.gdPlayerSettingsShowSection = function base(name) { calls.push("base:" + name); };
  loadGarmin(ctx);
  ctx.fire("document", "DOMContentLoaded");
  const afterFirst = ctx.win.gdPlayerSettingsShowSection;

  ctx.sandbox.window.ClarityGarmin.install();
  ctx.fire("document", "DOMContentLoaded");
  assert.strictEqual(ctx.win.gdPlayerSettingsShowSection, afterFirst, "the switcher was wrapped more than once");

  calls.length = 0;
  ctx.win.gdPlayerSettingsShowSection("support");
  assert.deepStrictEqual(calls, ["base:support"], "a double wrap would show the base call twice");
});

/* ------------------------------------------------------- the paid gate

   Source assertions, because the gate lives in native code this harness
   cannot run. They pin the two properties that make it a gate rather than a
   label: it starts closed, and the send path consults it. */

test("both native transports default the entitlement to false", function () {
  const swift = fs.readFileSync(path.join(ROOT, "ios", "App", "App", "Wearables", "Garmin", "GarminTransport.swift"), "utf8");
  const java = fs.readFileSync(path.join(ROOT, "android", "app", "src", "main", "java", "com", "claritygolf", "caddy", "wearables", "garmin", "GarminTransport.java"), "utf8");
  assert.ok(/private var entitled = false/.test(swift), "iOS: entitled must default to false so the feature fails closed");
  assert.ok(/private volatile boolean entitled = false/.test(java), "Android: entitled must default to false so the feature fails closed");
});

test("both native transports refuse to send while unentitled", function () {
  const swift = fs.readFileSync(path.join(ROOT, "ios", "App", "App", "Wearables", "Garmin", "GarminTransport.swift"), "utf8");
  const java = fs.readFileSync(path.join(ROOT, "android", "app", "src", "main", "java", "com", "claritygolf", "caddy", "wearables", "garmin", "GarminTransport.java"), "utf8");
  assert.ok(
    /func send\([^)]*\)[^}]*?guard entitled else \{ completion\(false\); return \}/s.test(swift),
    "iOS: send() must check `entitled` before anything else — the settings row is not the gate"
  );
  assert.ok(
    /private void send\([^)]*\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(!entitled\) \{ completion\.onResult\(false\); return; \}/.test(java),
    "Android: send() must check `entitled` before anything else — the settings row is not the gate"
  );
});

test("the UI asks ClarityPayments before pairing, and pairing is the thing it asks about", function () {
  const src = fs.readFileSync(GARMIN_JS, "utf8");
  assert.ok(/requireAccess\("use a Garmin watch"\)/.test(src), "the membership question should be asked through ClarityPayments.requireAccess");
  assert.ok(/function scan\(\)[^}]*if \(!requireAccess\(\)\) return false;/s.test(src), "scan() must ask before looking for watches");
  assert.ok(/function choose\([^)]*\)[^}]*if \(!requireAccess\(\)\) return false;/s.test(src), "choose() must ask before selecting a watch");
});

/* ------------------------------------------- the Android SDK integration

   Source assertions, because the SDK needs a device and Garmin Connect
   Mobile to exercise. They pin the things that were WRONG while the calls
   were written from inference, each of which compiles either way. */

test("the Connect IQ SDK is actually a dependency, at the version Maven has", function () {
  const gradle = fs.readFileSync(path.join(ROOT, "android", "app", "build.gradle"), "utf8");
  const vars = fs.readFileSync(path.join(ROOT, "android", "variables.gradle"), "utf8");
  assert.ok(
    /com\.garmin\.connectiq:ciq-companion-app-sdk/.test(gradle),
    "android/app/build.gradle must declare the Connect IQ Mobile SDK, or GarminTransport talks to nothing"
  );
  assert.ok(/connectIqSdkVersion\s*=\s*'2\.4\.0'/.test(vars),
    "expected connectIqSdkVersion 2.4.0 — note the SDK repo's README prints a stale 2.2.0");
});

test("inbound watch messages are read as a List, not a Map", function () {
  const java = fs.readFileSync(path.join(ROOT, "android", "app", "src", "main", "java", "com", "claritygolf",
    "caddy", "wearables", "garmin", "GarminTransport.java"), "utf8");
  assert.ok(
    /onMessageReceived\([^)]*List<Object>\s+\w+/s.test(java),
    "onMessageReceived's payload is a List<Object> in the real SDK. Treating it as a Map compiles, runs, " +
    "and silently drops every command the watch sends — there is no error to notice."
  );
  assert.ok(
    /for \(Object message : messages\)[\s\S]{0,200}?message instanceof Map/.test(java),
    "the Map check belongs on each ELEMENT of the list, never on the list itself"
  );
});

test("the SDK's checked exceptions are handled rather than assumed away", function () {
  const java = fs.readFileSync(path.join(ROOT, "android", "app", "src", "main", "java", "com", "claritygolf",
    "caddy", "wearables", "garmin", "GarminTransport.java"), "utf8");
  for (const name of ["InvalidStateException", "ServiceUnavailableException"]) {
    assert.ok(java.includes(name), "GarminTransport must handle " + name + " — nearly every SDK call throws it");
  }
});

test("the settings page tells apart 'cannot look' from 'looked and found none'", function () {
  const src = fs.readFileSync(GARMIN_JS, "utf8");
  assert.ok(/devices\.sdkLinked === false/.test(src), "the not-bundled case needs its own wording");
  assert.ok(/if \(devices\.reason\)/.test(src),
    "a reason with sdkLinked true means we could not look — sending the player to re-pair a watch that was " +
    "never the problem is the failure this branch exists to avoid");
  assert.ok(/No Garmin watches found/.test(src), "the genuinely-empty case still needs its own wording");
});

let failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log("ok   " + t.name); }
  catch (error) { failed++; console.error("FAIL " + t.name + "\n     " + error.message); }
});
console.log((tests.length - failed) + "/" + tests.length + " passed");
process.exit(failed ? 1 : 0);
