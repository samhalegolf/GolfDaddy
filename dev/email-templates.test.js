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
 * 2. ONE email when an account is created WITH a comped month, and it is the COMPED one. The
 *    whole point of the tick on Create Player Account is that the player is not sent a setup
 *    email and a gift email a second apart, describing one event. The comped welcome template
 *    must therefore mention both the password step and the comp, the invite endpoint must send
 *    exactly one message, and it must only send the comped template once the entitlement has
 *    actually been written - an email promising access to someone who holds none is the worst
 *    failure available here.
 *
 * 2b. TWO independent templates, edited in Studio, with code-level defaults underneath. A
 *    Studio row that was never written, or cannot be read, must still produce the email that
 *    was going out before any of this existed - never a blank message to a customer.
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
    assert.ok(["service", "activity", "optional"].includes(entry.category), entry.id + " has an unknown category");
    assert.ok(!seen.has(entry.id), "duplicate catalogue id: " + entry.id);
    seen.add(entry.id);
    /* The page names the owning file; a stale pointer is worse than none. */
    entry.sender.split(/[→,]/).forEach((chunk) => {
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

test("player welcome uses the shared shell, resolves safe variables, and drops unknown tokens", () => {
  const template = core.defaultWelcomeTemplate();
  template.subject = "Welcome {{firstName}} {{unknown}}";
  template.headline = "Hello {{fullName}}";
  template.body = "Hi {{firstName}}, <script>alert(1)</script> {{email}}";
  const built = core.build("player_welcome", {
    to: "player@example.com", recipientName: "Ava <Coach>", welcomeTemplate: template,
    variables: { firstName: "Ava", fullName: "Ava <Coach>", email: "player@example.com" }, accountState: "needs_setup",
    ctaUrl: "https://example.test/setup"
  });
  assert.strictEqual(built.subject, "Welcome Ava ", "unknown variables must disappear safely");
  assert.ok(/Set up your password &amp; get started/.test(built.html), "setup state did not override CTA safely");
  assert.ok(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(built.html), "welcome content was not escaped by the shared renderer");
  assert.ok(!built.html.includes("<script>alert"), "welcome content injected HTML");
});

test("welcome endpoint stays server-owned and does not accept a recipient from the browser", () => {
  const src = read("functions", "caddy-admin-welcome-email.js");
  assert.ok(/requireAdmin/.test(src), "welcome endpoint lacks an admin gate");
  assert.ok(/playerById\(body\.playerId\)/.test(src), "welcome endpoint does not resolve a canonical player server-side");
  assert.ok(!/body\.email/.test(src), "welcome endpoint trusts a browser-supplied email address");
  assert.ok(/templates\.build\(resolved\.templateKey/.test(src), "welcome endpoint bypasses the central renderer");
  /* Which template a player gets is an entitlement question, never a request field. */
  assert.ok(/resolvePlayer\(await playerById\(body\.playerId\)\)/.test(src), "the player send does not resolve the player server-side");
  assert.ok(!/templateKey: text\(body\.templateKey/.test(src), "a player send takes its template from the browser");
  assert.ok(/signupTemplates\.keyForComped\(comped\)/.test(src), "the player send does not pick its template from the entitlement");
  assert.ok(/admin\/generate_link/.test(src), "welcome endpoint does not reuse the secure setup mechanism");
});

function compedBuild(overrides) {
  return core.build("coach_invite_comped", Object.assign({
    to: "player@example.com",
    recipientName: "Alex Fenwick",
    actorName: "Sam Hale",
    welcomeTemplate: core.defaultSignupTemplate("coach_invite_comped"),
    variables: Object.assign(
      { firstName: "Alex", fullName: "Alex Fenwick", email: "player@example.com", coachName: "Sam Hale", appUrl: "https://example.test" },
      core.accessVariables({ periodLabel: "a month", expiresLabel: "3 October 2026", membership: true })
    ),
    accountState: "needs_setup",
    ctaUrl: "https://example.test/set-password"
  }, overrides || {}));
}

test("the comped welcome email covers BOTH the password step and the comp", () => {
  const built = compedBuild();
  assert.ok(/a month/.test(built.subject), "the subject does not mention the comp");
  assert.ok(/password/i.test(built.html), "the message never tells them to set a password");
  assert.ok(/a month of Clarity Membership/.test(built.message.detail), "the body never mentions the comped period");
  assert.ok(/3 October 2026/.test(built.message.detail), "the body never states when the access ends");
  assert.ok(/no card|won't auto-renew|does not renew|does not auto-renew/i.test(built.message.detail),
    "the body must say it does not renew - a comp that reads like a subscription generates support");
  assert.ok(built.html.includes("https://example.test/set-password"), "the CTA is not the set-password link");
});

test("the four editable templates are independent, not one plus a paragraph", () => {
  assert.deepStrictEqual(core.EDITABLE_TEMPLATE_KEYS,
    ["coach_invite_basic", "coach_invite_comped", "player_signup_welcome", "coach_updated_account"]);
  const bodies = core.EDITABLE_TEMPLATE_KEYS.map((k) => core.defaultSignupTemplate(k));
  bodies.forEach((a, i) => bodies.forEach((b, j) => {
    if (i === j) return;
    assert.notStrictEqual(a.body, b.body, core.EDITABLE_TEMPLATE_KEYS[i] + " and " + core.EDITABLE_TEMPLATE_KEYS[j] + " share a body");
    assert.ok(!b.body.includes(a.body), core.EDITABLE_TEMPLATE_KEYS[j] + " is " + core.EDITABLE_TEMPLATE_KEYS[i] + " with something appended");
  }));

  /* The comped invite is picked by the entitlement, and by nothing else. */
  assert.strictEqual(core.coachInviteKey(true), "coach_invite_comped");
  assert.strictEqual(core.coachInviteKey(false), "coach_invite_basic");

  /* A self-signup has no coach and no setup link, so its copy must not claim either. */
  const selfSignup = core.defaultSignupTemplate("player_signup_welcome");
  assert.ok(!/coachName/.test(selfSignup.body + selfSignup.subject), "the sign-up welcome names a coach who does not exist");
  assert.ok(!/set (up )?your password/i.test(selfSignup.body), "the sign-up welcome tells someone to set a password they already chose");

  /* Every key that ever shipped must still resolve to a real template. */
  ["player_welcome", "player_signup_basic", "player_signup_comped", "account_created", "account_created_comped", "nonsense"]
    .forEach((legacy) => assert.ok(core.EDITABLE_TEMPLATE_KEYS.includes(core.resolveTemplateKey(legacy)), legacy + " resolves nowhere"));
  assert.strictEqual(core.resolveTemplateKey("player_signup_comped"), "coach_invite_comped");
  assert.strictEqual(core.resolveTemplateKey("player_welcome"), "coach_invite_basic");
});

test("the coach-update email is opt-out, not opt-in, and says so in its own footer", () => {
  /* It must survive EMAIL_NOTIFICATIONS_ENABLED being unset - that flag is set nowhere in the
     repo, so gating on it would ship an email that never sends. */
  assert.strictEqual(core.bypassesActivitySwitch("coach_updated_account"), true,
    "the coach-update email can be silenced by an unset env var");
  /* But it is NOT a service email: the player can turn it off, so the footer must point at
     Settings rather than claim it relates to account access. */
  assert.strictEqual(core.isServiceEventType("coach_updated_account"), false,
    "the coach-update email claims to be unsuppressable");
  const built = core.build("coach_updated_account", {
    to: "player@example.com",
    welcomeTemplate: core.defaultSignupTemplate("coach_updated_account"),
    variables: { firstName: "Alex", coachName: "Sam Hale" }
  });
  assert.ok(/Settings &gt; Notifications/.test(built.html), "the opt-out email does not say where to opt out");
  assert.ok(!/relates to your Clarity account access/.test(built.html), "the opt-out email uses the service footer");
  /* One email can cover half an hour of saves, so it must not name a single thing. */
  assert.ok(!/\b(bag|shot data|profile photo)\b/i.test(built.message.detail),
    "the coach-update email names one specific change it cannot know is the only one");
  assert.ok(core.COACH_UPDATE_THROTTLE_MINUTES === 30, "the documented throttle window changed");
});

test("account_activity must not collapse into the coach-update template", () => {
  /* The same client event also carries player -> coach updates and the Settings test email.
     Mapping it would tell a coach that their coach had updated their account. */
  assert.strictEqual(core.resolveTemplateKey("account_activity"), "coach_invite_basic",
    "account_activity now resolves as an editable template");
  const activity = core.build("account_activity", { to: "a@b.com", title: "Sam updated your bag" });
  assert.strictEqual(activity.message.title, "Sam updated your bag", "account_activity lost its caller-supplied title");
  assert.strictEqual(core.bypassesActivitySwitch("account_activity"), false, "generic activity mail stopped being opt-in");
});

test("an unwritten, unreadable or half-empty template still sends a real email", () => {
  /* Field by field, not template by template: one cleared box must not take the rest of the
     message with it. */
  const built = core.build("coach_invite_basic", {
    to: "player@example.com",
    welcomeTemplate: { subject: "", headline: "", body: "", ctaLabel: "", ctaUrl: "" },
    variables: { firstName: "Alex" }
  });
  const fallback = core.defaultSignupTemplate("coach_invite_basic");
  assert.strictEqual(built.subject, fallback.subject, "an empty subject did not fall back");
  assert.ok(built.message.detail.trim().length > 40, "an empty body produced a near-blank customer email");
  assert.ok(built.message.ctaLabel.trim(), "an empty button label produced a blank button");
  assert.ok(/^https?:\/\//.test(built.message.ctaUrl), "an empty destination produced a dead button");
});

test("a template destination is validated, and a secure setup link always beats it", () => {
  assert.strictEqual(core.safeCtaUrl("javascript:alert(1)"), "", "a javascript: destination survived");
  assert.strictEqual(core.safeCtaUrl("data:text/html,x"), "", "a data: destination survived");
  assert.strictEqual(core.safeCtaUrl("https://example.test/go"), "https://example.test/go");
  const template = Object.assign(core.defaultSignupTemplate("coach_invite_basic"), { ctaUrl: "https://example.test/go" });
  const existing = core.build("coach_invite_basic", { to: "a@b.com", welcomeTemplate: template, accountState: "existing" });
  assert.strictEqual(existing.message.ctaUrl, "https://example.test/go", "the template destination was ignored");
  const setup = core.build("coach_invite_basic", { to: "a@b.com", welcomeTemplate: template, accountState: "needs_setup", ctaUrl: "https://example.test/one-use" });
  assert.strictEqual(setup.message.ctaUrl, "https://example.test/one-use", "a one-use setup link lost to a typed destination");
});

test("a line whose only facts are missing is dropped, not printed half-empty", () => {
  const template = Object.assign(core.defaultSignupTemplate("coach_invite_comped"), {
    body: "Hi {{firstName}},\n\nYou have access.\n\nYour access runs until {{accessUntil}}.\n\nClarity Golf"
  });
  const withDate = core.build("coach_invite_comped", { to: "a@b.com", welcomeTemplate: template, variables: { firstName: "Alex", accessType: "a month", accessUntil: "3 October 2026" } });
  const without = core.build("coach_invite_comped", { to: "a@b.com", welcomeTemplate: template, variables: { firstName: "Alex", accessType: "a month" } });
  assert.ok(/runs until 3 October 2026/.test(withDate.message.detail), "the expiry line vanished when the date was known");
  assert.ok(!/runs until/.test(without.message.detail), "an unknown expiry printed as a dangling sentence");
  assert.ok(/Clarity Golf/.test(without.message.detail), "dropping a line took the rest of the message with it");
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
  /* `comped` is only ever assigned from the pass writeCompedEntitlement returned, and is left
     null on failure - which is what stops a Comped Sign Up email describing access nobody
     holds. If this stops being the shape, the send-safety rule has gone with it. */
  assert.ok(/let comped = null;/.test(src), "the comp result is no longer null until it succeeds");
  assert.ok(/comped = \{ periodLabel: pass\.periodLabel/.test(src), "the comp result no longer comes from the written pass");
  assert.ok(/compError = error/.test(src), "a failed comp no longer leaves comped null");

  /* And the signup flow must not carry a second copy of the wording. */
  assert.ok(!/Welcome to Clarity/.test(src) && !/ctaLabel/.test(src) && !/subject:/.test(src),
    "the invite endpoint has grown its own email copy again");
});

test("the signup flow names an event, and the server picks the template from it", () => {
  const notify = read("functions", "email-notification.js");
  assert.ok(/signupTemplates\.keyForComped\(comped\)/.test(notify),
    "the welcome send no longer picks its template from whether a comp was issued");
  assert.ok(/welcomeTemplate: loaded\.template/.test(notify), "the welcome send no longer renders the stored template");
  assert.ok(/signupKey/.test(notify), "the generic notification endpoint no longer routes account_created to a Studio template");

  /* The browser used to post a fourth hand-written version of the welcome email. */
  const client = read("scripts", "clarity-email.js");
  /* Self-signup and coach-created are different events, and the client must say which. */
  assert.ok(/eventType:"player_signup_welcome"/.test(client), "self-signup no longer reports its own event");
  assert.ok(/eventType:"coach_invite_basic"/.test(client), "a coach creating a player no longer reports a coach invite");
  /* Raised for exactly one direction - coach to player - and never for the test email. */
  assert.ok(/"coach_updated_account"/.test(client), "the coach-update event is never raised");
  assert.ok(/direction === "coach_to_player" && !\(options && options\.test\)/.test(client),
    "the coach-update event is no longer scoped to the coach -> player direction");
  assert.ok(/eventType === "coach_updated_account"\)return prefs\.coachUpdates !== false/.test(client),
    "the coach-update email no longer answers to the Coach updates toggle");
  assert.ok(!/Your Clarity account is ready/.test(client),
    "the signup client is writing welcome-email copy again");
});

test("Welcome Emails are edited in Studio, and only in Studio", () => {
  const users = read("scripts", "clarity-admin-users.js");
  assert.ok(/Send Welcome/.test(users), "Admin -> Users lost its send action");
  assert.ok(!/editWelcomeTemplate/.test(users), "the template editor is back in Admin -> Users");
  assert.ok(!/data-field="body"/.test(users), "Admin -> Users still has editable email copy in it");
  assert.ok(/Communications/.test(users), "Admin -> Users does not say where the wording lives");

  const page = read("scripts", "studio", "communications", "communications-page.js");
  assert.ok(/Welcome Emails/.test(page), "Studio has no Welcome Emails section");
  assert.ok(/list_templates/.test(page), "the page does not read the stored templates");
  assert.ok(/action: "save_template"/.test(page), "the page cannot save a template");
  assert.ok(/action: "send_test"/.test(page), "the page has no Send Test");
  /* Preview must come from the server's renderer, not from a second one built in the page. */
  assert.ok(/action: "preview"/.test(page), "the page does not preview through the production renderer");
  assert.ok(!/<!doctype html>/i.test(page), "the Studio page is building email HTML");
  assert.ok(!/<table/i.test(page), "the Studio page has grown an email layout");
});

test("the coach-update throttle is atomic, server-side, and drops rather than queues", () => {
  const lib = read("functions", "lib", "gd-signup-templates.js");
  assert.ok(/claimCoachUpdateSlot/.test(lib), "the throttle claim is gone");
  assert.ok(/rpc\/claim_caddy_email_throttle/.test(lib),
    "the throttle is no longer claimed through the atomic function - a read-then-send races");
  /* An unreachable throttle must fail CLOSED. Falling back to sending would turn the one
     failure mode this feature exists to prevent into the default. */
  assert.ok(/catch \(err\)[\s\S]{0,200}allowed: false/.test(lib),
    "a failed throttle check no longer refuses the send");

  const notify = read("functions", "email-notification.js");
  assert.ok(/claimCoachUpdateSlot\(message\.to\)/.test(notify), "the endpoint does not claim a slot before sending");
  assert.ok(/if\(!slot\.allowed\)/.test(notify) && /return json\(200, \{sent: false, throttled/.test(notify),
    "a lost claim is not a silent, successful no-op");
  /* "or que any" - nothing may be deferred for later. */
  assert.ok(!/setTimeout|queue|retry/i.test(notify.slice(notify.indexOf("claimCoachUpdateSlot"), notify.indexOf("claimCoachUpdateSlot") + 600)),
    "a throttled coach-update email is being queued instead of dropped");

  /* The claim must be per recipient, so one player's saves cannot mute another player's. */
  assert.ok(/p_recipient_email/.test(lib), "the throttle is not keyed on the recipient");

  const migrations = fs.readdirSync(path.join(ROOT, "supabase", "migrations"))
    .filter((f) => /coach_invite|throttle/i.test(f))
    .map((f) => read("supabase", "migrations", f))
    .join("\n");
  assert.ok(/create or replace function public\.claim_caddy_email_throttle/.test(migrations),
    "the atomic claim function is not in a migration");
  /* The `where` on the conflict branch IS the atomicity. Without it the upsert always wins
     and the throttle silently stops throttling. */
  assert.ok(/on conflict[\s\S]{0,120}do update[\s\S]{0,120}where/i.test(migrations),
    "the throttle upsert lost the window guard that makes it atomic");
  assert.ok(/coach_invite_basic/.test(migrations) && /player_signup_welcome/.test(migrations),
    "the migration does not allow the new template keys");
  assert.ok(/update public\.caddy_email_templates set template_key = 'coach_invite_basic'/.test(migrations),
    "an admin's already-saved welcome copy is dropped instead of renamed");
});

test("the two welcome templates share the existing storage and fall back in code", () => {
  const lib = read("functions", "lib", "gd-signup-templates.js");
  assert.ok(/caddy_email_templates/.test(lib), "the templates are no longer stored in the existing table");
  assert.ok(/player_welcome/.test(lib), "the key the first version shipped under is no longer honoured");
  assert.ok(/catch \(err\)/.test(lib), "a failed template read is no longer survivable");

  const migrations = fs.readdirSync(path.join(ROOT, "supabase", "migrations"))
    .filter((f) => /welcome|signup/i.test(f))
    .map((f) => read("supabase", "migrations", f))
    .join("\n");
  assert.ok(/player_signup_basic/.test(migrations) && /player_signup_comped/.test(migrations),
    "no migration allows the two welcome template keys");
  assert.ok(!/create table if not exists public\.caddy_signup/.test(migrations),
    "a second template table was created instead of reusing the existing one");
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
