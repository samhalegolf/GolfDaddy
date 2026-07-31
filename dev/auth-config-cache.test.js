/*
 * The public auth config must not sit on the network critical path.
 *
 * It is a Supabase URL, an anon key and a basemaps key - public, per-deploy and
 * effectively static. It was fetched fresh on every call with cache:"no-store",
 * so every token refresh needed a round-trip, and on a golf course that produced
 * two separate visible faults from one dropped request:
 *
 *   - doRefreshSession() returns no token when this throws, so
 *     /api/payment-entitlement answered 401 and clarity-payments read that as
 *     "no access". clarity-session derives accountRole from payment state, so the
 *     flip fired clarity:session-changed and its full listener cascade.
 *   - gdLinzBasemapsKey never got published, so gd-app-core rejects any imagery
 *     source with requiresKey==="linzKey" and the map falls back to street tiles.
 *
 * Both are silent and only reproduce with a flaky connection, so the properties
 * that prevent them are pinned here.
 *
 * Run: node dev/auth-config-cache.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const authSource = fs.readFileSync(path.join(ROOT, "scripts", "clarity-supabase-auth.js"), "utf8");
const coreSource = fs.readFileSync(path.join(ROOT, "scripts", "gd-app-core.js"), "utf8");

function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const auth = stripComments(authSource);

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("the config fetch is no longer forced past every cache", () => {
  assert.ok(
    !/auth-public-config[^)]*no-store/.test(auth),
    'the config is still fetched with cache:"no-store" — every token refresh pays a round-trip'
  );
});

test("the config is cached in memory and on disk", () => {
  assert.ok(/authConfigMemo/.test(auth), "no in-memory memo for the auth config");
  assert.ok(
    /saveJson\(AUTH_CONFIG_KEY/.test(auth),
    "the config is never written to storage, so a cold start still depends on the network"
  );
  assert.ok(
    /loadJson\(AUTH_CONFIG_KEY/.test(auth),
    "the config is never read back from storage"
  );
});

test("a cached config is returned without awaiting the network", () => {
  const fn = /async function publicAuthConfig\(\)[\s\S]*?\n  \}/.exec(auth);
  assert.ok(fn, "publicAuthConfig() not found");
  const body = fn[0];
  const cachedReturn = /if \(usableAuthConfig\(authConfigMemo\)\)[\s\S]*?return authConfigMemo;/.exec(body);
  assert.ok(cachedReturn, "there is no early return for a cached config");
  assert.ok(
    !/await fetchAuthConfig\(\)/.test(cachedReturn[0]),
    "the cached path still awaits the network — the round-trip is back on the critical path"
  );
});

test("only a complete config is ever cached", () => {
  assert.ok(
    /function usableAuthConfig\([\s\S]{0,160}supabaseUrl[\s\S]{0,80}supabaseAnonKey/.test(auth),
    "usableAuthConfig does not require both the URL and the anon key"
  );
  const fetcher = /async function fetchAuthConfig\(\)[\s\S]*?\n  \}/.exec(auth);
  assert.ok(fetcher, "fetchAuthConfig() not found");
  assert.ok(
    /if \(!response\.ok \|\| !usableAuthConfig\(body\)\) throw/.test(fetcher[0]),
    "an incomplete response can be cached, poisoning the cache with something no caller can use"
  );
  const throwAt = fetcher[0].indexOf("throw");
  const saveAt = fetcher[0].indexOf("saveJson(AUTH_CONFIG_KEY");
  assert.ok(throwAt !== -1 && saveAt > throwAt, "the config is saved before it is validated");
});

test("the map imagery key is published from the cached config too", () => {
  /* The whole point of caching for the map: a cache hit has to publish the key,
     or the imagery source stays rejected even though the key is known. */
  assert.ok(
    /publishAuthConfigExtras\(authConfigMemo\)/.test(auth),
    "a cache hit does not publish gdLinzBasemapsKey — the map would still fall back to street tiles"
  );
  assert.ok(
    /requiresKey==="linzKey"&&!window\.gdLinzBasemapsKey/.test(coreSource.replace(/\s+/g, "")) ||
      /requiresKey === "linzKey"/.test(coreSource),
    "gd-app-core no longer gates imagery on gdLinzBasemapsKey — this test's premise has moved"
  );
});

test("a background refresh cannot throw into callers", () => {
  const fn = /async function publicAuthConfig\(\)[\s\S]*?\n  \}/.exec(auth)[0];
  assert.ok(
    /fetchAuthConfig\(\)\s*\.catch\(/.test(fn),
    "the background refresh has no catch — a rejected promise would surface as an unhandled rejection"
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
console.log("auth-config-cache passed: " + tests.length + " checks");
