/* The /app/ surface's native contract.
 *
 * Every defect this file guards shipped green through the existing suite, and
 * for one reason: the harness is Chromium over an HTTP server, and Chromium
 * behaves like neither Capacitor shell. Two whole classes of bug are invisible
 * to it —
 *
 *   1. URL routing. Both native shells resolve an extensionless path to the
 *      BUNDLE ROOT index.html rather than to a directory index, so navigating
 *      to "/app/" silently re-entered the old shell on a phone while working
 *      perfectly in every browser and in CI.
 *   2. Origin. Bundled assets load from capacitor://localhost, so a relative
 *      "/api/..." resolves against the webview instead of the deployed
 *      functions. Every consumer on this surface is fail-open by design, so
 *      that degraded silently rather than erroring.
 *
 * So this test does not open a browser. It models the two routers from their
 * own source and reads the shipped files, which is the only way to assert
 * something a Chromium harness structurally cannot observe.
 *
 * Run: node dev/app-native-contract.test.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const appHtml = read("app/index.html");
const bootJs = read("app/js/boot.js");
const durableJs = read("scripts/inline/gd-durable-storage.js");
const pickerJs = read("scripts/inline/gd-course-picker-search-v2.js");

/* ---------------------------------------------------------------------------
 * 1. The routers, modelled from Capacitor's own source.
 *
 * iOS  — @capacitor/ios .../Capacitor/Router.swift:
 *          if pathUrl.pathExtension.isEmpty { return basePath + "/index.html" }
 * Android — @capacitor/android .../WebViewLocalServer.java:399:
 *          path.equals("/") || (!lastPathSegment.contains(".") && html5mode)
 *        html5mode defaults true (CapConfig.java:36) and capacitor.config.json
 *        does not set server.html5mode.
 * ------------------------------------------------------------------------- */
function iosRoute(urlPath) {
  const last = urlPath.split("/").filter(Boolean).pop() || "";
  return last.includes(".") ? urlPath : "/index.html";
}
function androidRoute(urlPath) {
  if (urlPath === "/") return "/index.html";
  const last = urlPath.split("/").filter(Boolean).pop() || "";
  return last.includes(".") ? urlPath : "/index.html";
}

/* Both routers agree, so a target is either right on both platforms or wrong on
   both. Asserted rather than assumed - if a future Capacitor changes one of
   them, this is where that shows up. */
["/app/", "/app", "/", "/studio/"].forEach((p) => {
  assert.strictEqual(iosRoute(p), "/index.html", "iOS should collapse " + p);
  assert.strictEqual(androidRoute(p), "/index.html", "Android should collapse " + p);
});
assert.strictEqual(iosRoute("/app/index.html"), "/app/index.html");
assert.strictEqual(androidRoute("/app/index.html"), "/app/index.html");

/* Every same-origin navigation the shell performs must survive both routers.
   A target that collapses to /index.html when the author meant a different page
   is the P0 this file exists for. */
const NAV_RE = /(?:window\.)?location\.(?:href\s*=|replace\()\s*["'](\/[^"'?#]*)/g;
const shellSources = fs.readdirSync(path.join(ROOT, "scripts", "inline"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => ["scripts/inline/" + f, read("scripts/inline/" + f)]);

let checkedNavs = 0;
shellSources.forEach(([rel, source]) => {
  let match;
  NAV_RE.lastIndex = 0;
  while ((match = NAV_RE.exec(source))) {
    const target = match[1];
    /* "/" is the root shell and legitimately resolves to /index.html. */
    if (target === "/") continue;
    checkedNavs += 1;
    assert.strictEqual(
      iosRoute(target), target,
      rel + ' navigates to "' + target + '", which both Capacitor routers collapse to /index.html. '
        + "Name the file explicitly (e.g. /app/index.html)."
    );
  }
});
assert.ok(checkedNavs > 0, "expected at least one shell navigation to check");

/* The picker's handoff specifically - the one that broke. */
assert.ok(
  /location\.href\s*=\s*"\/app\/index\.html\?"/.test(pickerJs),
  "the course picker must hand off to /app/index.html, not /app/"
);

/* ---------------------------------------------------------------------------
 * 2. Origin: the bootstrap owns the /api rewrite, so it must run first.
 * ------------------------------------------------------------------------- */
const scriptSrcs = [...appHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
assert.ok(scriptSrcs.length > 0, "app/index.html should load scripts");
assert.ok(
  /gd-native-bootstrap\.js/.test(scriptSrcs[0]),
  "gd-native-bootstrap.js must be the FIRST script in app/index.html - it patches fetch, "
    + "and every /api call on this surface is relative. Found: " + scriptSrcs[0]
);

/* Every /api path on this surface is relative, which is what the web build
   needs and what makes the bootstrap load-bearing natively. */
const appJsDir = path.join(ROOT, "app", "js");
const appModules = fs.readdirSync(appJsDir).filter((f) => f.endsWith(".js"));
let relativeApiCalls = 0;
appModules.forEach((file) => {
  const source = fs.readFileSync(path.join(appJsDir, file), "utf8");
  [...source.matchAll(/["'](\/api\/[a-z0-9-]+)/gi)].forEach(() => { relativeApiCalls += 1; });
});
assert.ok(relativeApiCalls >= 5, "expected the /app/ modules to call /api relatively, found " + relativeApiCalls);

/* ---------------------------------------------------------------------------
 * 3. The rest of the native layer is present - and the one piece that must NOT
 *    be, because it would actively break this surface.
 * ------------------------------------------------------------------------- */
const loaded = scriptSrcs.join("\n");
["gd-durable-storage.js", "clarity-error-reporter.js", "gd-native-deep-links.js"].forEach((name) => {
  assert.ok(loaded.includes(name), "app/index.html must load " + name);
});

/* gd-native-back-button.js resolves the current route through GDShell, which
   does not exist on this page - so it would read every state as root and call
   exitApp(), dropping the round on the first Back press. boot.js wires Back to
   this page's own exitBack instead. */
assert.ok(
  !loaded.includes("gd-native-back-button.js"),
  "app/index.html must NOT load gd-native-back-button.js - it depends on GDShell, which this surface has no notion of"
);
assert.ok(
  /addListener\("backButton"/.test(bootJs) && /exitBack\(\)/.test(bootJs),
  "boot.js must wire Android's hardware Back to this page's own exitBack"
);

/* ---------------------------------------------------------------------------
 * 4. Durable storage covers this surface's key space.
 *
 * A WebView evicts web storage under pressure. Anything user-entered and
 * unrecoverable has to be mirrored, or a round dies on the 14th hole.
 * ------------------------------------------------------------------------- */
const durableList = (durableJs.match(/var DURABLE_KEYS = \[([\s\S]*?)\];/) || [])[1] || "";
const durableKeys = [...durableList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
assert.ok(durableKeys.length >= 8, "DURABLE_KEYS looks truncated: " + durableKeys.length);

/* Documented exclusions, each for a stated reason - not an ignore list to grow
   silently. Re-fetchable or cosmetic only. */
const EXCLUDED = {
  "clarity:course-library:v1": "large, and re-pulls from the server per course",
  "clarity:shot-card-boxes:v1": "cosmetic box positions"
};

const declaredKeys = new Set();
appModules.forEach((file) => {
  const source = fs.readFileSync(path.join(appJsDir, file), "utf8");
  [...source.matchAll(/(?:STORE_KEY|STORAGE_KEY|FIRMNESS_KEY|GD_BAG_FIRMNESS_KEY)\s*=\s*"([^"]+)"/g)]
    .forEach((m) => declaredKeys.add(m[1]));
});
assert.ok(declaredKeys.size >= 5, "expected several storage keys in app/js, found " + declaredKeys.size);

declaredKeys.forEach((key) => {
  if (EXCLUDED[key]) return;
  assert.ok(
    durableKeys.includes(key),
    'app/js declares storage key "' + key + '" but gd-durable-storage.js does not mirror it. '
      + "Add it to DURABLE_KEYS, or to this test's EXCLUDED map with the reason it is safe to lose."
  );
});

/* Keys read at module load cannot be seen by a restore that lands afterwards,
   so those - and only those - also need the reload. */
const reloadList = (durableJs.match(/var RELOAD_REQUIRED_KEYS = \[([\s\S]*?)\];/) || [])[1] || "";
const reloadKeys = [...reloadList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
appModules.forEach((file) => {
  const source = fs.readFileSync(path.join(appJsDir, file), "utf8");
  const readsAtLoad = /^\s{2}var \w+ = (?:load|read)\(\);/m.test(source);
  if (!readsAtLoad) return;
  const key = (source.match(/STORE_KEY\s*=\s*"([^"]+)"/) || [])[1];
  if (!key || EXCLUDED[key]) return;
  assert.ok(
    reloadKeys.includes(key),
    "app/js/" + file + ' takes "' + key + '" at module load, so a durable restore is invisible '
      + "until the page runs again - it belongs in RELOAD_REQUIRED_KEYS."
  );
});

/* ---------------------------------------------------------------------------
 * 5. Universal links: both halves, or neither works and neither reports why.
 * ------------------------------------------------------------------------- */
const pbxproj = read("ios/App/App.xcodeproj/project.pbxproj");
const teamId = (pbxproj.match(/DEVELOPMENT_TEAM = ([A-Z0-9]+);/) || [])[1];
const bundleId = (pbxproj.match(/PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);/) || [])[1];
assert.ok(teamId && bundleId, "could not read team/bundle id from project.pbxproj");

const entitlements = read("ios/App/App/App.entitlements");
assert.ok(
  /applinks:caddy\.claritygolf\.app/.test(entitlements),
  "App.entitlements must declare applinks:caddy.claritygolf.app"
);

/* The project wiring is deliberately NOT asserted, because it is deliberately
   not switched on. Pointing the target at App.entitlements makes the build
   require a provisioning profile that grants Associated Domains, and the cached
   App Store profile predates the capability - so turning it on today fails the
   export with "No signing certificate iOS Distribution found" and blocks the
   release build for a P2 feature. Enabling the capability on the App ID and
   regenerating the profile needs an Apple ID signed into Xcode.

   So this asserts the two halves that CAN be true today (a correct entitlements
   file, a correct and correctly-served association file), and becomes strict the
   moment the wiring lands - at which point the two must agree or links break. */
if (/CODE_SIGN_ENTITLEMENTS/.test(pbxproj)) {
  assert.ok(
    /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/.test(pbxproj),
    "CODE_SIGN_ENTITLEMENTS must point at App/App.entitlements"
  );
}

const aasa = JSON.parse(read(".well-known/apple-app-site-association"));
const appIDs = aasa.applinks.details.flatMap((d) => d.appIDs || []);
assert.ok(
  appIDs.includes(teamId + "." + bundleId),
  "apple-app-site-association must list " + teamId + "." + bundleId + ", found " + JSON.stringify(appIDs)
);

/* Android's half already worked; keep the two in step so one cannot rot alone. */
const assetlinks = JSON.parse(read(".well-known/assetlinks.json"));
assert.strictEqual(
  assetlinks[0].target.package_name, bundleId,
  "assetlinks.json package_name must match the iOS bundle id"
);

/* The file has no extension, so nothing infers its type - Apple requires
   application/json and silently declines to verify otherwise. */
const netlifyToml = read("netlify.toml");
assert.ok(
  /apple-app-site-association[\s\S]{0,200}Content-Type = "application\/json"/.test(netlifyToml),
  "netlify.toml must serve apple-app-site-association as application/json"
);

/* ---------------------------------------------------------------------------
 * 6. Paid access. This gate existed, was deleted with the old play system, and
 *    its absence is a revenue leak rather than a crash - so nothing else will
 *    ever tell us it went missing again.
 * ------------------------------------------------------------------------- */
assert.ok(
  /gps_round_start/.test(pickerJs) && /ClarityPermissions/.test(pickerJs),
  "the picker must check ClarityPermissions for gps_round_start before entering a round"
);
/* The gate has to wrap the navigation, not sit beside it: inside enterGpsPlay,
   the only unconditional navigateToAppPlay call is the documented resume bypass.
   Anything else means a free round. */
const enterBody = (pickerJs.match(/function enterGpsPlay\([\s\S]*?\n  \}/) || [])[0] || "";
assert.ok(enterBody, "could not locate enterGpsPlay");
assert.ok(
  /gpsStartPermission\(\)\.then/.test(enterBody),
  "enterGpsPlay must resolve the gps_round_start permission before navigating"
);
assert.ok(
  /fromResume|fromBack|preserveState/.test(enterBody),
  "enterGpsPlay must keep the resume bypass, so a lapsed player is not locked out of the round they are standing in"
);

console.log(
  "app native contract passed: " + checkedNavs + " navigations router-checked, "
    + scriptSrcs.length + " scripts ordered, " + durableKeys.length + " durable keys ("
    + declaredKeys.size + " app keys covered), universal links both halves, gps_round_start gated"
);
