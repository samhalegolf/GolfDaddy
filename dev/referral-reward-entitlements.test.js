/* Inviter rewards as entitlement days rather than Stripe balance credits.
 *
 * Two things are being locked here. First the arithmetic: a reward month must
 * extend the inviter's access, not run concurrently with it - a member with three
 * weeks left should end up with seven weeks, not four days of overlap. Second the
 * store path: an invitee who continues on Play or the App Store produces no
 * Stripe invoice, so without an explicit trigger their inviter is never paid.
 *
 * Supabase is stubbed; no network. */
const assert = require("assert");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const UTILS = path.join(ROOT, "functions", "payment-utils.js");
const ALERTS = path.join(ROOT, "functions", "alert-utils.js");
const REFERRALS = path.join(ROOT, "functions", "referral-service.js");
const WEBHOOK = path.join(ROOT, "functions", "store-webhook.js");

const DAY = 24 * 60 * 60 * 1000;
const AUTH = "test-shared-secret";

function makeDb() {
  return {
    entitlements: [],
    memberships: [],
    rewards: [],
    referrals: [],
    events: [],
    analytics: [],
    accounts: [{ account_id: "inviter_1", email: "inviter@example.com" }]
  };
}

function stubSupabaseFetch(db) {
  return async function (pathAndQuery, options) {
    const opts = options || {};
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (pathAndQuery.indexOf("user_entitlements") === 0) {
      if (method === "GET") {
        const referralId = decodeURIComponent((pathAndQuery.match(/source_referral_id=eq\.([^&]+)/) || [])[1] || "");
        if (referralId) {
          return db.entitlements.filter(function (r) { return r.source_referral_id === referralId; });
        }
        return db.entitlements.slice();
      }
      if (method === "POST") {
        const dupe = db.entitlements.some(function (r) {
          return r.source_referral_id && r.source_referral_id === body.source_referral_id
            && r.source_type === body.source_type;
        });
        if (!dupe) db.entitlements.push(Object.assign({ id: "ent_" + (db.entitlements.length + 1) }, body));
        return [];
      }
      return [];
    }

    if (pathAndQuery.indexOf("caddie_memberships") === 0) return db.memberships.slice();

    if (pathAndQuery.indexOf("referral_reward_ledger") === 0) {
      if (method === "GET") return db.rewards.slice();
      if (method === "POST") {
        const exists = db.rewards.some(function (r) { return r.idempotency_key === body.idempotency_key; });
        if (exists) return [];
        const row = Object.assign({ id: "rwd_" + (db.rewards.length + 1) }, body);
        db.rewards.push(row);
        return [row];
      }
      if (method === "PATCH") {
        const id = decodeURIComponent((pathAndQuery.match(/id=eq\.([^&]+)/) || [])[1] || "");
        let patched = null;
        db.rewards.forEach(function (r) { if (r.id === id) { Object.assign(r, body); patched = r; } });
        return patched ? [patched] : [];
      }
    }

    if (pathAndQuery.indexOf("referral_invitations") === 0) {
      if (method === "GET") return db.referrals.slice();
      if (method === "PATCH") {
        const id = decodeURIComponent((pathAndQuery.match(/id=eq\.([^&]+)/) || [])[1] || "");
        db.referrals.forEach(function (r) { if (r.id === id) Object.assign(r, body); });
        return [];
      }
    }

    if (pathAndQuery.indexOf("referral_analytics_events") === 0) {
      if (method === "POST") { db.analytics.push(body); return []; }
      return [];
    }

    if (pathAndQuery.indexOf("app_accounts") === 0) {
      const byId = decodeURIComponent((pathAndQuery.match(/account_id=eq\.([^&]+)/) || [])[1] || "");
      const byEmail = decodeURIComponent((pathAndQuery.match(/email=eq\.([^&]+)/) || [])[1] || "");
      return db.accounts.filter(function (a) {
        return (byId && a.account_id === byId) || (byEmail && a.email === byEmail);
      });
    }

    if (pathAndQuery.indexOf("store_webhook_events") === 0) {
      if (method === "POST") {
        const exists = db.events.some(function (e) { return e.store_event_id === body.store_event_id; });
        if (!exists) db.events.push(Object.assign({}, body));
        return [];
      }
      if (method === "GET") {
        const id = decodeURIComponent((pathAndQuery.match(/store_event_id=eq\.([^&]+)/) || [])[1] || "");
        return db.events.filter(function (e) { return e.store_event_id === id; });
      }
      if (method === "PATCH") return [];
    }

    return [];
  };
}

function withEnv(overrides, fn) {
  const previous = {};
  Object.keys(overrides).forEach(function (k) {
    previous[k] = process.env[k];
    if (overrides[k] === null) delete process.env[k];
    else process.env[k] = overrides[k];
  });
  return Promise.resolve(fn()).finally(function () {
    Object.keys(previous).forEach(function (k) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    });
  });
}

function loadReferrals(db) {
  [UTILS, REFERRALS].forEach(function (p) { delete require.cache[p]; });
  const utils = require(UTILS);
  utils.supabaseFetch = stubSupabaseFetch(db);

  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === REFERRALS && request === "./payment-utils") return utils;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(REFERRALS);
  } finally {
    Module._load = originalLoad;
  }
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* --- reward stacking ----------------------------------------------------- */

test("reward month starts now when the inviter has no active access", async () => {
  const db = makeDb();
  await withEnv({ SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => {
    const referrals = loadReferrals(db);
    const referral = { id: "ref_1", inviter_account_id: "inviter_1", inviter_account_email: "inviter@example.com" };
    const reward = { id: "rwd_1", status: "available", reward_duration_days: 30, audit_metadata: {} };
    db.rewards.push(reward);

    await referrals.__test.applyReferralReward(reward, referral, {});

    assert.strictEqual(db.entitlements.length, 1, "one reward entitlement granted");
    const row = db.entitlements[0];
    assert.strictEqual(row.product_key, "referral_reward_membership");
    assert.strictEqual(row.user_id, "inviter_1");
    assert.strictEqual(row.source_type, "referral_reward");
    const span = new Date(row.expires_at).getTime() - new Date(row.starts_at).getTime();
    assert.ok(Math.abs(span - 30 * DAY) < 1000, "must grant a 30 day window");
    assert.ok(
      Math.abs(new Date(row.starts_at).getTime() - Date.now()) < 5000,
      "with no existing access the month starts now"
    );
  });
});

test("reward month stacks after existing entitlement access", async () => {
  const db = makeDb();
  const existingExpiry = Date.now() + 21 * DAY;
  db.entitlements.push({
    id: "ent_existing", product_key: "month_pass", status: "active",
    expires_at: new Date(existingExpiry).toISOString()
  });
  await withEnv({ SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => {
    const referrals = loadReferrals(db);
    const referral = { id: "ref_2", inviter_account_id: "inviter_1", inviter_account_email: "inviter@example.com" };
    const reward = { id: "rwd_2", status: "available", reward_duration_days: 30, audit_metadata: {} };
    db.rewards.push(reward);

    await referrals.__test.applyReferralReward(reward, referral, {});

    const granted = db.entitlements.find(function (r) { return r.source_referral_id === "ref_2"; });
    assert.ok(granted, "reward entitlement written");
    assert.ok(
      Math.abs(new Date(granted.starts_at).getTime() - existingExpiry) < 1000,
      "reward must begin when existing access ends, not now"
    );
    assert.ok(
      Math.abs(new Date(granted.expires_at).getTime() - (existingExpiry + 30 * DAY)) < 1000,
      "inviter must end up with the full extra month on top"
    );
  });
});

test("reward month stacks after an active subscription period", async () => {
  const db = makeDb();
  const periodEnd = Date.now() + 10 * DAY;
  db.memberships.push({
    status: "active",
    /* isActivePaidMembership requires a subscription id and a settled invoice - a
       membership row only ever exists for Stripe billing. */
    stripe_subscription_id: "sub_1",
    last_paid_invoice_id: "in_1",
    current_period_end: new Date(periodEnd).toISOString(),
    access_until: new Date(periodEnd).toISOString()
  });
  await withEnv({ SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => {
    const referrals = loadReferrals(db);
    const referral = { id: "ref_3", inviter_account_id: "inviter_1", inviter_account_email: "inviter@example.com" };
    const reward = { id: "rwd_3", status: "available", reward_duration_days: 30, audit_metadata: {} };
    db.rewards.push(reward);

    await referrals.__test.applyReferralReward(reward, referral, {});

    const granted = db.entitlements.find(function (r) { return r.source_referral_id === "ref_3"; });
    assert.ok(
      Math.abs(new Date(granted.starts_at).getTime() - periodEnd) < 1000,
      "a renewing member has no entitlement row, so the subscription period must still be stacked behind"
    );
  });
});

test("a store-paid inviter is rewarded despite having no Stripe customer", async () => {
  const db = makeDb();
  /* No stripe_customer_id anywhere, and no membership row - exactly the shape
     that made the old customer-balance-credit path block forever. */
  await withEnv({ SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => {
    const referrals = loadReferrals(db);
    const referral = { id: "ref_4", inviter_account_id: "inviter_1", inviter_account_email: "inviter@example.com" };
    const reward = { id: "rwd_4", status: "available", reward_duration_days: 30, audit_metadata: {} };
    db.rewards.push(reward);

    const applied = await referrals.__test.applyReferralReward(reward, referral, {});

    assert.strictEqual(applied.status, "applied", "reward must not be left blocked");
    assert.strictEqual(applied.audit_metadata.reward_mechanism, "entitlement_days");
    assert.strictEqual(db.entitlements.length, 1, "inviter actually receives access");
  });
});

test("granting twice for one referral does not double-reward", async () => {
  const db = makeDb();
  await withEnv({ SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => {
    const referrals = loadReferrals(db);
    const referral = { id: "ref_5", inviter_account_id: "inviter_1", inviter_account_email: "inviter@example.com" };
    const reward = { id: "rwd_5", status: "available", reward_duration_days: 30, audit_metadata: {} };
    db.rewards.push(reward);

    await referrals.__test.applyReferralReward(reward, referral, {});
    /* Reset to available to simulate a replayed delivery reaching apply again. */
    reward.status = "available";
    await referrals.__test.applyReferralReward(reward, referral, {});

    const granted = db.entitlements.filter(function (r) { return r.source_referral_id === "ref_5"; });
    assert.strictEqual(granted.length, 1, "one referral must grant exactly one reward entitlement");
  });
});

/* --- store conversion trigger -------------------------------------------- */

function loadWebhookWithReferralSpy(db, spy) {
  [UTILS, ALERTS, WEBHOOK].forEach(function (p) { delete require.cache[p]; });
  const utils = require(UTILS);
  utils.supabaseFetch = stubSupabaseFetch(db);

  /* store-webhook requires referral-service lazily, after any Module._load hook
     would be uninstalled, so seed the cache instead. */
  require.cache[REFERRALS] = {
    id: REFERRALS, filename: REFERRALS, loaded: true, exports: spy
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === WEBHOOK) {
      if (request === "./payment-utils") return utils;
      if (request === "./alert-utils") return { sendSystemAlert: async function () {} };
    }
    return originalLoad.apply(this, arguments);
  };
  let webhook;
  try {
    webhook = require(WEBHOOK);
  } finally {
    Module._load = originalLoad;
  }
  /* The seeded cache entry must survive until the handler runs, since the lazy
     require happens inside maybeConvertReferral, not at module load. */
  return {
    webhook: webhook,
    cleanup: function () { delete require.cache[REFERRALS]; }
  };
}

function storeEvent(overrides) {
  return Object.assign({
    id: "evt_s1",
    type: "INITIAL_PURCHASE",
    store: "PLAY_STORE",
    app_user_id: "invitee_1",
    product_id: "clarity_membership_monthly",
    period_type: "NORMAL",
    original_transaction_id: "GPA.5555",
    purchased_at_ms: Date.now(),
    expiration_at_ms: Date.now() + 30 * DAY,
    event_timestamp_ms: Date.now()
  }, overrides || {});
}

test("a first store purchase triggers referral conversion", async () => {
  const db = makeDb();
  db.accounts.push({ account_id: "invitee_1", email: "invitee@example.com" });
  const calls = [];
  await withEnv({
    REVENUECAT_WEBHOOK_AUTH: AUTH,
    SUPABASE_URL: "https://stub.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k"
  }, async () => {
    const loaded = loadWebhookWithReferralSpy(db, {
      evaluateStoreReferralConversion: async function (input) { calls.push(input); return null; }
    });
    let res;
    try {
      res = await loaded.webhook.handler({
        httpMethod: "POST", headers: { authorization: AUTH },
        body: JSON.stringify({ event: storeEvent() })
      });
    } finally { loaded.cleanup(); }
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls.length, 1, "an initial store purchase must attempt referral conversion");
    assert.strictEqual(calls[0].userId, "invitee_1");
    assert.strictEqual(calls[0].storeTransactionId, "GPA.5555");
    assert.strictEqual(calls[0].store, "play");
  });
});

test("a renewal does not re-trigger referral conversion", async () => {
  const db = makeDb();
  db.accounts.push({ account_id: "invitee_1", email: "invitee@example.com" });
  const calls = [];
  await withEnv({
    REVENUECAT_WEBHOOK_AUTH: AUTH,
    SUPABASE_URL: "https://stub.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k"
  }, async () => {
    const loaded = loadWebhookWithReferralSpy(db, {
      evaluateStoreReferralConversion: async function (input) { calls.push(input); return null; }
    });
    try {
      await loaded.webhook.handler({
        httpMethod: "POST", headers: { authorization: AUTH },
        body: JSON.stringify({ event: storeEvent({ id: "evt_r1", type: "RENEWAL" }) })
      });
    } finally { loaded.cleanup(); }
    assert.strictEqual(calls.length, 0, "a renewal must not earn the inviter a second reward");
  });
});

test("a referral failure does not fail the purchase", async () => {
  const db = makeDb();
  db.accounts.push({ account_id: "invitee_1", email: "invitee@example.com" });
  await withEnv({
    REVENUECAT_WEBHOOK_AUTH: AUTH,
    SUPABASE_URL: "https://stub.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k"
  }, async () => {
    const loaded = loadWebhookWithReferralSpy(db, {
      evaluateStoreReferralConversion: async function () { throw new Error("referral blew up"); }
    });
    let res;
    try {
      res = await loaded.webhook.handler({
        httpMethod: "POST", headers: { authorization: AUTH },
        body: JSON.stringify({ event: storeEvent({ id: "evt_f1" }) })
      });
    } finally { loaded.cleanup(); }
    assert.strictEqual(res.statusCode, 200, "the buyer already has access; retrying would re-grant it");
    assert.strictEqual(db.entitlements.length, 1, "the purchase itself is still recorded");
  });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  ok  " + t.name);
    } catch (err) {
      failed += 1;
      console.error("  FAIL " + t.name);
      console.error("       " + (err && err.stack || err));
    }
  }
  if (failed) {
    console.error("referral-reward-entitlements failed: " + failed + "/" + tests.length);
    process.exit(1);
  }
  console.log("referral-reward-entitlements passed: " + tests.length + " checks");
})();
