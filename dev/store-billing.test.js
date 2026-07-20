/* Store billing (RevenueCat -> Supabase) regression tests.
 *
 * The webhook is the only thing standing between a store event and a granted paid
 * entitlement, so the cases that matter are the ones that would either give away
 * access or take it away wrongly: unauthenticated calls, replayed events, late
 * deliveries that would shorten access, and cancellations mistaken for expiry.
 *
 * Supabase and the alert channel are stubbed, so this runs with no network. */
const assert = require("assert");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const UTILS = path.join(ROOT, "functions", "payment-utils.js");
const ALERTS = path.join(ROOT, "functions", "alert-utils.js");
const WEBHOOK = path.join(ROOT, "functions", "store-webhook.js");

const AUTH = "test-shared-secret";

/* --- Supabase stub ------------------------------------------------------- */

function makeDb() {
  return {
    calls: [],
    events: [],
    entitlements: [],
    accounts: [{ account_id: "acct_1", email: "golfer@example.com" }]
  };
}

function stubSupabaseFetch(db) {
  return async function (pathAndQuery, options) {
    const opts = options || {};
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    db.calls.push({ path: pathAndQuery, method: method, body: body });

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
      if (method === "PATCH") {
        const id = decodeURIComponent((pathAndQuery.match(/store_event_id=eq\.([^&]+)/) || [])[1] || "");
        db.events.forEach(function (e) { if (e.store_event_id === id) Object.assign(e, body); });
        return [];
      }
    }

    if (pathAndQuery.indexOf("app_accounts") === 0) {
      const byId = decodeURIComponent((pathAndQuery.match(/account_id=eq\.([^&]+)/) || [])[1] || "");
      const byEmail = decodeURIComponent((pathAndQuery.match(/email=eq\.([^&]+)/) || [])[1] || "");
      return db.accounts.filter(function (a) {
        return (byId && a.account_id === byId) || (byEmail && a.email === byEmail);
      });
    }

    if (pathAndQuery.indexOf("user_entitlements") === 0) {
      const txn = decodeURIComponent((pathAndQuery.match(/store_transaction_id=eq\.([^&]+)/) || [])[1] || "");
      if (method === "GET") {
        return db.entitlements.filter(function (r) { return r.store_transaction_id === txn; });
      }
      if (method === "POST") {
        db.entitlements.push(Object.assign({ id: "ent_" + (db.entitlements.length + 1) }, body));
        return [];
      }
      if (method === "PATCH") {
        const byId = decodeURIComponent((pathAndQuery.match(/id=eq\.([^&]+)/) || [])[1] || "");
        db.entitlements.forEach(function (r) {
          if ((byId && r.id === byId) || (txn && r.store_transaction_id === txn)) Object.assign(r, body);
        });
        return [];
      }
    }

    throw new Error("unstubbed supabase call: " + method + " " + pathAndQuery);
  };
}

/* Load the webhook with payment-utils' supabaseFetch and the alert channel
   replaced, without touching the real modules on disk. */
function loadWebhook(db, envOverrides) {
  [UTILS, ALERTS, WEBHOOK].forEach(function (p) { delete require.cache[p]; });

  const previousEnv = {};
  const envVars = Object.assign({ REVENUECAT_WEBHOOK_AUTH: AUTH, SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "stub-key" }, envOverrides || {});
  Object.keys(envVars).forEach(function (k) {
    previousEnv[k] = process.env[k];
    if (envVars[k] === null) delete process.env[k];
    else process.env[k] = envVars[k];
  });

  const utils = require(UTILS);
  utils.supabaseFetch = stubSupabaseFetch(db);

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
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

  return {
    webhook: webhook,
    restore: function () {
      Object.keys(previousEnv).forEach(function (k) {
        if (previousEnv[k] === undefined) delete process.env[k];
        else process.env[k] = previousEnv[k];
      });
    }
  };
}

function call(webhook, rcEvent, headers) {
  return webhook.handler({
    httpMethod: "POST",
    headers: headers === undefined ? { authorization: AUTH } : headers,
    body: JSON.stringify({ event: rcEvent })
  });
}

const HOUR = 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 6, 20, 12, 0, 0);

function purchaseEvent(overrides) {
  return Object.assign({
    id: "evt_1",
    type: "INITIAL_PURCHASE",
    store: "PLAY_STORE",
    app_user_id: "acct_1",
    product_id: "clarity_membership_monthly",
    period_type: "NORMAL",
    original_transaction_id: "GPA.1111-2222",
    purchased_at_ms: BASE_MS,
    expiration_at_ms: BASE_MS + 30 * 24 * HOUR,
    event_timestamp_ms: BASE_MS
  }, overrides || {});
}

/* --- Tests --------------------------------------------------------------- */

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("rejects a request with no auth header", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    const res = await call(webhook, purchaseEvent(), {});
    assert.strictEqual(res.statusCode, 401, "missing auth must be rejected");
    assert.strictEqual(db.entitlements.length, 0, "no entitlement may be written");
  } finally { restore(); }
});

test("rejects a request with a wrong shared secret", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    const res = await call(webhook, purchaseEvent(), { authorization: "not-the-secret" });
    assert.strictEqual(res.statusCode, 401, "bad secret must be rejected");
    assert.strictEqual(db.entitlements.length, 0, "no entitlement may be written");
  } finally { restore(); }
});

test("fails closed when the shared secret is not configured", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db, { REVENUECAT_WEBHOOK_AUTH: null });
  try {
    const res = await call(webhook, purchaseEvent());
    assert.strictEqual(res.statusCode, 503, "unconfigured endpoint must not accept writes");
    assert.strictEqual(db.entitlements.length, 0, "no entitlement may be written");
  } finally { restore(); }
});

test("grants a membership entitlement on initial purchase", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    const res = await call(webhook, purchaseEvent());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.entitlements.length, 1, "exactly one entitlement row");
    const row = db.entitlements[0];
    assert.strictEqual(row.product_key, "store_membership");
    assert.strictEqual(row.user_id, "acct_1", "must resolve app_user_id to the account");
    assert.strictEqual(row.account_email, "golfer@example.com");
    assert.strictEqual(row.store, "play");
    assert.strictEqual(row.source_type, "store");
    assert.strictEqual(row.status, "active");
    assert.strictEqual(row.expires_at, new Date(BASE_MS + 30 * 24 * HOUR).toISOString());
  } finally { restore(); }
});

test("ignores a replayed event id", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    await call(webhook, purchaseEvent());
    const before = db.entitlements.length;
    const res = await call(webhook, purchaseEvent());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).duplicate, true, "replay must be reported as duplicate");
    assert.strictEqual(db.entitlements.length, before, "replay must not add a row");
  } finally { restore(); }
});

test("renewal extends the same row rather than creating a second", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    await call(webhook, purchaseEvent());
    const renewedTo = BASE_MS + 60 * 24 * HOUR;
    await call(webhook, purchaseEvent({
      id: "evt_2", type: "RENEWAL", expiration_at_ms: renewedTo
    }));
    assert.strictEqual(db.entitlements.length, 1, "a renewal must not fork a second row");
    assert.strictEqual(
      db.entitlements[0].expires_at, new Date(renewedTo).toISOString(),
      "renewal must push expiry forward"
    );
  } finally { restore(); }
});

test("a late renewal never shortens access already granted", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    await call(webhook, purchaseEvent());
    const far = BASE_MS + 90 * 24 * HOUR;
    await call(webhook, purchaseEvent({ id: "evt_2", type: "RENEWAL", expiration_at_ms: far }));
    /* Out-of-order delivery: an older renewal arrives after a newer one. */
    await call(webhook, purchaseEvent({
      id: "evt_3", type: "RENEWAL", expiration_at_ms: BASE_MS + 45 * 24 * HOUR
    }));
    assert.strictEqual(
      db.entitlements[0].expires_at, new Date(far).toISOString(),
      "a late out-of-order renewal must not move expiry backwards"
    );
  } finally { restore(); }
});

test("cancellation does not revoke access", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    await call(webhook, purchaseEvent());
    await call(webhook, purchaseEvent({ id: "evt_2", type: "CANCELLATION" }));
    const row = db.entitlements[0];
    assert.strictEqual(row.status, "active", "cancellation means 'will not renew', not 'access ends now'");
    assert.strictEqual(
      row.expires_at, new Date(BASE_MS + 30 * 24 * HOUR).toISOString(),
      "cancellation must leave the paid-for period intact"
    );
  } finally { restore(); }
});

test("expiration ends access at the store's stated time", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    await call(webhook, purchaseEvent());
    const endedAt = BASE_MS + 30 * 24 * HOUR;
    await call(webhook, purchaseEvent({ id: "evt_2", type: "EXPIRATION", expiration_at_ms: endedAt }));
    const row = db.entitlements[0];
    assert.strictEqual(row.status, "expired");
    assert.strictEqual(
      row.expires_at, new Date(endedAt).toISOString(),
      "a late EXPIRATION must not retroactively erase access the user had"
    );
  } finally { restore(); }
});

test("refund ends access immediately", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    await call(webhook, purchaseEvent());
    await call(webhook, purchaseEvent({ id: "evt_2", type: "REFUND" }));
    const row = db.entitlements[0];
    assert.strictEqual(row.status, "refunded");
    assert.ok(
      new Date(row.expires_at).getTime() <= Date.now() + 1000,
      "a refund must cut access now, not at period end"
    );
  } finally { restore(); }
});

test("non-renewing purchase becomes a store month pass with a derived expiry", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    await call(webhook, purchaseEvent({
      id: "evt_np",
      type: "NON_RENEWING_PURCHASE",
      product_id: "clarity_month_pass",
      original_transaction_id: null,
      transaction_id: "GPA.9999",
      expiration_at_ms: null
    }));
    const row = db.entitlements[0];
    assert.strictEqual(row.product_key, "store_month_pass");
    assert.strictEqual(row.non_renewing, true);
    assert.strictEqual(
      row.expires_at, new Date(BASE_MS + 30 * 24 * HOUR).toISOString(),
      "a store month pass with no store expiry must derive a 30 day window"
    );
  } finally { restore(); }
});

test("a trial period still grants membership access", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    await call(webhook, purchaseEvent({ period_type: "TRIAL" }));
    assert.strictEqual(db.entitlements[0].product_key, "store_membership");
    assert.strictEqual(db.entitlements[0].status, "active");
  } finally { restore(); }
});

test("an unknown buyer is recorded against their email", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    await call(webhook, purchaseEvent({
      app_user_id: "anon_xyz",
      subscriber_attributes: { $email: { value: "newgolfer@example.com" } }
    }));
    const row = db.entitlements[0];
    assert.strictEqual(row.user_id, null, "no account exists yet");
    assert.strictEqual(
      row.account_email, "newgolfer@example.com",
      "entitlement must be held against the email so signup picks it up"
    );
  } finally { restore(); }
});

test("a TEST ping is acked without writing anything", async () => {
  const db = makeDb();
  const { webhook, restore } = loadWebhook(db);
  try {
    const res = await call(webhook, { id: "evt_test", type: "TEST" });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.entitlements.length, 0, "a test ping must not grant access");
  } finally { restore(); }
});

/* payment-utils must recognise store access in the read path. */
test("readPaidAccess keys treat store products as paid access", async () => {
  delete require.cache[UTILS];
  const utils = require(UTILS);
  assert.strictEqual(utils.isPaidEntitlement({ product_key: "store_membership" }), true);
  assert.strictEqual(utils.isPaidEntitlement({ product_key: "store_month_pass" }), true);
  assert.strictEqual(utils.isStoreEntitlement({ product_key: "store_membership" }), true);
  assert.strictEqual(utils.isStoreEntitlement({ product_key: "monthly_membership" }), false,
    "Stripe products must not be reported as store-billed");
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
      console.error("       " + (err && err.message || err));
    }
  }
  if (failed) {
    console.error("store-billing failed: " + failed + "/" + tests.length);
    process.exit(1);
  }
  console.log("store-billing passed: " + tests.length + " checks");
})();
