/* Checkout and billing-portal calls carry a usable token and nothing else.
 *
 * Two separate problems, fixed together on 2026-07-27:
 *
 * 1. Stale tokens. Both calls used requestHeaders(), which sent whatever access
 *    token happened to be in localStorage. Supabase access tokens expire roughly
 *    hourly, and create-checkout-session requires a validated one, so a member
 *    who left the tab open got "Sign in before buying access" while looking at a
 *    signed-in screen - with no refresh and no retry, the only way out was a
 *    manual reload. The referral and admin calls already refreshed first and
 *    retried once after a 401; these two did not.
 *
 * 2. Identity in the body. Both posted accountPayload() - account id and email.
 *    Neither endpoint reads it: resolveAccount(requireAuth: true) takes the
 *    token or 401s. Sending it made a path that grants nothing look like a
 *    supported way to say who you are, which is the shape of the referrals and
 *    payment-admin bypasses fixed the same day.
 *
 * The server contract is asserted too - requireAuth: true is what makes the
 * payload inert, so a change there would silently make the body meaningful
 * again. Behavioural proof that an unauthenticated checkout is refused lives in
 * dev/payment-rollout-tests.js. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* The source client plus the Capacitor sync outputs. The native copies are
   gitignored build artifacts, so they are checked only when present - a fresh CI
   checkout has just the source, which is what they are generated from. */
const CLIENTS = [
  path.join(ROOT, "scripts", "clarity-payments.js"),
  path.join(ROOT, "ios", "App", "App", "public", "scripts", "clarity-payments.js"),
  path.join(ROOT, "android", "app", "src", "main", "assets", "public", "scripts", "clarity-payments.js")
];

const CALLS = [
  { fn: "async function buy", endpoint: "CHECKOUT_ENDPOINT", label: "checkout" },
  { fn: "async function manageMembership", endpoint: "PORTAL_ENDPOINT", label: "billing portal" }
];

function bodyOf(src, marker) {
  const start = src.indexOf(marker);
  assert.notStrictEqual(start, -1, "could not find " + marker);
  /* Up to the next top-level function declaration, so assertions cannot drift
     into a neighbouring call and pass on its behaviour. */
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\n  (?:async )?function /);
  return rest.slice(0, next === -1 ? rest.length : next);
}

function eachClient(run) {
  let checked = 0;
  CLIENTS.forEach(function (file) {
    if (!fs.existsSync(file)) return;
    checked += 1;
    run(fs.readFileSync(file, "utf8"), file);
  });
  assert.ok(checked > 0, "at least the source client must be present");
}

CALLS.forEach(function (call) {
  test("the " + call.label + " call refreshes an expired token first", () => {
    eachClient(function (src, file) {
      const fn = bodyOf(src, call.fn);
      assert.ok(/authedHeaders\(false\)/.test(fn),
        call.label + " must use the refresh-aware header helper: " + file);
      assert.ok(!/requestHeaders\(\)/.test(fn),
        call.label + " must not send whatever token is in storage: " + file);
    });
  });

  test("the " + call.label + " call retries once after a 401", () => {
    eachClient(function (src, file) {
      const fn = bodyOf(src, call.fn);
      assert.ok(/response\.status === 401[\s\S]*authedHeaders\(true\)/.test(fn),
        "a just-expired session must recover silently rather than telling a signed-in member to sign in: " + file);
      /* The retry has to reuse one prepared body. Rebuilding it, or retrying a
         consumed Response, is how this pattern usually breaks. */
      assert.ok(/var requestBody = /.test(fn),
        call.label + " should build the body once and reuse it on retry: " + file);
      const posts = fn.match(/fetch\(/g) || [];
      assert.strictEqual(posts.length, 2,
        call.label + " should make exactly the initial call and one retry: " + file);
    });
  });

  test("the " + call.label + " call sends no account identity", () => {
    eachClient(function (src, file) {
      const fn = bodyOf(src, call.fn);
      const sent = fn.split("\n").filter(function (l) { return /var requestBody = /.test(l); })[0] || "";
      assert.ok(sent, "the request body should be built in " + call.label + ": " + file);
      assert.ok(!/accountPayload\(\)/.test(sent),
        "the endpoint resolves the caller from the token; sending an account makes a dead path look supported: " + sent.trim() + " [" + file + "]");
      assert.ok(!/\baccountId\b|\bemail\b/.test(sent),
        call.label + " must not name an account in the request body: " + sent.trim() + " [" + file + "]");
    });
  });
});

test("the signed-in gate is kept, so a signed-out tap does not fire a doomed request", () => {
  /* accountPayload() is still used in both - as a local gate only. Removing it
     would send a request that can only 401 instead of opening the profile. */
  eachClient(function (src, file) {
    CALLS.forEach(function (call) {
      const fn = bodyOf(src, call.fn);
      assert.ok(/accountPayload\(\)/.test(fn), call.label + " should still check for a signed-in user: " + file);
      assert.ok(/gdOpenProfileV67/.test(fn), call.label + " should open the profile gate when signed out: " + file);
    });
  });
});

test("both endpoints require a validated token, which is what makes the body inert", () => {
  [
    { file: "create-checkout-session.js", label: "checkout" },
    { file: "create-billing-portal-session.js", label: "billing portal" }
  ].forEach(function (entry) {
    const src = fs.readFileSync(path.join(ROOT, "functions", entry.file), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(/resolveAccount\(payload,\s*\{[^}]*requireAuth:\s*true/.test(code),
      entry.label + " must resolve the caller with requireAuth: true - without it the payload becomes identity again");
    assert.ok(!/x-clarity-account-id|x-clarity-account-email/i.test(code),
      entry.label + " must not read identity from request headers");
  });
});

test("the billing portal reads nothing else from the body", () => {
  /* Justifies sending {}. If the portal ever starts reading a field, this fails
     and the empty body has to be revisited. */
  const src = fs.readFileSync(path.join(ROOT, "functions", "create-billing-portal-session.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const reads = (code.match(/payload\.[A-Za-z_]+/g) || []);
  assert.deepStrictEqual(reads, [],
    "the client sends an empty body, so any payload field read here would silently be undefined: " + reads.join(", "));
});

test("checkout still sends the product, which is the one thing the body is for", () => {
  eachClient(function (src, file) {
    const fn = bodyOf(src, "async function buy");
    const sent = fn.split("\n").filter(function (l) { return /var requestBody = /.test(l); })[0] || "";
    assert.ok(/productKey/.test(sent) && /passType/.test(sent),
      "stripping identity must not strip the product being bought: " + file);
  });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("payment-checkout-client failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("payment-checkout-client passed: " + tests.length + " checks");
})();
