#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WEBHOOK_SECRET = "whsec_test_payment_rollout";
const realDateNow = Date.now;
const FIXED_NOW = realDateNow();
const realModuleLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === "@netlify/blobs") {
    return {
      getStore: function () {
        return {
          get: async function () { return null; },
          setJSON: async function () {}
        };
      }
    };
  }
  return realModuleLoad.apply(this, arguments);
};

Date.now = function () { return FIXED_NOW; };

function resetEnv() {
  process.env.SUPABASE_URL = "https://unit.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_test";
  process.env.SUPABASE_ANON_KEY = "anon_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_unit";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_MONTH_PASS_PRICE_ID = "price_month_env";
  process.env.STRIPE_MONTHLY_MEMBERSHIP_PRICE_ID = "price_membership_env";
  process.env.CLARITY_REFERRALS_ENABLED = "1";
  process.env.CLARITY_REFERRAL_FREE_ACCESS_DAYS = "30";
  process.env.CLARITY_REFERRAL_INVITE_EXPIRY_DAYS = "30";
  process.env.CLARITY_REFERRAL_MAX_OUTSTANDING_INVITES = "10";
  process.env.CLARITY_REFERRAL_MAX_UNAPPLIED_REWARDS = "12";
  delete process.env.CLARITY_ALLOW_LEGACY_PAYMENT_ACCOUNT_PAYLOAD;
}

function clearPaymentModules() {
  Object.keys(require.cache).forEach(function (key) {
    if (key.indexOf(path.join("functions", "payment-utils.js")) !== -1 ||
        key.indexOf(path.join("functions", "create-checkout-session.js")) !== -1 ||
        key.indexOf(path.join("functions", "create-billing-portal-session.js")) !== -1 ||
        key.indexOf(path.join("functions", "referral-service.js")) !== -1 ||
        key.indexOf(path.join("functions", "referrals.js")) !== -1 ||
        key.indexOf(path.join("functions", "payment-admin.js")) !== -1 ||
        key.indexOf(path.join("functions", "stripe-webhook.js")) !== -1) {
      delete require.cache[key];
    }
  });
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async function () { return body === undefined ? "" : JSON.stringify(body); },
    json: async function () { return body; }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function iso(offsetMs) {
  return new Date(FIXED_NOW + offsetMs).toISOString();
}

function baseState() {
  return {
    authUsers: {
      token_auth: { id: "auth_1", email: "auth@example.com" },
      token_victim: { id: "auth_2", email: "victim@example.com" },
      token_friend: { id: "auth_3", email: "friend@example.com" }
    },
    app_accounts: [
      { account_id: "acct_auth", auth_user_id: "auth_1", email: "auth@example.com", name: "Auth User", stripe_customer_id: "cus_auth", role: "player", metadata: {}, created_at: iso(-24 * 60 * 60 * 1000) },
      { account_id: "acct_victim", auth_user_id: "auth_2", email: "victim@example.com", name: "Victim User", stripe_customer_id: "cus_victim", role: "player", metadata: {}, created_at: iso(0) },
      { account_id: "acct_friend", auth_user_id: "auth_3", email: "friend@example.com", name: "Friend User", stripe_customer_id: "cus_friend", role: "player", metadata: {}, created_at: iso(0) }
    ],
    payment_products: [
      { product_key: "month_pass", product_kind: "month_pass", name: "One Month Pass", active: true, stripe_price_id: "price_month_test", duration_hours: 720, billing_schedule: "one_time" },
      { product_key: "monthly_membership", product_kind: "membership", name: "Monthly Membership", active: true, stripe_price_id: "price_membership_test", duration_hours: 720, billing_schedule: "monthly" }
    ],
    user_entitlements: [],
    caddie_memberships: [],
    stripe_webhook_events: [],
    payment_events: [],
    referral_invitations: [],
    referral_reward_ledger: [],
    referral_analytics_events: [],
    stripeCustomers: {
      cus_auth: { id: "cus_auth", email: "auth@example.com" },
      cus_victim: { id: "cus_victim", email: "victim@example.com" },
      cus_friend: { id: "cus_friend", email: "friend@example.com" }
    },
    stripeSubscriptions: {},
    stripeSubscriptionsByCustomer: {},
    captures: {
      checkoutSessions: [],
      portalSessions: [],
      stripeGets: [],
      supabasePatches: [],
      balanceTransactions: []
    }
  };
}

function parseBody(body) {
  if (!body) return {};
  if (body instanceof URLSearchParams) {
    const result = {};
    body.forEach(function (value, key) {
      if (result[key] === undefined) result[key] = value;
      else if (Array.isArray(result[key])) result[key].push(value);
      else result[key] = [result[key], value];
    });
    return result;
  }
  if (typeof body === "string") return JSON.parse(body || "{}");
  return body;
}

function filterRows(rows, params) {
  let result = rows.slice();
  params.forEach(function (value, key) {
    if (["select", "order", "limit", "on_conflict"].indexOf(key) !== -1) return;
    if (key === "or") {
      const clauses = String(value || "").replace(/^\(|\)$/g, "").split(",").filter(Boolean).map(function (item) {
        const parts = item.split(".");
        return { column: parts[0], op: parts[1], value: decodeURIComponent(parts.slice(2).join(".")) };
      });
      result = result.filter(function (row) {
        return clauses.some(function (clause) { return compare(row[clause.column], clause.op, clause.value); });
      });
      return;
    }
    const parts = String(value || "").split(".");
    const op = parts[0];
    const expected = decodeURIComponent(parts.slice(1).join("."));
    if (!op) return;
    result = result.filter(function (row) { return compare(row[key], op, expected); });
  });
  const limit = Number(params.get("limit"));
  if (Number.isFinite(limit) && limit >= 0) result = result.slice(0, limit);
  return result;
}

function compare(actual, op, expected) {
  const actualText = actual === null || actual === undefined ? "" : String(actual);
  if (op === "eq") return actualText === expected;
  if (op === "neq") return actualText !== expected;
  return true;
}

function tableRows(state, table) {
  if (!state[table]) state[table] = [];
  return state[table];
}

function patchRows(rows, params, patch) {
  let matches = rows;
  params.forEach(function (value, key) {
    if (["select", "order", "limit", "on_conflict"].indexOf(key) !== -1 || key === "or") return;
    const parts = String(value || "").split(".");
    const op = parts[0];
    const expected = decodeURIComponent(parts.slice(1).join("."));
    matches = matches.filter(function (row) { return compare(row[key], op, expected); });
  });
  matches.forEach(function (row) { Object.assign(row, patch); });
  return matches;
}

function upsertBy(rows, conflictKey, row) {
  const existing = rows.find(function (item) {
    return item && row && conflictKey && item[conflictKey] === row[conflictKey];
  });
  if (existing) {
    Object.assign(existing, row);
    return existing;
  }
  const next = Object.assign({ id: "row_" + (rows.length + 1) }, row);
  rows.push(next);
  return next;
}

function createFetch(state) {
  return async function mockFetch(input, options) {
    const url = new URL(String(input));
    const method = String(options && options.method || "GET").toUpperCase();

    if (url.hostname === "unit.supabase.test" && url.pathname === "/auth/v1/user") {
      const auth = String(options && options.headers && (options.headers.Authorization || options.headers.authorization) || "");
      const token = auth.replace(/^Bearer\s+/i, "");
      const user = state.authUsers[token];
      return user ? response(200, user) : response(401, { error: "invalid_token" });
    }

    if (url.hostname === "unit.supabase.test" && url.pathname.indexOf("/rest/v1/") === 0) {
      const table = decodeURIComponent(url.pathname.replace("/rest/v1/", ""));
      const params = url.searchParams;
      const rows = tableRows(state, table);
      const body = parseBody(options && options.body);

      if (method === "GET") return response(200, filterRows(rows, params).map(clone));

      if (method === "PATCH") {
        state.captures.supabasePatches.push({ table, query: url.search, body: clone(body) });
        const matches = patchRows(rows, params, body);
        const prefer = String(options && options.headers && (options.headers.Prefer || options.headers.prefer) || "");
        return prefer.indexOf("return=representation") !== -1 ? response(200, matches.map(clone)) : response(204, null);
      }

      if (method === "POST") {
        const conflict = params.get("on_conflict") || "";
        if (table === "stripe_webhook_events") {
          const existing = rows.find(function (row) { return row.stripe_event_id === body.stripe_event_id; });
          if (existing) return response(201, []);
          const inserted = Object.assign({ id: "webhook_" + (rows.length + 1), created_at: iso(0) }, body);
          rows.push(inserted);
          return response(201, [clone(inserted)]);
        }
        if (conflict) {
          const inserted = upsertBy(rows, conflict, body);
          return response(201, [clone(inserted)]);
        }
        const inserted = Object.assign({ id: table + "_" + (rows.length + 1), created_at: iso(0) }, body);
        rows.push(inserted);
        return response(201, [clone(inserted)]);
      }
    }

    if (url.hostname === "api.stripe.com") {
      if (method === "GET" && url.pathname.indexOf("/v1/customers/") === 0) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        state.captures.stripeGets.push(url.pathname);
        return state.stripeCustomers[id] ? response(200, clone(state.stripeCustomers[id])) : response(404, { error: { message: "No such customer" } });
      }
      if (method === "POST" && url.pathname === "/v1/customers") {
        const body = parseBody(options && options.body);
        const id = "cus_new_" + (Object.keys(state.stripeCustomers).length + 1);
        const customer = { id, email: body.email || "" };
        state.stripeCustomers[id] = customer;
        return response(200, customer);
      }
      if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
        const body = parseBody(options && options.body);
        state.captures.checkoutSessions.push(body);
        return response(200, { id: "cs_test_" + state.captures.checkoutSessions.length, url: "https://checkout.stripe.test/session" });
      }
      if (method === "GET" && url.pathname === "/v1/subscriptions") {
        const customer = url.searchParams.get("customer");
        const data = state.stripeSubscriptionsByCustomer[customer] || [];
        return response(200, { data: data.map(clone) });
      }
      if (method === "GET" && url.pathname.indexOf("/v1/subscriptions/") === 0) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        return state.stripeSubscriptions[id] ? response(200, clone(state.stripeSubscriptions[id])) : response(404, { error: { message: "No such subscription" } });
      }
      if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
        const body = parseBody(options && options.body);
        state.captures.portalSessions.push(body);
        return response(200, { id: "bps_test", url: "https://billing.stripe.test/session" });
      }
      if (method === "GET" && url.pathname.indexOf("/v1/invoices/") === 0) {
        return response(404, { error: { message: "No such invoice" } });
      }
      if (method === "POST" && /\/v1\/customers\/[^/]+\/balance_transactions$/.test(url.pathname)) {
        const body = parseBody(options && options.body);
        const id = "cbtxn_" + (state.captures.balanceTransactions.length + 1);
        const transaction = Object.assign({ id }, body);
        state.captures.balanceTransactions.push(transaction);
        return response(200, transaction);
      }
    }

    return response(500, { error: "Unhandled fetch in payment rollout tests", url: url.toString(), method });
  };
}

function event(method, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return { httpMethod: method || "POST", headers, body: JSON.stringify(body || {}) };
}

function signedWebhook(stripeEvent) {
  const body = JSON.stringify(stripeEvent);
  const timestamp = String(Math.floor(FIXED_NOW / 1000));
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(timestamp + "." + body, "utf8").digest("hex");
  return {
    httpMethod: "POST",
    headers: { "stripe-signature": "t=" + timestamp + ",v1=" + signature },
    body
  };
}

function subscription(overrides) {
  return Object.assign({
    id: "sub_test",
    status: "active",
    customer: "cus_auth",
    metadata: { product_key: "monthly_membership", user_id: "acct_auth", account_email: "auth@example.com" },
    current_period_start: Math.floor((FIXED_NOW - 1000) / 1000),
    current_period_end: Math.floor((FIXED_NOW + 30 * 24 * 60 * 60 * 1000) / 1000),
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_membership_test", unit_amount: 2900, currency: "aud" } }] }
  }, overrides || {});
}

async function loadHandlers(state) {
  resetEnv();
  global.fetch = createFetch(state);
  clearPaymentModules();
  return {
    checkout: require(path.join(ROOT, "functions/create-checkout-session.js")).handler,
    portal: require(path.join(ROOT, "functions/create-billing-portal-session.js")).handler,
    referrals: require(path.join(ROOT, "functions/referrals.js")).handler,
    admin: require(path.join(ROOT, "functions/payment-admin.js")).handler,
    webhook: require(path.join(ROOT, "functions/stripe-webhook.js")).handler,
    utils: require(path.join(ROOT, "functions/payment-utils.js"))
  };
}

async function jsonBody(result) {
  return JSON.parse(result.body || "{}");
}

async function runCheckout(state, productKey, token, payload) {
  const handlers = await loadHandlers(state);
  const result = await handlers.checkout(event("POST", Object.assign({ productKey }, payload || {}), token || "token_auth"));
  return { result, body: await jsonBody(result), state };
}

async function runWebhook(state, stripeEvent) {
  const handlers = await loadHandlers(state);
  const result = await handlers.webhook(signedWebhook(stripeEvent));
  return { result, body: await jsonBody(result), state };
}

async function runReferral(state, action, payload, token) {
  const handlers = await loadHandlers(state);
  const result = await handlers.referrals(event("POST", Object.assign({ action }, payload || {}), token || "token_auth"));
  return { result, body: await jsonBody(result), state };
}

function referralTokenFrom(url) {
  return new URL(url).searchParams.get("ref");
}

function activePaidMembership(accountId, email, customerId, subscriptionId) {
  return {
    user_id: accountId,
    account_email: email,
    status: "active",
    access_until: iso(30 * 24 * 60 * 60 * 1000),
    current_period_end: iso(30 * 24 * 60 * 60 * 1000),
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId || "sub_" + accountId,
    last_paid_invoice_id: "inv_paid_" + accountId
  };
}

function checkoutSessionCompleted(id, session) {
  return {
    id,
    type: "checkout.session.completed",
    created: Math.floor(FIXED_NOW / 1000),
    data: { object: Object.assign({
      id: "cs_" + id,
      payment_status: "paid",
      customer: "cus_auth",
      customer_details: { email: "auth@example.com" },
      metadata: { product_key: "month_pass", user_id: "acct_auth", account_id: "acct_auth", account_email: "auth@example.com" },
      payment_intent: "pi_" + id,
      amount_total: 2900,
      currency: "aud"
    }, session || {}) }
  };
}

function invoiceEvent(id, type, subId, overrides) {
  return {
    id,
    type,
    created: Math.floor(FIXED_NOW / 1000),
    data: { object: Object.assign({ id: "inv_" + id, subscription: subId || "sub_test", customer: "cus_auth" }, overrides || {}) }
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("Month Pass Checkout uses payment mode without setup or subscription params", async function () {
  const state = baseState();
  const out = await runCheckout(state, "month_pass", "token_auth", { accountId: "acct_victim", email: "victim@example.com" });
  assert.strictEqual(out.result.statusCode, 200);
  const session = state.captures.checkoutSessions[0];
  assert.strictEqual(session.mode, "payment");
  assert.strictEqual(session.setup_future_usage, undefined);
  assert.strictEqual(Object.keys(session).some(function (key) { return key.indexOf("subscription_data") === 0; }), false);
  assert.strictEqual(session.client_reference_id, "acct_auth");
  assert.strictEqual(session["metadata[user_id]"], "acct_auth");
});

test("Membership Checkout uses subscription mode", async function () {
  const state = baseState();
  const out = await runCheckout(state, "monthly_membership", "token_auth");
  assert.strictEqual(out.result.statusCode, 200);
  assert.strictEqual(state.captures.checkoutSessions[0].mode, "subscription");
  assert.strictEqual(state.captures.checkoutSessions[0]["subscription_data[metadata][product_key]"], "monthly_membership");
});

test("Duplicate active Membership is blocked and routes to management", async function () {
  const state = baseState();
  state.caddie_memberships.push({ user_id: "acct_auth", account_email: "auth@example.com", status: "active", access_until: iso(30 * 24 * 60 * 60 * 1000), stripe_subscription_id: "sub_existing" });
  const out = await runCheckout(state, "monthly_membership", "token_auth");
  assert.strictEqual(out.result.statusCode, 200);
  assert.strictEqual(out.body.existingMembership, true);
  assert.strictEqual(out.body.action, "manage_membership");
  assert.strictEqual(state.captures.checkoutSessions.length, 0);
});

test("Billing Portal uses authenticated account rather than spoofed payload", async function () {
  const state = baseState();
  const handlers = await loadHandlers(state);
  const result = await handlers.portal(event("POST", { accountId: "acct_victim", email: "victim@example.com" }, "token_auth"));
  const body = await jsonBody(result);
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(body.url, "https://billing.stripe.test/session");
  assert.strictEqual(state.captures.portalSessions[0].customer, "cus_auth");
});

test("Unauthenticated Checkout is rejected when Supabase Auth is configured", async function () {
  const state = baseState();
  const handlers = await loadHandlers(state);
  const result = await handlers.checkout(event("POST", { productKey: "month_pass", accountId: "acct_auth", email: "auth@example.com" }, ""));
  assert.strictEqual(result.statusCode, 401);
  assert.strictEqual(state.captures.checkoutSessions.length, 0);
});

test("Active Monthly Member creates a private referral invite", async function () {
  const state = baseState();
  state.caddie_memberships.push(activePaidMembership("acct_auth", "auth@example.com", "cus_auth", "sub_inviter"));
  const out = await runReferral(state, "createInvite", { friendName: "Sam Friend", friendEmail: "friend@example.com" }, "token_auth");
  assert.strictEqual(out.result.statusCode, 200, JSON.stringify(out.body));
  assert.ok(out.body.shareUrl.indexOf("?ref=") !== -1);
  assert.strictEqual(state.referral_invitations.length, 1);
  assert.strictEqual(state.referral_invitations[0].status, "open");
  assert.strictEqual(state.referral_invitations[0].friend_name, "Sam Friend");
});

test("Month Pass-only user cannot create a referral invite", async function () {
  const state = baseState();
  state.user_entitlements.push({ user_id: "acct_auth", account_email: "auth@example.com", entitlement_type: "month_pass", product_key: "month_pass", status: "active", starts_at: iso(-1000), expires_at: iso(30 * 24 * 60 * 60 * 1000) });
  const out = await runReferral(state, "createInvite", {}, "token_auth");
  assert.strictEqual(out.result.statusCode, 403);
  assert.strictEqual(state.referral_invitations.length, 0);
});

test("Admin-comped Membership with referral flag can create a referral invite", async function () {
  const state = baseState();
  state.user_entitlements.push({ user_id: "acct_auth", account_email: "auth@example.com", entitlement_type: "admin_comped_membership", product_key: "admin_comped_membership", entitlement_reason: "admin_comped_membership", referral_eligible: true, status: "active", starts_at: iso(-1000), expires_at: iso(30 * 24 * 60 * 60 * 1000), metadata: { allow_member_referrals: true } });
  const out = await runReferral(state, "createInvite", {}, "token_auth");
  assert.strictEqual(out.result.statusCode, 200, JSON.stringify(out.body));
  assert.strictEqual(state.referral_invitations.length, 1);
});

test("Referral free-month recipient cannot create referral invites", async function () {
  const state = baseState();
  state.user_entitlements.push({ user_id: "acct_auth", account_email: "auth@example.com", entitlement_type: "referral_membership", product_key: "referral_membership", entitlement_reason: "referral_free_month", referral_eligible: false, status: "active", starts_at: iso(-1000), expires_at: iso(30 * 24 * 60 * 60 * 1000), metadata: { source: "referral" } });
  const out = await runReferral(state, "createInvite", {}, "token_auth");
  assert.strictEqual(out.result.statusCode, 403);
});

test("New account accepts referral and receives exactly 30 days with no Stripe payment", async function () {
  const state = baseState();
  state.caddie_memberships.push(activePaidMembership("acct_auth", "auth@example.com", "cus_auth", "sub_inviter"));
  const invite = await runReferral(state, "createInvite", {}, "token_auth");
  const token = referralTokenFrom(invite.body.shareUrl);
  const accepted = await runReferral(state, "accept", { referralToken: token }, "token_victim");
  assert.strictEqual(accepted.result.statusCode, 200, JSON.stringify(accepted.body));
  assert.strictEqual(state.user_entitlements.length, 1);
  assert.strictEqual(state.user_entitlements[0].product_key, "referral_membership");
  assert.strictEqual(state.user_entitlements[0].referral_eligible, false);
  assert.strictEqual(new Date(state.user_entitlements[0].expires_at).getTime() - new Date(state.user_entitlements[0].starts_at).getTime(), 30 * 24 * 60 * 60 * 1000);
  assert.strictEqual(state.captures.checkoutSessions.length, 0);
});

test("Referral token cannot be reused by a second account", async function () {
  const state = baseState();
  state.caddie_memberships.push(activePaidMembership("acct_auth", "auth@example.com", "cus_auth", "sub_inviter"));
  const invite = await runReferral(state, "createInvite", {}, "token_auth");
  const token = referralTokenFrom(invite.body.shareUrl);
  await runReferral(state, "accept", { referralToken: token }, "token_victim");
  const second = await runReferral(state, "accept", { referralToken: token }, "token_friend");
  assert.strictEqual(second.result.statusCode, 409);
  assert.strictEqual(state.user_entitlements.length, 1);
});

test("Invitee checkout during referral month delays billing until free access ends", async function () {
  const state = baseState();
  state.caddie_memberships.push(activePaidMembership("acct_auth", "auth@example.com", "cus_auth", "sub_inviter"));
  const invite = await runReferral(state, "createInvite", {}, "token_auth");
  const token = referralTokenFrom(invite.body.shareUrl);
  await runReferral(state, "accept", { referralToken: token }, "token_victim");
  const out = await runCheckout(state, "monthly_membership", "token_victim");
  assert.strictEqual(out.result.statusCode, 200, JSON.stringify(out.body));
  const session = state.captures.checkoutSessions[0];
  assert.strictEqual(session.mode, "subscription");
  assert.ok(Number(session["subscription_data[trial_end]"]) > Math.floor(FIXED_NOW / 1000));
  assert.strictEqual(session["metadata[referral_id]"], state.referral_invitations[0].id);
});

test("Positive first paid referred invoice earns one inviter reward as entitlement days", async function () {
  const state = baseState();
  state.caddie_memberships.push(activePaidMembership("acct_auth", "auth@example.com", "cus_auth", "sub_inviter"));
  state.stripeSubscriptions.sub_inviter = subscription({ id: "sub_inviter", customer: "cus_auth", metadata: { product_key: "monthly_membership", user_id: "acct_auth", account_email: "auth@example.com" } });
  const invite = await runReferral(state, "createInvite", {}, "token_auth");
  const token = referralTokenFrom(invite.body.shareUrl);
  await runReferral(state, "accept", { referralToken: token }, "token_victim");
  state.stripeSubscriptions.sub_referred = subscription({ id: "sub_referred", customer: "cus_victim", metadata: { product_key: "monthly_membership", user_id: "acct_victim", account_email: "victim@example.com" } });
  const out = await runWebhook(state, invoiceEvent("evt_referred_paid", "invoice.paid", "sub_referred", { customer: "cus_victim", amount_paid: 2900, amount_due: 2900, currency: "aud" }));
  assert.strictEqual(out.result.statusCode, 200, JSON.stringify(out.body));
  assert.strictEqual(state.referral_reward_ledger.length, 1);
  /* Inviter rewards are entitlement days, not Stripe customer balance credits, so
     the reward is applied on earn and no Stripe credit is raised. The credit
     mechanism could never pay out an inviter who subscribes through Play or the
     App Store, since they have no Stripe customer at all. */
  assert.strictEqual(state.referral_reward_ledger[0].status, "applied");
  assert.strictEqual(state.referral_reward_ledger[0].audit_metadata.reward_mechanism, "entitlement_days");
  assert.strictEqual(state.referral_invitations[0].status, "reward_earned");
  assert.strictEqual(state.captures.balanceTransactions.length, 0, "no Stripe credit is raised");

  const rewardRows = state.user_entitlements.filter(function (row) {
    return row.product_key === "referral_reward_membership";
  });
  assert.strictEqual(rewardRows.length, 1, "inviter receives exactly one reward month");
  assert.strictEqual(rewardRows[0].user_id, "acct_auth");
  const span = new Date(rewardRows[0].expires_at).getTime() - new Date(rewardRows[0].starts_at).getTime();
  assert.ok(Math.abs(span - 30 * 24 * 60 * 60 * 1000) < 1000, "reward grants 30 days");
});

test("Zero-value referred invoice and webhook replay do not double earn rewards", async function () {
  const state = baseState();
  state.caddie_memberships.push(activePaidMembership("acct_auth", "auth@example.com", "cus_auth", "sub_inviter"));
  state.stripeSubscriptions.sub_inviter = subscription({ id: "sub_inviter", customer: "cus_auth", metadata: { product_key: "monthly_membership", user_id: "acct_auth", account_email: "auth@example.com" } });
  const invite = await runReferral(state, "createInvite", {}, "token_auth");
  const token = referralTokenFrom(invite.body.shareUrl);
  await runReferral(state, "accept", { referralToken: token }, "token_victim");
  state.stripeSubscriptions.sub_referred = subscription({ id: "sub_referred", customer: "cus_victim", metadata: { product_key: "monthly_membership", user_id: "acct_victim", account_email: "victim@example.com" } });
  await runWebhook(state, invoiceEvent("evt_referred_zero", "invoice.paid", "sub_referred", { customer: "cus_victim", amount_paid: 0, amount_due: 0, currency: "aud" }));
  assert.strictEqual(state.referral_reward_ledger.length, 0);
  await runWebhook(state, invoiceEvent("evt_referred_positive", "invoice.paid", "sub_referred", { customer: "cus_victim", amount_paid: 2900, amount_due: 2900, currency: "aud" }));
  await runWebhook(state, invoiceEvent("evt_referred_positive", "invoice.paid", "sub_referred", { customer: "cus_victim", amount_paid: 2900, amount_due: 2900, currency: "aud" }));
  assert.strictEqual(state.referral_reward_ledger.length, 1);
  const rewardRows = state.user_entitlements.filter(function (row) {
    return row.product_key === "referral_reward_membership";
  });
  assert.strictEqual(rewardRows.length, 1, "a replayed webhook must not grant a second reward month");
});

test("Checkout rejects malformed Price IDs before Stripe", async function () {
  const state = baseState();
  state.payment_products[0].stripe_price_id = "prod_not_a_price";
  const out = await runCheckout(state, "month_pass", "token_auth");
  assert.strictEqual(out.result.statusCode, 503);
  assert.strictEqual(state.captures.checkoutSessions.length, 0);
});

test("Successful Month Pass webhook grants 30 days", async function () {
  const state = baseState();
  const out = await runWebhook(state, checkoutSessionCompleted("evt_month_1"));
  assert.strictEqual(out.result.statusCode, 200);
  assert.strictEqual(state.user_entitlements.length, 1);
  assert.strictEqual(state.user_entitlements[0].product_key, "month_pass");
  assert.strictEqual(new Date(state.user_entitlements[0].expires_at).getTime() - new Date(state.user_entitlements[0].starts_at).getTime(), 30 * 24 * 60 * 60 * 1000);
});

test("Second Month Pass extends from current expiry and duplicate checkout does not double grant", async function () {
  const state = baseState();
  await runWebhook(state, checkoutSessionCompleted("evt_month_1", { id: "cs_month_1", payment_intent: "pi_month_1" }));
  const firstExpiry = state.user_entitlements[0].expires_at;
  await runWebhook(state, checkoutSessionCompleted("evt_month_2", { id: "cs_month_2", payment_intent: "pi_month_2" }));
  assert.strictEqual(state.user_entitlements.length, 2);
  assert.strictEqual(state.user_entitlements[1].starts_at, firstExpiry);
  await runWebhook(state, checkoutSessionCompleted("evt_month_2", { id: "cs_month_2", payment_intent: "pi_month_2" }));
  assert.strictEqual(state.user_entitlements.length, 2);
});

test("invoice.paid activates or renews Membership", async function () {
  const state = baseState();
  state.stripeSubscriptions.sub_test = subscription();
  const out = await runWebhook(state, invoiceEvent("evt_invoice_paid", "invoice.paid", "sub_test"));
  assert.strictEqual(out.result.statusCode, 200);
  assert.strictEqual(state.caddie_memberships.length, 1);
  assert.strictEqual(state.caddie_memberships[0].status, "active");
  assert.strictEqual(state.caddie_memberships[0].last_paid_invoice_id, "inv_evt_invoice_paid");
});

test("Payment failure starts grace once and retry clears grace", async function () {
  const state = baseState();
  state.stripeSubscriptions.sub_test = subscription({ status: "past_due" });
  await runWebhook(state, invoiceEvent("evt_failed_1", "invoice.payment_failed", "sub_test"));
  const firstGrace = state.caddie_memberships[0].grace_until;
  assert.strictEqual(state.caddie_memberships[0].status, "past_due");
  assert.strictEqual(new Date(firstGrace).getTime() - new Date(state.caddie_memberships[0].first_payment_failed_at).getTime(), 7 * 24 * 60 * 60 * 1000);
  await runWebhook(state, invoiceEvent("evt_failed_2", "invoice.payment_failed", "sub_test"));
  assert.strictEqual(state.caddie_memberships[0].grace_until, firstGrace);
  state.stripeSubscriptions.sub_test = subscription({ status: "active" });
  await runWebhook(state, invoiceEvent("evt_paid_retry", "invoice.paid", "sub_test"));
  assert.strictEqual(state.caddie_memberships[0].status, "active");
  assert.strictEqual(state.caddie_memberships[0].grace_until, null);
  assert.strictEqual(state.caddie_memberships[0].first_payment_failed_at, null);
});

test("Cancellation at period end preserves access; deletion ends membership access", async function () {
  const state = baseState();
  const ending = subscription({ id: "sub_cancel", cancel_at_period_end: true });
  state.stripeSubscriptions.sub_cancel = ending;
  await runWebhook(state, { id: "evt_sub_updated", type: "customer.subscription.updated", created: Math.floor(FIXED_NOW / 1000), data: { object: { id: "sub_cancel" } } });
  assert.strictEqual(state.caddie_memberships[0].cancel_at_period_end, true);
  let handlers = await loadHandlers(state);
  let access = await handlers.utils.readPaidAccess({ accountId: "acct_auth", accountEmail: "auth@example.com" });
  assert.strictEqual(access.active, true);
  assert.strictEqual(access.paymentState, "membership_ending");

  const deleted = subscription({ id: "sub_cancel", status: "canceled", cancel_at_period_end: false, current_period_end: Math.floor((FIXED_NOW - 1000) / 1000) });
  await runWebhook(state, { id: "evt_sub_deleted", type: "customer.subscription.deleted", created: Math.floor(FIXED_NOW / 1000), data: { object: deleted } });
  handlers = await loadHandlers(state);
  access = await handlers.utils.readPaidAccess({ accountId: "acct_auth", accountEmail: "auth@example.com" });
  assert.strictEqual(access.active, false);
  assert.strictEqual(access.paymentState, "paid_access_expired");
});

test("readPaidAccess handles Month Pass, Membership, grace, expired, refund, and legacy rows", async function () {
  let state = baseState();
  state.user_entitlements.push({ user_id: "acct_auth", account_email: "auth@example.com", entitlement_type: "month_pass", product_key: "month_pass", status: "active", starts_at: iso(-1000), expires_at: iso(30 * 24 * 60 * 60 * 1000) });
  let handlers = await loadHandlers(state);
  let access = await handlers.utils.readPaidAccess({ accountId: "acct_auth", accountEmail: "auth@example.com" });
  assert.strictEqual(access.active, true);
  assert.strictEqual(access.paymentState, "month_pass_active");

  state = baseState();
  state.caddie_memberships.push({ user_id: "acct_auth", account_email: "auth@example.com", status: "active", access_until: iso(30 * 24 * 60 * 60 * 1000), current_period_end: iso(30 * 24 * 60 * 60 * 1000), cancel_at_period_end: false });
  handlers = await loadHandlers(state);
  access = await handlers.utils.readPaidAccess({ accountId: "acct_auth", accountEmail: "auth@example.com" });
  assert.strictEqual(access.paymentState, "membership_active");

  state.caddie_memberships[0].status = "past_due";
  state.caddie_memberships[0].grace_until = iso(7 * 24 * 60 * 60 * 1000);
  handlers = await loadHandlers(state);
  access = await handlers.utils.readPaidAccess({ accountId: "acct_auth", accountEmail: "auth@example.com" });
  assert.strictEqual(access.paymentState, "payment_problem_grace");

  state.caddie_memberships[0].grace_until = iso(-1000);
  handlers = await loadHandlers(state);
  access = await handlers.utils.readPaidAccess({ accountId: "acct_auth", accountEmail: "auth@example.com" });
  assert.strictEqual(access.active, false);

  state.user_entitlements.push({ user_id: "acct_auth", account_email: "auth@example.com", entitlement_type: "month_pass", product_key: "month_pass", status: "active", starts_at: iso(-1000), expires_at: iso(30 * 24 * 60 * 60 * 1000) });
  handlers = await loadHandlers(state);
  access = await handlers.utils.readPaidAccess({ accountId: "acct_auth", accountEmail: "auth@example.com" });
  assert.strictEqual(access.paymentState, "month_pass_active");

  state = baseState();
  state.user_entitlements.push({ user_id: "acct_auth", account_email: "auth@example.com", entitlement_type: "month_pass", product_key: "month_pass", status: "refunded", starts_at: iso(-1000), expires_at: iso(30 * 24 * 60 * 60 * 1000) });
  state.caddie_memberships.push({ user_id: "acct_auth", account_email: "auth@example.com", status: "active", access_until: iso(30 * 24 * 60 * 60 * 1000), current_period_end: iso(30 * 24 * 60 * 60 * 1000) });
  handlers = await loadHandlers(state);
  access = await handlers.utils.readPaidAccess({ accountId: "acct_auth", accountEmail: "auth@example.com" });
  assert.strictEqual(access.paymentState, "membership_active");

  state = baseState();
  state.user_entitlements.push({ user_id: "acct_auth", account_email: "auth@example.com", entitlement_type: "day_pass", product_key: "day_pass", status: "active", starts_at: iso(-1000), expires_at: iso(24 * 60 * 60 * 1000) });
  state.user_entitlements.push({ user_id: "acct_auth", account_email: "auth@example.com", entitlement_type: "round_pass", product_key: "round_pass", status: "active", starts_at: iso(-1000), expires_at: iso(24 * 60 * 60 * 1000) });
  handlers = await loadHandlers(state);
  access = await handlers.utils.readPaidAccess({ accountId: "acct_auth", accountEmail: "auth@example.com" });
  assert.strictEqual(access.active, true);
  assert.strictEqual(access.paymentState, "legacy_access_active");
});

test("Webhook processing rows are stale-retryable but fresh rows do not run concurrently", async function () {
  let state = baseState();
  state.stripe_webhook_events.push({ stripe_event_id: "evt_stale", event_type: "checkout.session.completed", processing_status: "processing", updated_at: iso(-16 * 60 * 1000) });
  const staleOut = await runWebhook(state, checkoutSessionCompleted("evt_stale", { id: "cs_stale", payment_intent: "pi_stale" }));
  assert.strictEqual(state.user_entitlements.length, 1);
  assert.strictEqual(staleOut.result.statusCode, 200, JSON.stringify(staleOut.body));
  assert.strictEqual(state.stripe_webhook_events[0].processing_status, "processed", JSON.stringify({ rows: state.stripe_webhook_events, patches: state.captures.supabasePatches }));

  state = baseState();
  state.stripe_webhook_events.push({ stripe_event_id: "evt_fresh", event_type: "checkout.session.completed", processing_status: "processing", updated_at: iso(0) });
  const out = await runWebhook(state, checkoutSessionCompleted("evt_fresh", { id: "cs_fresh", payment_intent: "pi_fresh" }));
  assert.strictEqual(out.body.duplicate, true);
  assert.strictEqual(state.user_entitlements.length, 0);
});

async function main() {
  try {
    for (const entry of tests) {
      await entry.fn();
      process.stdout.write("PASS " + entry.name + "\n");
    }
    process.stdout.write("\nPayment rollout tests passed: " + tests.length + "\n");
  } finally {
    Date.now = realDateNow;
    Module._load = realModuleLoad;
    delete global.fetch;
  }
}

main().catch(function (error) {
  Date.now = realDateNow;
  Module._load = realModuleLoad;
  console.error(error && error.stack || error);
  process.exit(1);
});
