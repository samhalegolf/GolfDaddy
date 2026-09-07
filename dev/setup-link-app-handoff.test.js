/* The password link, and the handoff between the email, the browser and the app.
 *
 * The contract this file defends:
 *
 * 1. The link in the email is on OUR domain. Universal Links and App Links only fire for the
 *    URL the user TAPPED - never for a server-side redirect - so while the email carried
 *    Supabase's action_link (<project>.supabase.co/auth/v1/verify -> 302 -> us) a player with
 *    Clarity installed still landed in a browser, and the applinks entitlement, the autoVerify
 *    intent-filter and both .well-known files sat there doing nothing.
 *
 * 2. It still works when Supabase does not give us a hashed token. The fallback to action_link
 *    is the difference between "back to the old browser-first behaviour" and "an invite email
 *    nobody can act on".
 *
 * 3. Every layer between the tap and the password form carries token_hash. A link that opens
 *    the app and then drops the token looks exactly like a broken link.
 *
 * 4. A spent token is stripped from the URL, or a refresh replays it and shows "expired" to
 *    someone who just succeeded.
 *
 * 5. No email link can install an app, so a brand-new player always finishes in a browser.
 *    The download prompt is what closes that gap - once, on the web only.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { buildSetupLink } = require(path.join(ROOT, "functions", "lib", "gd-setup-link.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function read(...p) { return fs.readFileSync(path.join(ROOT, ...p), "utf8"); }

const SITE = "https://caddy.claritygolf.app";
const GENERATED = {
  action_link: "https://zcevluithwoumvafhmct.supabase.co/auth/v1/verify?token=raw&type=recovery&redirect_to=" + SITE,
  hashed_token: "pkce_2f8c",
  verification_type: "recovery"
};

test("the setup link is on our own domain, so the tap can reach the app", () => {
  const built = buildSetupLink(GENERATED, SITE, { claritySetPassword: 1, clarityAccountSetup: 1 });
  assert.strictEqual(built.firstParty, true, "the link is not first-party");
  const url = new URL(built.link);
  assert.strictEqual(url.origin, SITE, "the link left our domain, so no App Link can fire");
  assert.strictEqual(url.searchParams.get("token_hash"), "pkce_2f8c", "the one-time token is missing");
  assert.strictEqual(url.searchParams.get("type"), "recovery", "verifyOtp cannot run without the type");
  assert.strictEqual(url.searchParams.get("claritySetPassword"), "1", "the shell will not open the password form");
  assert.strictEqual(url.searchParams.get("clarityAccountSetup"), "1", "a first-time setup will read as a reset");
  /* The raw token must never travel - only the hashed one Supabase expects at /verify. */
  assert.ok(!built.link.includes("token=raw"), "the raw token leaked into the link");

  /* The host has to be one both platforms actually verify. */
  const aasa = JSON.parse(read(".well-known", "apple-app-site-association"));
  assert.ok(read("ios", "App", "App", "App.entitlements").includes("applinks:" + url.host),
    "iOS does not claim the host the link is on");
  assert.ok(JSON.stringify(aasa).includes("com.claritygolf.caddy"), "the AASA lost the bundle id");
  assert.ok(read("android", "app", "src", "main", "AndroidManifest.xml").includes('android:host="' + url.host + '"'),
    "Android does not claim the host the link is on");
});

test("a reset is not a first-time setup", () => {
  const built = buildSetupLink(GENERATED, SITE, { claritySetPassword: 1 });
  assert.ok(!new URL(built.link).searchParams.has("clarityAccountSetup"),
    "a password reset would say 'Set up account'");
});

test("it falls back to Supabase's own link rather than sending a dead one", () => {
  const noHash = buildSetupLink({ action_link: GENERATED.action_link }, SITE, { claritySetPassword: 1 });
  assert.strictEqual(noHash.firstParty, false);
  assert.strictEqual(noHash.link, GENERATED.action_link, "the fallback is not the action link");
  const noSite = buildSetupLink(GENERATED, "", { claritySetPassword: 1 });
  assert.strictEqual(noSite.link, GENERATED.action_link, "no site URL should still produce a usable link");
  /* generate_link has returned these fields both at the top level and under `properties`. */
  const nested = buildSetupLink({ properties: GENERATED }, SITE, { claritySetPassword: 1 });
  assert.strictEqual(nested.firstParty, true, "a nested properties payload is not read");
});

test("every sender builds the link the same way", () => {
  ["admin-user-invite.js", "email-notification.js", "caddy-admin-welcome-email.js", "auth-reset-password.js"]
    .forEach((file) => {
      const src = read("functions", file);
      assert.ok(/buildSetupLink\(/.test(src), file + " does not use the shared link builder");
      /* Reading action_link directly is the old behaviour creeping back. */
      assert.ok(!/\.action_link\b/.test(src.replace(/require\([^)]*\)/g, "")),
        file + " still reads action_link directly instead of preferring our own domain");
    });
});

test("token_hash survives every layer between the tap and the password form", () => {
  assert.ok(/"token_hash"/.test(read("scripts", "inline", "gd-native-deep-links.js")),
    "the native deep-link handler drops the token, so the app opens and does nothing");
  assert.ok(/params\.has\("token_hash"\)/.test(read("scripts", "inline", "gd-auth-reset-route-bootstrap.js")),
    "the pre-paint bootstrap does not treat a token_hash link as a reset route");
  assert.ok(/"token_hash"/.test(read("scripts", "inline", "gd-landing-redirect-v1.js")),
    "a setup link would be redirected to the landing page");
  const shell = read("scripts", "inline", "gd-auth-account-shell.js");
  assert.ok(/params\.has\('token_hash'\)/.test(shell), "the shell does not recognise a token_hash route");
  assert.ok(/url\.searchParams\.delete\('token_hash'\)/.test(shell),
    "a spent token stays in the URL, so a refresh replays it and reports 'expired'");
});

test("the client exchanges token_hash for a session before showing the form", () => {
  const auth = read("scripts", "clarity-supabase-auth.js");
  assert.ok(/\/auth\/v1\/verify/.test(auth), "there is no verifyOtp exchange");
  assert.ok(/token_hash: tokenHash/.test(auth), "the exchange does not send the token");
  assert.ok(/exchangeTokenHash/.test(auth), "the exchange helper is gone");
  /* Nothing is verified until the exchange returns, so the form must not be usable first. */
  assert.ok(/button\.disabled = true;[\s\S]{0,120}Checking your link/.test(auth),
    "the password form is live before the link has been verified");
  assert.ok(/clearRecoveryUrl\(\)/.test(auth), "the consumed token is not stripped from the URL");
});

test("the download prompt shows once, on the web only, from the canonical store URLs", () => {
  const prompt = read("scripts", "gd-app-download-prompt.js");
  assert.ok(/isNative\(\)/.test(prompt), "the prompt would appear inside the native app");
  assert.ok(/localStorage/.test(prompt) && /SEEN_KEY/.test(prompt), "the prompt has no once-per-device guard");
  assert.ok(/CLARITY_CADDY_APP_STORE_URL/.test(prompt) && /CLARITY_CADDY_PLAY_STORE_URL/.test(prompt),
    "the prompt hard-codes store URLs instead of reading the canonical source");
  assert.ok(/return new Promise/.test(prompt), "the prompt cannot be awaited, so a reload can race it");

  ["app-store-badge.png", "google-play-badge.png"].forEach((file) => {
    assert.ok(fs.existsSync(path.join(ROOT, "assets", "brand", file)), "missing badge asset: " + file);
    assert.ok(prompt.includes("/assets/brand/" + file), "the prompt does not use " + file);
  });

  /* Shown where the player actually finishes setup - both success paths. */
  assert.ok(/GDAppDownloadPrompt/.test(read("scripts", "clarity-supabase-auth.js")),
    "the setup overlay never offers the app");
  const shell = read("scripts", "inline", "gd-auth-account-shell.js");
  assert.ok(/GDAppDownloadPrompt/.test(shell), "the in-shell setup never offers the app");
  assert.ok(/if \(setupRoute\) \{[\s\S]{0,200}GDAppDownloadPrompt/.test(shell),
    "a plain password reset is being nagged to download the app");

  const html = read("index.html");
  assert.ok(/scripts\/gd-app-download-prompt\.js/.test(html), "index.html does not load the prompt");
  assert.ok(/clarity-caddy-app-store\.js/.test(html), "index.html does not load the store URLs");
});

test("the landing page links both stores, and to files that actually deploy", () => {
  const welcome = read("welcome.html");
  assert.ok(/data-caddy-play-store-link/.test(welcome), "the landing page offers only one store");
  assert.ok(/CLARITY_CADDY_PLAY_STORE_URL/.test(welcome), "the Play badge is never given a URL");
  /* This is the bug that made the badge a 404 on the live site: the SVG lives at the repo root,
     which clarity-deploy-build.js does not copy. assets/ does. */
  assert.ok(!/download-on-the-app-store-apple-logo\.svg/.test(welcome),
    "the landing page references a file that is not in the deploy list");
  const deploy = read("scripts", "clarity-deploy-build.js");
  ["assets", "scripts"].forEach((dir) => {
    assert.ok(new RegExp('"' + dir + '"').test(deploy), "the deploy build no longer copies " + dir);
  });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("setup-link-app-handoff failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("setup-link-app-handoff passed: " + tests.length + " checks");
})();
