/* Store-side referral reward reversal (audit #2).
 *
 * The only reward-reversal path was keyed on a Stripe invoice id and called only
 * from the Stripe webhook. A referral qualified by a store purchase records a
 * store transaction id, not an invoice - so when an invitee refunded through
 * Apple/Google, their own access was revoked but the inviter kept the earned
 * free month. Every store-side referral refund was paid access given away.
 *
 * These check the store lookup reverses the reward, that EXPIRATION does NOT
 * (a lapsed subscription is an honoured referral, not a reversal), and that the
 * webhook wires REFUND to the reversal. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const REFERRALS = path.join(ROOT, "functions", "referral-service.js");
const UTILS = path.join(ROOT, "functions", "payment-utils.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function makeDb() {
  return {
    referrals: [],
    rewards: [],
    entitlements: [],
    events: [],
    patches: []
  };
}

function stubSupabase(db) {
  return async function (pathAndQuery, options) {
    const opts = options || {};
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (pathAndQuery.indexOf("referral_invitations") === 0) {
      const txn = decodeURIComponent((pathAndQuery.match(/first_paid_store_transaction_id=eq\.([^&]+)/) || [])[1] || "");
      const inv = decodeURIComponent((pathAndQuery.match(/first_paid_invoice_id=eq\.([^&]+)/) || [])[1] || "");
      return db.referrals.filter(function (r) {
        return (txn && r.first_paid_store_transaction_id === txn) || (inv && r.first_paid_invoice_id === inv);
      });
    }
    if (pathAndQuery.indexOf("referral_reward_ledger") === 0) {
      if (method === "GET") {
        const refId = decodeURIComponent((pathAndQuery.match(/referral_id=eq\.([^&]+)/) || [])[1] || "");
        return db.rewards.filter(function (r) { return r.referral_id === refId; });
      }
      if (method === "PATCH") {
        const id = decodeURIComponent((pathAndQuery.match(/id=eq\.([^&]+)/) || [])[1] || "");
        db.rewards.forEach(function (r) { if (r.id === id) Object.assign(r, body); });
        db.patches.push({ table: "reward", id: id, body: body });
        return [];
      }
    }
    if (pathAndQuery.indexOf("user_entitlements") === 0) {
      if (method === "GET") {
        const refId = decodeURIComponent((pathAndQuery.match(/source_referral_id=eq\.([^&]+)/) || [])[1] || "");
        return db.entitlements.filter(function (e) { return e.source_referral_id === refId; });
      }
      if (method === "PATCH") {
        const id = decodeURIComponent((pathAndQuery.match(/id=eq\.([^&]+)/) || [])[1] || "");
        db.entitlements.forEach(function (e) { if (e.id === id) Object.assign(e, body); });
        db.patches.push({ table: "entitlement", id: id, body: body });
        return [];
      }
    }
    if (pathAndQuery.indexOf("referral_analytics_events") === 0) {
      if (method === "POST") { db.events.push(body); return []; }
    }
    return [];
  };
}

function loadReferrals(db) {
  [UTILS, REFERRALS].forEach(function (p) { delete require.cache[p]; });
  const utils = require(UTILS);
  utils.supabaseFetch = stubSupabase(db);
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === REFERRALS && request === "./payment-utils") return utils;
    return originalLoad.apply(this, arguments);
  };
  try { return require(REFERRALS); }
  finally { Module._load = originalLoad; }
}

function seedStoreReferralWithAppliedReward(db) {
  db.referrals.push({
    id: "ref_store_1",
    inviter_account_id: "inviter_1",
    first_paid_store_transaction_id: "GPA.STORE-123",
    reward_earned_at: "2026-07-20T00:00:00.000Z"
  });
  db.rewards.push({
    id: "rwd_store_1",
    referral_id: "ref_store_1",
    inviter_account_id: "inviter_1",
    status: "applied",
    reward_type: "free_membership_month",
    audit_metadata: {}
  });
  db.entitlements.push({
    id: "ent_store_1",
    source_type: "referral_reward",
    source_referral_id: "ref_store_1",
    status: "active",
    expires_at: "2026-08-20T00:00:00.000Z"
  });
}

test("a store refund reverses the inviter's earned reward month", async () => {
  const db = makeDb();
  seedStoreReferralWithAppliedReward(db);
  const referrals = loadReferrals(db);

  const result = await referrals.reversePendingReferralRewardForStoreTransaction("GPA.STORE-123", "store_purchase_refunded");
  assert.ok(result, "the reversal must find and act on the reward");
  assert.strictEqual(db.rewards[0].status, "reversed", "the reward ledger row must be reversed");
});

test("the granted entitlement is expired, not left active", async () => {
  const db = makeDb();
  seedStoreReferralWithAppliedReward(db);
  const referrals = loadReferrals(db);

  await referrals.reversePendingReferralRewardForStoreTransaction("GPA.STORE-123", "store_purchase_refunded");
  const ent = db.entitlements[0];
  assert.strictEqual(ent.status, "reversed", "the free-month entitlement must be reversed");
  assert.ok(
    new Date(ent.expires_at).getTime() <= Date.now() + 1000,
    "and expired now - leaving expires_at in the future keeps the inviter paid"
  );
});

test("an unrelated store transaction reverses nothing", async () => {
  const db = makeDb();
  seedStoreReferralWithAppliedReward(db);
  const referrals = loadReferrals(db);

  const result = await referrals.reversePendingReferralRewardForStoreTransaction("GPA.SOMEONE-ELSE", "store_purchase_refunded");
  assert.strictEqual(result, null, "a refund of a non-qualifying purchase must not touch any reward");
  assert.strictEqual(db.rewards[0].status, "applied", "the real reward is untouched");
});

test("a missing transaction id is a clean no-op", async () => {
  const db = makeDb();
  const referrals = loadReferrals(db);
  assert.strictEqual(await referrals.reversePendingReferralRewardForStoreTransaction("", "x"), null);
  assert.strictEqual(await referrals.reversePendingReferralRewardForStoreTransaction(null, "x"), null);
});

test("the Stripe invoice reversal still works after the refactor", async () => {
  const db = makeDb();
  db.referrals.push({ id: "ref_stripe_1", inviter_account_id: "inviter_2", first_paid_invoice_id: "in_123", reward_earned_at: "x" });
  db.rewards.push({ id: "rwd_stripe_1", referral_id: "ref_stripe_1", inviter_account_id: "inviter_2", status: "applied", reward_type: "free_membership_month", audit_metadata: {} });
  db.entitlements.push({ id: "ent_stripe_1", source_type: "referral_reward", source_referral_id: "ref_stripe_1", status: "active", expires_at: "2026-08-20T00:00:00.000Z" });
  const referrals = loadReferrals(db);

  await referrals.reversePendingReferralRewardForInvoice("in_123", "qualifying_payment_refunded");
  assert.strictEqual(db.rewards[0].status, "reversed", "the shared reversal core must still serve the Stripe path");
});

/* --- webhook wiring --- */

test("the store webhook reverses on REFUND but not on EXPIRATION", () => {
  const src = fs.readFileSync(path.join(ROOT, "functions", "store-webhook.js"), "utf8");
  assert.ok(
    /reversePendingReferralRewardForStoreTransaction/.test(src),
    "the webhook must call the store reversal, or the whole path is dead"
  );
  const revokeIdx = src.indexOf("async function revokeAccess");
  const revokeBody = src.slice(revokeIdx, src.indexOf("\n}", revokeIdx) + 2);
  assert.ok(
    /rcEvent\.type === "REFUND"[\s\S]*maybeReverseReferralReward/.test(revokeBody),
    "reversal must be gated on REFUND - EXPIRATION is a lapsed subscription, an honoured referral"
  );
});

test("a reversal failure alerts rather than failing the webhook", () => {
  const src = fs.readFileSync(path.join(ROOT, "functions", "store-webhook.js"), "utf8");
  const idx = src.indexOf("async function maybeReverseReferralReward");
  const fn = src.slice(idx, idx + 900);
  assert.ok(/sendSystemAlert/.test(fn), "a silent reversal failure would leave the inviter over-paid with no signal");
  assert.ok(!/throw/.test(fn), "the buyer's refund is already processed; the webhook must not fail over referral bookkeeping");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.stack || err)); }
  }
  if (failed) { console.error("store-referral-reversal failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("store-referral-reversal passed: " + tests.length + " checks");
})();
