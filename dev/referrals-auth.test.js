/* referrals: the acting member is taken from a validated token, not from a
   request payload or header.
 *
 * Until 2026-07-27 the endpoint resolved the caller with resolveAccountByIdentity,
 * which preferred a verified Supabase token but fell back to client-supplied
 * identity when none was usable: payload.accountId / payload.email, or the
 * X-Clarity-Account-Id / X-Clarity-Account-Email request headers. Nothing proved
 * the caller owned that account. An unauthenticated POST carrying another
 * member's account id or email address was treated as that member: it returned
 * their referral dashboard - which lists the email address of every friend they
 * invited - and let the caller create, accept and revoke invitations in their
 * name.
 *
 * The load-bearing assertions are negative: that a spoofed identity reaches no
 * referral handler at all, and that a signed-in caller acts as the token's owner
 * even when the payload names someone else. "open" stays public on purpose - the
 * referral token is itself the credential - so it is checked for the opposite
 * property: it must work without a token AND disclose no invitee identity. */
const assert = require("assert");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "functions", "referrals.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Every action that reads or mutates a member's own referral state. Listing them
   explicitly means a newly added action that skips the gate shows up here as an
   omission rather than passing silently. "open" is excluded deliberately and has
   its own tests below. */
const IDENTIFIED_ACTIONS = ["dashboard", "createInvite", "accept", "revokeInvite"];

const VICTIM = { account_id: "acct_victim", email: "victim@example.com", name: "Victim", role: "player" };
const CALLER = { account_id: "acct_caller", email: "caller@example.com", name: "Caller", role: "player" };

/* The invitee-identifying columns a referral row carries. The unauthenticated
   preview must not echo any of them back. */
const INVITE_ROW = {
  id: "ref_1",
  status: "open",
  friend_name: "Sam Friend",
  invitee_email: "friend@example.com",
  invitee_account_id: "acct_friend",
  expires_at: "2026-09-01T00:00:00.000Z",
  risk_flags: ["same_ip_as_inviter"],
  attribution_metadata: { inviter_name: "Victim" }
};

function loadEndpoint(stubs) {
  delete require.cache[FN];
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === FN) {
      if (request === "./payment-utils") return stubs.utils;
      if (request === "./referral-service") return stubs.service;
      if (request === "./alert-utils") return { sendSystemAlert: async function () { return true; } };
    }
    return originalLoad.apply(this, arguments);
  };
  try { return require(FN); }
  finally { Module._load = originalLoad; }
}

function stubs(account) {
  const calls = { authCalls: 0, fallbackCalls: 0, service: [] };
  const utils = {
    calls: calls,
    /* The real one validates the bearer token against /auth/v1/user and returns
       the app_accounts row for whoever that token belongs to. It takes no header
       or payload identity, which is the whole point - this stub is handed the
       resolved account and ignores the event entirely. */
    authenticatedAccount: async function () { calls.authCalls += 1; return account; },
    /* The REMOVED helper, reimplemented here exactly as it behaved before
       2026-07-27: token first, then whatever identity the client supplied. It is
       deliberately still offered to the endpoint so these tests fail loudly and
       for the right reason if the endpoint ever reaches for it again - without
       it, restoring the old code merely crashes on an undefined function, which
       proves nothing about the bypass. The fixed endpoint must never call it,
       and every test below asserts fallbackCalls stayed at zero. */
    resolveAccountByIdentity: async function (payload, ev) {
      calls.fallbackCalls += 1;
      if (account) return account;
      const headers = (ev && ev.headers) || {};
      const id = (payload && payload.accountId) || headers["x-clarity-account-id"] || "";
      const mail = (payload && payload.email) || headers["x-clarity-account-email"] || "";
      if (id === VICTIM.account_id || mail === VICTIM.email) return VICTIM;
      const error = new Error("Sign in before continuing");
      error.status = 401;
      throw error;
    },
    hasSupabase: function () { return true; },
    json: function (status, body) { return { statusCode: status, body: JSON.stringify(body) }; },
    text: function (v, limit) { const s = String(v || "").trim(); return s.length > limit ? s.slice(0, limit) : s; }
  };
  function record(name) {
    return async function (first) {
      calls.service.push({ name: name, account: first });
      return { ok: true, called: name };
    };
  }
  const service = {
    getReferralDashboard: record("dashboard"),
    createReferralInvite: record("createInvite"),
    acceptReferralInvite: record("accept"),
    revokeReferralInvite: record("revokeInvite"),
    openReferralToken: async function (token) {
      calls.service.push({ name: "open", token: token });
      return { ok: true, invitation: { id: INVITE_ROW.id, status: INVITE_ROW.status, inviterName: "Victim", expiresAt: INVITE_ROW.expires_at } };
    }
  };
  return { utils: utils, service: service, calls: calls };
}

/* A request shaped exactly like the old exploit: no credential of any kind, the
   victim's account id and email supplied every way the removed helper read
   them. */
function spoofedEvent(action, extra) {
  return {
    httpMethod: "POST",
    headers: {
      "x-clarity-account-id": VICTIM.account_id,
      "x-clarity-account-email": VICTIM.email
    },
    body: JSON.stringify(Object.assign({
      action: action,
      accountId: VICTIM.account_id,
      email: VICTIM.email
    }, extra || {}))
  };
}

test("no token: a spoofed accountId/email cannot read someone else's dashboard", async () => {
  const s = stubs(null);
  const res = await loadEndpoint(s).handler(spoofedEvent("dashboard"));
  assert.strictEqual(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.code, "token_required");
  assert.strictEqual(s.calls.service.length, 0, "the dashboard must not be built for an unauthenticated caller");
  assert.strictEqual(s.calls.fallbackCalls, 0, "the client-supplied identity path must not be consulted at all");
  assert.ok(!("invites" in body), "invitee email addresses must not leak");
  assert.ok(!("summary" in body) && !("eligibility" in body), "no referral state at all for an unauthenticated caller");
});

test("no token: GET is refused too", async () => {
  /* GET defaults to the dashboard action and carries no body, so the headers
     were the whole exploit for this shape. */
  const s = stubs(null);
  const res = await loadEndpoint(s).handler({
    httpMethod: "GET",
    headers: { "x-clarity-account-id": VICTIM.account_id, "x-clarity-account-email": VICTIM.email }
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(s.calls.service.length, 0, "a header-only GET must reach no referral handler");
  assert.strictEqual(s.calls.fallbackCalls, 0, "the headers must not be read as identity");
});

test("no token: every identified action is refused", async () => {
  for (const action of IDENTIFIED_ACTIONS) {
    const s = stubs(null);
    const res = await loadEndpoint(s).handler(spoofedEvent(action, { referralToken: "tok", referralId: "ref_1" }));
    assert.strictEqual(res.statusCode, 401, action + " should be 401");
    assert.strictEqual(s.calls.service.length, 0, action + " must not run for an unauthenticated caller");
    assert.strictEqual(s.calls.fallbackCalls, 0, action + " must not fall back to client-supplied identity");
  }
});

test("no token: header-only identity grants nothing without a payload", async () => {
  const s = stubs(null);
  const res = await loadEndpoint(s).handler({
    httpMethod: "POST",
    headers: { "x-clarity-account-id": VICTIM.account_id, "x-clarity-account-email": VICTIM.email },
    body: JSON.stringify({ action: "dashboard" })
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(s.calls.service.length, 0);
  assert.strictEqual(s.calls.fallbackCalls, 0);
});

test("a signed-in caller acts as the token's owner, not as the payload's account", async () => {
  /* The subtler half of the bug: even with the fallback in place a token used to
     win, but only if it validated. Assert the positive property directly - the
     account handed to the referral service is the token's, while the payload and
     headers name the victim. */
  for (const action of IDENTIFIED_ACTIONS) {
    const s = stubs(CALLER);
    const res = await loadEndpoint(s).handler(spoofedEvent(action, { referralToken: "tok", referralId: "ref_1" }));
    assert.strictEqual(res.statusCode, 200, action + " should succeed for a signed-in caller: " + res.body);
    assert.strictEqual(s.calls.service.length, 1, action + " should reach exactly one handler");
    assert.strictEqual(s.calls.service[0].account.account_id, CALLER.account_id,
      action + " must act as the token owner");
    assert.notStrictEqual(s.calls.service[0].account.account_id, VICTIM.account_id,
      action + " must never act as the spoofed account");
    assert.strictEqual(s.calls.fallbackCalls, 0, action + " must resolve the caller from the token alone");
  }
});

test("a genuine member is identified with no X-Clarity-* header at all", async () => {
  const s = stubs(CALLER);
  const res = await loadEndpoint(s).handler({
    httpMethod: "GET",
    headers: {}
  });
  assert.strictEqual(res.statusCode, 200, "the referral dashboard must keep working: " + res.body);
  assert.strictEqual(s.calls.authCalls, 1, "the token is the only identity check");
});

test("previewing an invitation stays public - the token is the credential", async () => {
  const s = stubs(null);
  const res = await loadEndpoint(s).handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ action: "open", referralToken: "tok_public" })
  });
  assert.strictEqual(res.statusCode, 200, "a referral landing page must work signed out: " + res.body);
  assert.strictEqual(s.calls.authCalls, 0, "the public preview must not require a token exchange");
  assert.strictEqual(s.calls.service[0].token, "tok_public");
});

test("the public preview discloses no invitee identity", () => {
  /* Checks the real shaper rather than the stub: openReferralToken hands back
     invitationPreview, not the member-facing publicInvitation. */
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "functions", "referral-service.js"), "utf8");
  const idx = src.indexOf("async function openReferralToken");
  assert.ok(idx !== -1, "openReferralToken should still exist");
  const fn = src.slice(idx, src.indexOf("function validateReferralForOpening"));
  assert.ok(!/publicInvitation/.test(fn),
    "the unauthenticated preview must not return the member-facing invitation shape");
  assert.ok(/invitationPreview/.test(fn), "the preview must go through invitationPreview");

  const shaperIdx = src.indexOf("function invitationPreview");
  assert.ok(shaperIdx !== -1, "invitationPreview should exist");
  const shaper = src.slice(shaperIdx, src.indexOf("function publicReward"));
  ["invitee_email", "invitee_account_id", "friend_name", "risk_flags"].forEach(function (field) {
    assert.ok(!new RegExp(field).test(shaper),
      "a link holder must not learn " + field + " from the public preview");
  });
});

test("the endpoint no longer reads identity from headers or payload", () => {
  const fs = require("fs");
  const src = fs.readFileSync(FN, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/x-clarity-account-id|x-clarity-account-email/i.test(code),
    "reading these headers back would reopen the bypass");
  assert.ok(!/resolveAccountByIdentity/.test(code),
    "the fallback helper is the bug; it must not come back");
  assert.ok(!/payload\.accountId|payload\.email/.test(code),
    "identity must not be taken from the request body");
  assert.ok(/authenticatedAccount/.test(code), "identity must come from the validated token");
});

test("the identity fallback helper is gone from payment-utils", () => {
  const utils = require(path.join(ROOT, "functions", "payment-utils.js"));
  assert.strictEqual(typeof utils.resolveAccountByIdentity, "undefined",
    "an exported header-reading identity helper is an invitation to reintroduce the bypass");
  assert.strictEqual(typeof utils.authenticatedAccount, "function", "the token-only helper must remain");
});

test("the referral client sends a refreshable token and no identity headers", () => {
  /* Requiring a token is only safe because the client can always present a fresh
     one: it refreshes an expired token before the call and retries once with a
     force-refreshed token after a 401. That is what made the stale-token
     fallback unnecessary, so it is asserted here rather than assumed. Checked in
     the native bundles too - a stale copy there would 401 real members. */
  const fs = require("fs");
  const clients = [
    path.join(ROOT, "scripts", "clarity-payments.js"),
    path.join(ROOT, "ios", "App", "App", "public", "scripts", "clarity-payments.js"),
    path.join(ROOT, "android", "app", "src", "main", "assets", "public", "scripts", "clarity-payments.js")
  ];
  clients.forEach(function (file) {
    if (!fs.existsSync(file)) return;
    const src = fs.readFileSync(file, "utf8");
    const idx = src.indexOf("async function referralAction");
    assert.ok(idx !== -1, "referralAction should exist in " + file);
    const fn = src.slice(idx, idx + 900);
    assert.ok(/authedHeaders\(false\)/.test(fn), "the referral call must use the refresh-aware header helper: " + file);
    assert.ok(/response\.status === 401[\s\S]*authedHeaders\(true\)/.test(fn),
      "a 401 must retry once with a force-refreshed token: " + file);
    assert.ok(!/X-Clarity-Account-(Id|Email)/i.test(fn),
      "sending these again would make a removed authentication path look supported: " + file);
  });
});

test("no referral call sends the caller's own account in the body", () => {
  /* The server ignores payload identity entirely, so sending it is at best dead
     weight that makes a deleted authentication path look supported - and at
     worst a live bug: accountPayload() puts the user's own address under the key
     `email`, which createReferralInvite read as the INVITEE address whenever the
     friend-email field was blank, addressing untargeted invites to their sender.
     Asserted across every call site rather than the one that broke, since the
     next collision would be just as quiet.

     accountPayload() is still legitimately used elsewhere in this file - as a
     local "is anyone signed in" gate, and for the mailto sender name - so this
     checks the referralAction ARGUMENTS specifically, not the whole file. */
  const fs = require("fs");
  const clients = [
    path.join(ROOT, "scripts", "clarity-payments.js"),
    path.join(ROOT, "ios", "App", "App", "public", "scripts", "clarity-payments.js"),
    path.join(ROOT, "android", "app", "src", "main", "assets", "public", "scripts", "clarity-payments.js")
  ];
  let checked = 0;
  clients.forEach(function (file) {
    if (!fs.existsSync(file)) return;
    checked += 1;
    const src = fs.readFileSync(file, "utf8");
    const calls = src.split("\n").filter(function (line) { return /referralAction\(/.test(line) && !/async function referralAction/.test(line); });
    assert.ok(calls.length >= 4,
      "expected every referral call site to be found in " + file + " (got " + calls.length + ")");
    calls.forEach(function (line) {
      assert.ok(!/accountPayload\(\)/.test(line),
        "a referral call must not send the caller's own account: " + line.trim() + " [" + file + "]");
    });
  });
  assert.ok(checked > 0, "at least the source client must be present");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("referrals-auth failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("referrals-auth passed: " + tests.length + " checks");
})();
