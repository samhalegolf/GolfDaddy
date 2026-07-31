/* A referral invitation is addressed to the friend, or to nobody.
 *
 * createReferralInvite used to read the invitee address as
 *   payload.friendEmail || payload.inviteeEmail || payload.email
 * while the client posted Object.assign({}, accountPayload(), formData), and
 * accountPayload().email is the INVITER's own address. The friend-email field is
 * optional, so leaving it blank sent friendEmail: "" and the chain fell through
 * to the inviter's own email. Every untargeted invite was stored as addressed to
 * the person who created it: it came back as the invite title on their own
 * dashboard, and recordReferralEvent logged `targeted: true` for all of them.
 *
 * Not an authorization bug - acceptance is gated on the referral token, and
 * claimedReferralForInvitee matches invitee_account_email, which is written from
 * the real invitee's account at accept time. This is about the stored row being
 * true: invitee_email means "the address the inviter typed", so it must be null
 * when they typed none, and must never be the inviter's own. */
const assert = require("assert");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const SERVICE = path.join(ROOT, "functions", "referral-service.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

const INVITER = { account_id: "acct_inviter", email: "inviter@example.com", name: "Inviter" };

function loadService(captured) {
  delete require.cache[SERVICE];
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === SERVICE && request === "./payment-utils") {
      return {
        ADMIN_COMPED_MEMBERSHIP_KEY: "admin_comped_membership",
        REFERRAL_ACCESS_KEY: "referral_membership",
        REFERRAL_REWARD_KEY: "referral_reward_membership",
        appUrl: function () { return "https://clarity.test"; },
        email: function (v) {
          const s = String(v || "").trim().toLowerCase();
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
        },
        encodeFilter: function (v) { return encodeURIComponent(String(v || "")); },
        env: function (name) { return name === "CLARITY_REFERRALS_ENABLED" ? "1" : ""; },
        isPaidEntitlement: function () { return true; },
        membershipAccessState: function () { return { active: true, state: "membership_active" }; },
        readPaidAccess: async function () { return { active: true, entitlements: [], membership: null }; },
        stripeFetch: async function () { return {}; },
        subjectOrFilter: function () { return "or=(x)"; },
        supabaseFetch: async function (p, options) {
          const method = (options && options.method) || "GET";
          /* The insert we care about. Capture the row and echo it back the way
             PostgREST would with Prefer: return=representation. */
          if (p === "referral_invitations" && method === "POST") {
            const row = JSON.parse(options.body);
            captured.inserted.push(row);
            return [Object.assign({ id: "ref_new" }, row)];
          }
          if (p.indexOf("referral_analytics_events") === 0 && method === "POST") {
            captured.events.push(JSON.parse(options.body));
            return [];
          }
          /* Eligibility: an active paid monthly membership (isActivePaidMembership
             wants a subscription and a paid invoice on the row), no outstanding
             invites. */
          if (p.indexOf("caddie_memberships") === 0) {
            return [{
              status: "active",
              access_until: new Date(Date.now() + 30 * 86400000).toISOString(),
              product_key: "monthly_membership",
              stripe_subscription_id: "sub_test",
              last_paid_invoice_id: "in_test"
            }];
          }
          return [];
        },
        text: function (v, limit) { const s = String(v || "").trim(); return s.length > limit ? s.slice(0, limit) : s; }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try { return require(SERVICE); }
  finally { Module._load = originalLoad; }
}

async function createWith(payload) {
  const captured = { inserted: [], events: [] };
  const service = loadService(captured);
  const result = await service.createReferralInvite(INVITER, { payload: payload, event: { headers: {} } });
  return { result: result, row: captured.inserted[0], events: captured.events, captured: captured };
}

/* The body the OLD client actually posted: accountPayload() merged with the
   invite form, both optional fields left blank. The `email` key is the inviter's
   own address - that is the whole bug, so the regression test has to send it.
   A payload without it would pass against the broken code and prove nothing. */
function legacyClientPayload(extra) {
  return Object.assign({
    accountId: INVITER.account_id,
    email: INVITER.email,
    name: INVITER.name,
    role: "player",
    friendName: "",
    friendEmail: ""
  }, extra || {});
}

test("an invite with no friend email stores a null invitee_email", async () => {
  const { row } = await createWith(legacyClientPayload());
  assert.ok(row, "the invitation row should have been inserted");
  assert.strictEqual(row.invitee_email, null,
    "an untargeted invite must not be addressed to anyone");
});

test("a blank form with no identity keys is still untargeted", async () => {
  /* What the fixed client posts now that it no longer merges accountPayload(). */
  const { row } = await createWith({ friendName: "", friendEmail: "" });
  assert.strictEqual(row.invitee_email, null);
});

test("an untargeted invite is never addressed to the inviter", async () => {
  /* The regression itself: the old client merged accountPayload() in, so the
     inviter's own address arrived under the key `email`. Even if something
     starts sending that key again, it must not become the invitee address. */
  const { row } = await createWith(legacyClientPayload());
  assert.notStrictEqual(row.invitee_email, INVITER.email,
    "the inviter's own address must never be stored as the invitee");
  assert.strictEqual(row.invitee_email, null);
});

test("an invite with no friend email is not logged as targeted", async () => {
  const { events } = await createWith(legacyClientPayload());
  const created = events.filter(function (e) { return e.event_type === "referral_invite_created"; })[0];
  assert.ok(created, "invite creation should be recorded");
  const meta = created.metadata || created.event_metadata || {};
  assert.strictEqual(meta.targeted, false,
    "targeted/untargeted analytics are meaningless if every invite counts as targeted");
});

test("an explicitly addressed invite still records the friend", async () => {
  /* The feature must keep working - this is the half that would break if the
     fallback were removed too bluntly. */
  const { row, events } = await createWith({ friendName: "Sam Friend", friendEmail: "Sam.Friend@Example.com " });
  assert.strictEqual(row.invitee_email, "sam.friend@example.com", "the typed address is normalised and kept");
  assert.strictEqual(row.friend_name, "Sam Friend");
  const created = events.filter(function (e) { return e.event_type === "referral_invite_created"; })[0];
  assert.strictEqual((created.metadata || {}).targeted, true, "a targeted invite must still count as targeted");
});

test("the inviteeEmail alias still works", async () => {
  const { row } = await createWith({ inviteeEmail: "friend@example.com" });
  assert.strictEqual(row.invitee_email, "friend@example.com");
});

test("a malformed friend email is stored as null, not as junk", async () => {
  const { row } = await createWith({ friendEmail: "not-an-email" });
  assert.strictEqual(row.invitee_email, null);
});

test("the invitee address is never read from a bare `email` key", () => {
  const fs = require("fs");
  const src = fs.readFileSync(SERVICE, "utf8");
  const idx = src.indexOf("async function createReferralInvite");
  const fn = src.slice(idx, src.indexOf("async function activeOutstandingInvites"));
  const line = fn.split("\n").filter(function (l) { return /invitee_email:/.test(l); })[0] || "";
  assert.ok(line, "createReferralInvite should still set invitee_email");
  assert.ok(!/payload\.email\b/.test(line),
    "payload.email is the caller's own address, not the invitee's - reading it back reopens this bug");
});

test("the client sends the invite, not its own identity", () => {
  /* The other half of the fix: with accountPayload() merged in, payload.email
     was populated on every createInvite call. Checked in the native bundles too,
     since a stale copy there would keep sending it. */
  const fs = require("fs");
  const clients = [
    path.join(ROOT, "scripts", "clarity-payments.js"),
    path.join(ROOT, "ios", "App", "App", "public", "scripts", "clarity-payments.js"),
    path.join(ROOT, "android", "app", "src", "main", "assets", "public", "scripts", "clarity-payments.js")
  ];
  clients.forEach(function (file) {
    if (!fs.existsSync(file)) return;
    const src = fs.readFileSync(file, "utf8");
    const idx = src.indexOf("async function createReferralInvite");
    assert.ok(idx !== -1, "createReferralInvite should exist in " + file);
    const call = src.slice(idx, idx + 400);
    const line = call.split("\n").filter(function (l) { return /referralAction\("createInvite"/.test(l); })[0] || "";
    assert.ok(line, "the createInvite call should be there: " + file);
    assert.ok(!/accountPayload\(\)/.test(line),
      "merging the caller's own account into the invite body is what addressed invites to the sender: " + file);
  });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("referral-invite-target failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("referral-invite-target passed: " + tests.length + " checks");
})();
