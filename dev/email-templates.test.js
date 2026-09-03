/* Outbound email: one template source, one comp writer, and one email per event.
 *
 * Three things in here are contracts rather than layout:
 *
 * 1. ONE template source. The layout and the wording used to exist three times over
 *    (functions/email-notification.js, functions/admin-user-invite.js, scripts/clarity-email.js),
 *    which is how a brand or footer change lands in two emails out of three. Every sender now
 *    renders from scripts/gd-email-templates-core.js, and this test fails if a function grows
 *    its own <table> layout again.
 *
 * 2. ONE email when an account is created WITH a comped month. The whole point of the tick on
 *    Create Player Account is that the player is not sent a setup email and a gift email a
 *    second apart, describing one event. account_created_comped must therefore mention both
 *    the password step and the comp, and the invite endpoint must send exactly one message.
 *
 * 3. Comping is admin-only and cannot silently fail. A coach may create a player; only an
 *    admin may hand out paid-for access, and if the entitlement write fails the account must
 *    still be reported as created while the comp is reported as NOT issued - the failure mode
 *    that matters is an admin believing they gave someone a month they did not.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const core = require(path.join(ROOT, "scripts", "gd-email-templates-core.js"));

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function read(...parts) { return fs.readFileSync(path.join(ROOT, ...parts), "utf8"); }

test("every catalogue entry is complete enough to audit", () => {
  const entries = core.catalogue();
  assert.ok(entries.length >= 6, "the catalogue lost entries");
  const seen = new Set();
  entries.forEach((entry) => {
    ["id", "eventType", "label", "recipient", "trigger", "gating", "sender", "cta"].forEach((field) => {
      assert.ok(entry[field] && String(entry[field]).trim(), entry.id + " is missing " + field);
    });
    assert.ok(["service", "activity"].includes(entry.category), entry.id + " has an unknown category");
    assert.ok(!seen.has(entry.id), "duplicate catalogue id: " + entry.id);
    seen.add(entry.id);
    /* The page names the owning file; a stale pointer is worse than none. */
    entry.sender.split("→").forEach((chunk) => {
      const file = chunk.trim();
      if (!/^(functions|scripts)\//.test(file)) return;
      assert.ok(fs.existsSync(path.join(ROOT, file)), entry.id + " points at a missing file: " + file);
    });
  });
});

test("every catalogue entry renders a subject, HTML and a plain-text part", () => {
  core.catalogue().forEach((entry) => {
    const built = core.build(entry.eventType, Object.assign({ to: "player@example.com" }, entry.sample || {}));
    assert.ok(built.subject && built.subject.length > 4, entry.id + " rendered no subject");
    assert.ok(/^<!doctype html>/i.test(built.html), entry.id + " did not render a full HTML document");
    assert.ok(built.text.includes(built.message.title), entry.id + " plain-text part is missing the title");
    assert.ok(built.html.includes("Clarity Golf Systems"), entry.id + " lost the brand header");
  });
});

test("a service email footers as account access, an activity email as a preference", () => {
  const service = core.build("account_created", { to: "a@b.com", ctaUrl: "https://example.test/x" });
  const activity = core.build("account_activity", { to: "a@b.com", title: "Sam updated your bag" });
  assert.ok(/relates to your Clarity account access/.test(service.html), "service footer changed");
  assert.ok(/Settings &gt; Notifications/.test(activity.html), "activity footer changed");
  assert.strictEqual(core.isServiceEventType("account_created_comped"), true, "the comped setup email must send unconditionally");
  assert.strictEqual(core.isServiceEventType("account_activity"), false, "activity email must stay opt-in");
});

test("the comped setup email covers BOTH the password step and the comp", () => {
  const built = core.build("account_created_comped", {
    to: "player@example.com",
    recipientName: "Alex Fenwick",
    actorName: "Sam Hale",
    periodLabel: "a month",
    expiresLabel: "3 October 2026",
    membership: true,
    ctaUrl: "https://example.test/set-password"
  });
  assert.ok(/a month/.test(built.subject), "the subject does not mention the comp");
  assert.ok(/password/i.test(built.message.detail), "the body never tells them to set a password");
  assert.ok(/a month/.test(built.message.detail), "the body never mentions the comped period");
  assert.ok(/3 October 2026/.test(built.message.detail), "the body never states when the access ends");
  assert.ok(/no card|won't auto-renew|does not renew/i.test(built.message.detail),
    "the body must say it does not renew - a comp that reads like a subscription generates support");
  assert.ok(built.html.includes("https://example.test/set-password"), "the CTA is not the set-password link");
});

test("no sender carries its own copy of the email layout", () => {
  ["functions/email-notification.js", "functions/admin-user-invite.js"].forEach((file) => {
    const src = read(file);
    assert.ok(/gd-email-templates-core/.test(src), file + " does not render from the shared template core");
    assert.ok(!/<!doctype html>/i.test(src), file + " has grown its own email layout again");
  });
  /* The client had a fourth copy, used only to attach an html/text pair to the request that
     /api/email-notification has always ignored - a brand nobody received, drifting from the
     three that were sent. It must not come back. */
  const client = read("scripts", "clarity-email.js");
  assert.ok(!/<!doctype html>/i.test(client), "scripts/clarity-email.js is building email HTML again");
  assert.ok(!/html:template\(/.test(client), "scripts/clarity-email.js is sending a body the server discards");
  /* And the shared core has to be pinned into the functions bundle, or the require dies in
     production while every local test passes. */
  assert.ok(/scripts\/gd-email-templates-core\.js/.test(read("netlify.toml")),
    "netlify.toml does not pin the email core into the functions bundle");
});

test("the invite endpoint sends exactly one email, comped or not", () => {
  const src = read("functions", "admin-user-invite.js");
  const sends = src.match(/await sendEmail\(/g) || [];
  assert.strictEqual(sends.length, 1, "the invite endpoint should send one email, found " + sends.length);
  assert.ok(/sendEmail\(accountEmail, name, actorName, link, comped\)/.test(src),
    "the single send does not carry the comp, so a comped account would get the plain setup email");
  assert.ok(src.indexOf("writeCompedEntitlement") < src.indexOf("await sendEmail("),
    "the entitlement must be written BEFORE the email, or the email cannot state a real expiry");
});

test("comping on account creation is admin-only and reported honestly", () => {
  const src = read("functions", "admin-user-invite.js");
  assert.ok(/compRequested && !caller\.isAdmin/.test(src), "a coach can request a comp");
  assert.ok(/comp_admin_only/.test(src), "the refusal is not distinguishable by the client");
  assert.ok(/compError/.test(src), "a failed comp is not reported back");

  const client = read("scripts", "inline", "gd-auth-account-shell.js");
  assert.ok(/gd67CoachPlayerComp/.test(client), "the tick box is gone from Create Player Account");
  assert.ok(/String\(\(account && account\.role\) \|\| 'player'\) !== 'admin'/.test(client),
    "the tick box is no longer hidden from coaches");
  assert.ok(/comped month was NOT issued/.test(client),
    "the form no longer tells the admin when only the account was created");
});

test("both comp routes write the same entitlement shape", () => {
  const utils = read("functions", "payment-utils.js");
  assert.ok(/function writeCompedEntitlement/.test(utils), "the shared comp writer is gone");
  ["source_type", "entitlement_reason", "referral_eligible", "non_renewing"].forEach((column) => {
    assert.ok(new RegExp(column).test(utils), "writeCompedEntitlement no longer sets " + column);
  });
  const admin = read("functions", "payment-admin.js");
  assert.ok(/writeCompedEntitlement\(/.test(admin), "Commerce's Issue comped access no longer uses the shared writer");
  const invite = read("functions", "admin-user-invite.js");
  assert.ok(/writeCompedEntitlement\(/.test(invite), "the account-creation comp no longer uses the shared writer");
});

test("the Studio Communications page reads the catalogue rather than restating it", () => {
  const page = read("scripts", "studio", "communications", "communications-page.js");
  assert.ok(/GDEmailTemplatesCore/.test(page), "the page does not read the shared core");
  assert.ok(/api\.catalogue\(\)/.test(page), "the page does not render the catalogue");
  assert.ok(/sandbox/.test(page), "the preview iframe is not sandboxed");
  assert.ok(!/RESEND_API_KEY['"]\s*\]/.test(page), "the page must never handle secret values");

  const html = read("index.html");
  assert.ok(/scripts\/gd-email-templates-core\.js/.test(html), "index.html does not load the email core");
  assert.ok(/scripts\/studio\/communications\/communications-page\.js/.test(html), "index.html does not load the page");

  /* Read the record out of the loaded registry rather than by slicing source text: a
     fixed-width slice silently stops covering the fields it is checking the moment the record
     grows, and passes for the wrong reason. */
  const vm = require("vm");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read("scripts", "studio", "studio-registry.js"), sandbox, { filename: "studio-registry.js" });
  const record = sandbox.window.GDStudioRegistry.get("communications");
  assert.ok(record, "the communications record is gone from the registry");
  assert.strictEqual(record.status, "implemented", "the registry still calls Communications a placeholder");
  assert.strictEqual(record.needsVerification, false, "the registry still flags Communications as unverified");
  assert.ok(record.code.some((c) => c.path === "scripts/gd-email-templates-core.js"),
    "the registry does not point at the shared template core");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("email-templates failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("email-templates passed: " + tests.length + " checks");
})();
