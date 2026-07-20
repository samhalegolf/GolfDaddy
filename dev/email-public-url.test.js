/* URLs that leave the app must point at the public site, not https://localhost.
 *
 * In the native shell the page loads from https://localhost. Any link built from
 * location.origin - email bodies, the coach-invite QR - was a dead
 * https://localhost/ URL to the recipient, and the email logo was broken.
 * GDNative.apiOrigin holds the real domain in-app; on web location.origin is
 * already right. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EMAIL = path.join(ROOT, "scripts", "clarity-email.js");
const SHELL = path.join(ROOT, "scripts", "inline", "gd-auth-account-shell.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Run the real email URL builders under a simulated native origin. */
function loadEmailBuilders(nativeApiOrigin, pageOrigin) {
  const src = fs.readFileSync(EMAIL, "utf8");
  function grab(sig) {
    const i = src.indexOf(sig);
    assert.notStrictEqual(i, -1, "missing " + sig);
    const end = src.indexOf("\n  }", i);
    return src.slice(i, end + 4);
  }
  const code = grab("function publicBase()") + "\n" + grab("function logoUrl()") + "\n"
    + grab("function appUrl()") + "\n" + grab("function passwordResetUrl(emailValue)");
  const win = { GDNative: nativeApiOrigin ? { apiOrigin: nativeApiOrigin } : null };
  const location = { origin: pageOrigin, pathname: "/index.html" };
  // eslint-disable-next-line no-new-func
  return new Function("window", "location", "URL",
    code + "\nreturn { logoUrl: logoUrl, appUrl: appUrl, passwordResetUrl: passwordResetUrl, publicBase: publicBase };"
  )(win, location, URL);
}

test("in-app, email links use the public domain, not localhost", () => {
  const b = loadEmailBuilders("https://caddy.claritygolf.app", "https://localhost");
  assert.ok(b.appUrl().startsWith("https://caddy.claritygolf.app/"), "app URL: " + b.appUrl());
  assert.ok(b.logoUrl().startsWith("https://caddy.claritygolf.app/assets/"), "logo: " + b.logoUrl());
  assert.ok(!/localhost/.test(b.appUrl() + b.logoUrl()), "no localhost may reach a recipient");
});

test("in-app, the password reset link points at the public domain", () => {
  const b = loadEmailBuilders("https://caddy.claritygolf.app", "https://localhost");
  const url = b.passwordResetUrl("player@example.com");
  assert.ok(url.startsWith("https://caddy.claritygolf.app/"), "reset URL: " + url);
  assert.ok(/claritySetPassword=1/.test(url), "must still carry the reset parameter");
  assert.ok(!/localhost/.test(url), "a reset link to localhost is a dead link");
});

test("on web, links use the real page origin unchanged", () => {
  const b = loadEmailBuilders(null, "https://caddy.claritygolf.app");
  assert.strictEqual(b.appUrl(), "https://caddy.claritygolf.app/");
  assert.ok(b.logoUrl().startsWith("https://caddy.claritygolf.app/assets/"));
});

test("the pathname is never leaked into a public link", () => {
  const b = loadEmailBuilders("https://caddy.claritygolf.app", "https://localhost");
  assert.ok(!/index\.html/.test(b.appUrl() + b.logoUrl()), "the bundled local path must not appear in a public URL");
});

test("the coach-invite QR encodes the public domain", () => {
  const shell = fs.readFileSync(SHELL, "utf8");
  const idx = shell.indexOf("clarityCoachInvite', code");
  const region = shell.slice(idx - 500, idx + 100);
  assert.ok(/GDNative.*apiOrigin/.test(region), "the QR must derive its origin from GDNative.apiOrigin in-app");
  assert.ok(!/location\.origin \+ location\.pathname/.test(region), "must not build the QR from the local page origin");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("email-public-url failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("email-public-url passed: " + tests.length + " checks");
})();
