/* scripts/inline/gd-landing-redirect-v1.js: the web app's second gate. A browser that holds
   the Studio access cookie passes the edge gate, so this is what keeps a signed-out browser
   on the landing page instead of in guest mode. /studio is the only way to sign in on the
   web, so there is no query-string way past it. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "scripts", "inline", "gd-landing-redirect-v1.js"), "utf8");
const INDEX = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function run({ hostname = "caddy.claritygolf.app", protocol = "https:", search = "", hash = "", storage = {}, native = false } = {}) {
  const replaced = [];
  const localStorage = { getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null) };
  const window = {
    location: { hostname, protocol, search, hash, replace: (to) => replaced.push(to) },
    localStorage,
    GDNative: { isNative: native }
  };
  window.window = window;
  vm.runInNewContext(SCRIPT, { window, localStorage, URLSearchParams, JSON, String });
  return replaced;
}

const SIGNED_IN = { "clarity:supabase-auth-session:v1": '{"access_token":"x"}' };
const ACCOUNT = { gd_accounts_v1: '{"activeId":"acc1"}' };

assert.deepStrictEqual(run(), ["/welcome.html"], "a signed-out browser goes to the landing");
assert.deepStrictEqual(run({ search: "?login=1" }), ["/welcome.html"], "no query string is a way in");
assert.deepStrictEqual(run({ search: "?demo=practice-bubble" }), ["/welcome.html"], "the demo route is not a way in");
assert.deepStrictEqual(run({ hash: "#access_token=abc&type=recovery" }), ["/welcome.html"], "an auth link in a browser lands on the landing, as the edge gate does");
assert.deepStrictEqual(run({ storage: SIGNED_IN }), [], "a Supabase session stays in the app");
assert.deepStrictEqual(run({ storage: ACCOUNT }), [], "an active account stays in the app");
assert.deepStrictEqual(run({ storage: { ...ACCOUNT, gd_account_signed_out_v1: "1" } }), ["/welcome.html"], "signing out beats a retained account store");
assert.deepStrictEqual(run({ native: true }), [], "the native apps have their own landing");
assert.deepStrictEqual(run({ hostname: "localhost" }), [], "localhost is open, like the edge gate");
assert.deepStrictEqual(run({ hostname: "127.0.0.1" }), [], "127.0.0.1 is open, like the edge gate");
assert.deepStrictEqual(run({ protocol: "file:", hostname: "" }), [], "file: is the bundled app");

/* Studio is built from the same index.html and signs in through its own door, so the script
   must be stripped from the Studio surface - the reason an earlier copy was deleted. */
const tag = INDEX.match(/<script[^>]*gd-landing-redirect-v1\.js[^>]*>/);
assert.ok(tag, "index.html loads the landing redirect");
assert.ok(/data-gd-surface="app"/.test(tag[0]), "the landing redirect is app-surface only");
const scripts = [...INDEX.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
const at = scripts.findIndex((s) => s.includes("gd-landing-redirect-v1.js"));
const bootstrap = scripts.findIndex((s) => s.includes("gd-native-bootstrap.js"));
assert.ok(bootstrap >= 0 && at > bootstrap, "runs after the native bootstrap, which sets GDNative");
assert.ok(at < 8, "runs before the shell paints (near the top of index.html)");

console.log("landing-redirect.test.js passed");
