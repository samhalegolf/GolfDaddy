/* Deep links into the native app.
 *
 * Reset emails link to https://caddy.claritygolf.app/?claritySetPassword=1. On
 * the web that URL is the page. In the app it is not: bundled assets load from
 * https://localhost, so an App Link opens the app with an EMPTY query string and
 * the incoming URL arrives as an event instead. Without handling that, the app
 * opens on the normal signed-out screen and the reset is silently dropped -
 * indistinguishable from the link being broken.
 *
 * The security-relevant part is the allowlist: an external link must not be able
 * to put arbitrary parameters into the app's startup state. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MODULE = path.join(ROOT, "scripts", "inline", "gd-native-deep-links.js");
const MANIFEST = path.join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml");
const ASSETLINKS = path.join(ROOT, ".well-known", "assetlinks.json");
const src = fs.readFileSync(MODULE, "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Run the real parser with a URL/URLSearchParams available. */
function loadParser() {
  const idx = src.indexOf("function actionableParams(rawUrl)");
  assert.notStrictEqual(idx, -1, "actionableParams must exist");
  const end = src.indexOf("\n  }", idx);
  const body = src.slice(idx, end + 4);
  const allowIdx = src.indexOf("var ALLOWED_PARAMS");
  const allowEnd = src.indexOf("];", allowIdx) + 2;
  const allow = src.slice(allowIdx, allowEnd);
  const safeFn = "function safe(fn, fallback){ try { return fn(); } catch (_e) { return fallback; } }";
  // eslint-disable-next-line no-new-func
  return new Function("URL", "URLSearchParams",
    allow + "\n" + safeFn + "\n" + body + "\nreturn actionableParams;")(URL, URLSearchParams);
}

const actionableParams = loadParser();

test("a reset link is recognised", () => {
  const parts = actionableParams("https://caddy.claritygolf.app/?claritySetPassword=1");
  assert.ok(parts, "a genuine reset link must be actionable");
  assert.ok(/claritySetPassword=1/.test(parts.query));
});

test("a Supabase recovery fragment is preserved", () => {
  /* The recovery token rides in the fragment, not the query. Copying only the
     query would drop it and the reset would fail with no visible reason. */
  const parts = actionableParams("https://caddy.claritygolf.app/#access_token=abc123&type=recovery");
  assert.ok(parts, "a fragment-only recovery link must still be actionable");
  assert.ok(/access_token=abc123/.test(parts.hash), "the token must survive");
});

test("an ordinary link does nothing", () => {
  assert.strictEqual(
    actionableParams("https://caddy.claritygolf.app/"), null,
    "opening the app from a plain link must not trigger a reload"
  );
  assert.strictEqual(actionableParams("https://caddy.claritygolf.app/?utm_source=email"), null);
});

test("only allowlisted parameters are carried across", () => {
  const parts = actionableParams(
    "https://caddy.claritygolf.app/?claritySetPassword=1&evil=payload&redirect=https://attacker.example"
  );
  assert.ok(parts, "the reset parameter should still be recognised");
  assert.ok(/claritySetPassword=1/.test(parts.query));
  assert.ok(!/evil/.test(parts.query), "an arbitrary parameter must not reach the app's startup state");
  assert.ok(!/redirect/.test(parts.query), "a redirect parameter from an external link is exactly what to refuse");
});

test("junk input is survived rather than thrown on", () => {
  assert.strictEqual(actionableParams("not a url"), null);
  assert.strictEqual(actionableParams(""), null);
  assert.strictEqual(actionableParams(null), null);
  assert.strictEqual(actionableParams(undefined), null);
});

test("both cold and warm start paths are handled", () => {
  assert.ok(/getLaunchUrl/.test(src), "cold start: the app was launched by the link");
  assert.ok(/addListener\("appUrlOpen"/.test(src), "warm start: the app was already running");
});

test("handling is guarded against repeating", () => {
  assert.ok(
    /HANDLED_GUARD/.test(src) && /sessionStorage/.test(src),
    "an appUrlOpen during startup could otherwise reload into a state that fires it again"
  );
});

test("the Android manifest declares a verified App Link", () => {
  const manifest = fs.readFileSync(MANIFEST, "utf8");
  assert.ok(/android:autoVerify="true"/.test(manifest), "without autoVerify the link opens the browser");
  assert.ok(/android.intent.action.VIEW/.test(manifest), "VIEW is what makes a link openable");
  assert.ok(/android:host="caddy.claritygolf.app"/.test(manifest), "the host must match the email links");
  assert.ok(/android:scheme="https"/.test(manifest), "App Links are https, not a custom scheme");
});

test("assetlinks.json is valid and matches the app", () => {
  const parsed = JSON.parse(fs.readFileSync(ASSETLINKS, "utf8"));
  assert.ok(Array.isArray(parsed) && parsed.length, "must be a non-empty array");
  const entry = parsed[0];
  assert.strictEqual(entry.target.package_name, "com.claritygolf.caddy", "package must match the app");
  assert.ok(
    Array.isArray(entry.target.sha256_cert_fingerprints) && entry.target.sha256_cert_fingerprints.length,
    "a fingerprint is what proves the app may claim the domain"
  );
  assert.ok(
    /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(entry.target.sha256_cert_fingerprints[0]),
    "fingerprint must be 32 colon-separated uppercase hex bytes or Android rejects it silently"
  );
});

test("the verification file is actually deployed", () => {
  /* Android fetches it over https. If the build does not copy it, verification
     fails silently and links keep opening the browser with no error anywhere. */
  const build = fs.readFileSync(path.join(ROOT, "scripts", "clarity-deploy-build.js"), "utf8");
  assert.ok(/"\.well-known"/.test(build), ".well-known must be in the deploy output");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("deep-links failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("deep-links passed: " + tests.length + " checks");
})();
