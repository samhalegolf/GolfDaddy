/* Where referrals live, and what the app promises about them.
 *
 * Until 2026-09-03 the whole referral dashboard - a five-metric grid, the create
 * form and the invite list - rendered inside Access & Membership. Inviting a
 * friend was therefore a sub-feature of billing, reachable only through the
 * screen members open when something is wrong with their payment. It now has
 * its own settings page, and Membership keeps a status card that links to it.
 *
 * Two things in here are correctness, not layout:
 *
 * 1. The cap. The number of concurrent invitations is the server's to state
 *    (referral-service.js, env-configurable). The old UI printed a literal "10"
 *    in three places, so lowering the server cap to 5 would have left the app
 *    telling members they had ten months to give away and refusing the sixth.
 *
 * 2. The reward promise. An earned reward is 30 days written to
 *    user_entitlements, stacked on the END of existing access - not a discount
 *    on the next invoice. The old copy said the reward "will apply to your next
 *    eligible bill", which was true only of the Stripe customer-balance
 *    mechanism deleted in July 2026 (854fa27). For a member whose subscription
 *    is still renewing, no bill is ever skipped. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* The source client plus the Capacitor sync outputs. The native copies are
   gitignored build artifacts, so they are checked only when present. */
const CLIENTS = [
  path.join(ROOT, "scripts", "clarity-payments.js"),
  path.join(ROOT, "ios", "App", "App", "public", "scripts", "clarity-payments.js"),
  path.join(ROOT, "android", "app", "src", "main", "assets", "public", "scripts", "clarity-payments.js")
];

/* Source always; a native bundle only once it has been rebuilt from that source.
   The bundles are gitignored `npx cap sync` output, so one older than the source
   is simply an un-run sync - "you have not built yet", not a defect - while one
   built afterwards that lacks the change IS a real mismatched build. */
function eachClient(fn) {
  const source = CLIENTS[0];
  const sourceMtime = fs.statSync(source).mtimeMs;
  fn(fs.readFileSync(source, "utf8"), path.relative(ROOT, source));
  CLIENTS.slice(1).forEach(function (file) {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).mtimeMs < sourceMtime) return;
    fn(fs.readFileSync(file, "utf8"), path.relative(ROOT, file));
  });
}

function bodyOf(src, marker) {
  const start = src.indexOf(marker);
  assert.notStrictEqual(start, -1, "could not find " + marker);
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\n  (?:async )?function /);
  return rest.slice(0, next === -1 ? rest.length : next);
}

/* The referral copy alone. Scoped deliberately: "the next billing date" is
   honest and necessary on the Membership renewal line, so a whole-file search
   for bill wording would fail on copy that has nothing to do with referrals. */
function referralCopy(src) {
  return ["function renderReferralStatusBlock()", "function renderReferralRewardLine()",
    "function renderReferralHome()", "function referralStatusText(invite)"]
    .map(function (marker) { return bodyOf(src, marker); })
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("Membership renders referral status, not the referral home", () => {
  eachClient(function (src, file) {
    const section = bodyOf(src, "function renderReferralSection()");
    assert.ok(/renderReferralStatusBlock\(\)/.test(section),
      "Membership should show the compact status card: " + file);
    assert.ok(!/renderReferralCreateForm|renderReferralInviteList/.test(section),
      "the invite form and list belong to the referral page, not to billing: " + file);
    /* The invitee's own free month is genuinely billing state - it IS their
       current access - so it stays. */
    assert.ok(/renderInviteeReferral\(invitee\)/.test(section),
      "the invitee's free month must still show on Membership: " + file);
  });
});

test("the invite page exists and is reachable from outside the settings menu", () => {
  eachClient(function (src, file) {
    assert.ok(/gdPlayerSettingsReferralSection/.test(src), "referral page element missing: " + file);
    assert.ok(/openReferrals: openReferrals/.test(src), "openReferrals must be exported: " + file);
    const open = bodyOf(src, "function openReferrals()");
    assert.ok(/gdOpenPlayerSettingsPanel/.test(open) && /showSection\("referrals"\)/.test(open),
      "openReferrals must open the panel before switching section, or the tap does nothing: " + file);
  });
});

test("the Invite a Golfer row appears only while the server says the member may invite", () => {
  eachClient(function (src, file) {
    const sync = bodyOf(src, "function syncReferralMenuRow(list)");
    assert.ok(/if \(!referralEligible\(\)\)/.test(sync) && /removeChild\(existing\)/.test(sync),
      "an ineligible member must have no row at all - referrals are private: " + file);
    const eligible = bodyOf(src, "function referralEligible()");
    assert.ok(/eligibility && dashboard\.eligibility\.eligible/.test(eligible),
      "eligibility is the server's answer, never a local guess: " + file);
  });
});

test("the invite cap is read from the server, never printed as a literal", () => {
  eachClient(function (src, file) {
    const cap = bodyOf(src, "function referralInviteCap()");
    assert.ok(/maxOpenInvitations/.test(cap) && /maxOutstandingInvites/.test(cap),
      "the cap must come from the dashboard summary or config: " + file);
    const home = bodyOf(src, "function renderReferralHome()");
    assert.ok(/referralInviteCap\(\)/.test(home) && !/\b10\b/.test(home),
      "the referral page must print the server's cap: " + file);
  });
});

test("the app never promises a referral reward against the next bill", () => {
  eachClient(function (src, file) {
    const copy = referralCopy(src);
    assert.ok(!/next eligible bill|next bill|off your next|discount/i.test(copy),
      "a reward is entitlement days stacked after existing access, not a bill discount: " + file);
    const line = bodyOf(src, "function renderReferralRewardLine()");
    assert.ok(/end of your Caddy Access/.test(line),
      "say where the earned month actually goes: " + file);
  });
});

test("the server cap and the docs agree on five concurrent invitations", () => {
  const service = fs.readFileSync(path.join(ROOT, "functions", "referral-service.js"), "utf8");
  const match = service.match(/maxOutstandingInvites: intEnv\("CLARITY_REFERRAL_MAX_OUTSTANDING_INVITES", (\d+)/);
  assert.ok(match, "could not find the invite cap default");
  assert.strictEqual(match[1], "5", "the default concurrent invite cap is five");
  const doc = fs.readFileSync(path.join(ROOT, "docs", "architecture", "MEMBER_REFERRALS.md"), "utf8");
  assert.ok(/up to 5 open or opened invitations/.test(doc), "MEMBER_REFERRALS.md still states the old cap");
  assert.ok(/default `5`/.test(doc), "the documented env default still states the old cap");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("referral-surfaces failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("referral-surfaces passed: " + tests.length + " checks");
})();
