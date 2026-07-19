"use strict";

const STRIPE_API_VERSION = "2026-02-25.clover";
const MONTH_PASS_KEY = "month_pass";
const MONTHLY_MEMBERSHIP_KEY = "monthly_membership";
const REFERRAL_ACCESS_KEY = "referral_membership";
const ADMIN_COMPED_MEMBERSHIP_KEY = "admin_comped_membership";
/* Store-billed access (Google Play / App Store via RevenueCat). Distinct keys from
   the Stripe products so paymentState can report where access came from without
   joining another table. */
const STORE_MEMBERSHIP_KEY = "store_membership";
const STORE_MONTH_PASS_KEY = "store_month_pass";
const MONTH_PASS_HOURS = 24 * 30;
const PAID_ACCESS_KEYS = {
  month_pass: true,
  monthly_membership: true,
  referral_membership: true,
  referral: true,
  admin_comped_membership: true,
  subscription: true,
  day_pass: true,
  round_pass: true,
  free_pass: true,
  store_membership: true,
  store_month_pass: true
};
const STORE_ACCESS_KEYS = {
  store_membership: true,
  store_month_pass: true
};
const MEMBERSHIP_ACCESS_STATUSES = { active: true, trialing: true };
const MEMBERSHIP_GRACE_STATUS = "past_due";
const MEMBERSHIP_BLOCKING_STATUSES = {
  active: true,
  trialing: true,
  past_due: true,
  paused: true,
  incomplete: true
};
const PAID_PERMISSION_KEYS = {
  gps_round_start: true,
  gps_round_pass: true,
  gps_live_bubble: true,
  practice_bubble_view: true,
  my_bubble_view: true,
  course_data_view: true,
  course_bubble_view: true
};

const PASS_CONFIG = {
  month_pass: {
    env: "STRIPE_MONTH_PASS_PRICE_ID",
    label: "One Month Pass",
    hoursEnv: "CLARITY_MONTH_PASS_HOURS",
    defaultHours: MONTH_PASS_HOURS
  },
  monthly_membership: {
    env: "STRIPE_MONTHLY_MEMBERSHIP_PRICE_ID",
    label: "Monthly Membership",
    hoursEnv: "CLARITY_MEMBERSHIP_ACCESS_HOURS",
    defaultHours: MONTH_PASS_HOURS
  },
  day_pass: {
    env: "STRIPE_PRICE_DAY_PASS",
    label: "Day Pass",
    hoursEnv: "CLARITY_DAY_PASS_HOURS",
    defaultHours: 24
  },
  round_pass: {
    env: "STRIPE_PRICE_ROUND_PASS",
    label: "Round Pass",
    hoursEnv: "CLARITY_ROUND_PASS_HOURS",
    defaultHours: 24
  }
};

function env(name) {
  return process.env[name] || "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function text(value, limit) {
  const input = String(value || "").trim();
  return input.length > limit ? input.slice(0, limit) : input;
}

function email(value) {
  const input = text(value, 240).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : "";
}

function passType(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PASS_CONFIG[raw] ? raw : "";
}

function appUrl() {
  const configured = env("APP_URL") || env("CLARITY_SITE_URL") || env("URL") || "https://clarity-caddie.netlify.app";
  return configured.replace(/\/+$/, "");
}

function passPriceId(type) {
  const config = PASS_CONFIG[type];
  return config ? env(config.env) : "";
}

function passDurationHours(type) {
  const config = PASS_CONFIG[type] || PASS_CONFIG.day_pass;
  const value = Number(env(config.hoursEnv));
  return Number.isFinite(value) && value > 0 ? value : config.defaultHours;
}

function normaliseProductKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

async function paymentProduct(value, options) {
  options = options || {};
  const key = normaliseProductKey(value);
  if (!key || !hasSupabase()) return null;
  const activeFilter = options.activeOnly === false ? "" : "&active=eq.true";
  const rows = await supabaseFetch("payment_products?select=*&product_key=eq." + encodeFilter(key) + activeFilter + "&limit=1", { method: "GET" });
  return Array.isArray(rows) && rows[0] || null;
}

function productPriceId(product, fallbackType) {
  if (product && product.stripe_price_id) return product.stripe_price_id;
  return passPriceId(normaliseProductKey(fallbackType || product && product.product_key || ""));
}

function productDurationHours(product, fallbackType) {
  const value = Number(product && product.duration_hours);
  if (Number.isFinite(value) && value > 0) return value;
  return passDurationHours(fallbackType || product && product.product_key || "day_pass");
}

function entitlementWindow(type, createdMs, durationHours) {
  const starts = new Date(Number.isFinite(createdMs) ? createdMs : Date.now());
  const hours = Number(durationHours);
  const cleanHours = Number.isFinite(hours) && hours > 0 ? hours : passDurationHours(type);
  const expires = new Date(starts.getTime() + cleanHours * 60 * 60 * 1000);
  return {
    starts_at: starts.toISOString(),
    expires_at: expires.toISOString()
  };
}

function monthPassWindow(baseMs) {
  const starts = new Date(Number.isFinite(baseMs) ? baseMs : Date.now());
  const expires = new Date(starts.getTime() + MONTH_PASS_HOURS * 60 * 60 * 1000);
  return {
    starts_at: starts.toISOString(),
    expires_at: expires.toISOString()
  };
}

function supabaseBase() {
  return env("SUPABASE_URL").replace(/\/+$/, "");
}

function supabaseKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function supabaseAnonKey() {
  return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || "";
}

function hasSupabase() {
  return !!(supabaseBase() && supabaseKey());
}

function hasSupabaseAuth() {
  return !!(supabaseBase() && supabaseAnonKey());
}

async function supabaseFetch(path, options) {
  if (!hasSupabase()) throw new Error("Supabase payment storage is not configured");
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options && options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      body = bodyText;
    }
  }
  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function encodeFilter(value) {
  return encodeURIComponent(String(value || ""));
}

function isStripePriceId(value) {
  return /^price_[A-Za-z0-9_]+$/.test(text(value, 200));
}

function formParams(data) {
  const params = new URLSearchParams();
  Object.keys(data || {}).forEach(function (key) {
    const value = data[key];
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.forEach(function (item) { params.append(key, String(item)); });
      return;
    }
    params.append(key, String(value));
  });
  return params;
}

async function stripeFetch(method, path, data, fetchOptions) {
  const secret = env("STRIPE_SECRET_KEY");
  if (!secret) {
    const error = new Error("Stripe is not configured yet");
    error.status = 503;
    throw error;
  }
  const upper = String(method || "GET").toUpperCase();
  const url = new URL("https://api.stripe.com" + path);
  const requestOptions = {
    method: upper,
    headers: {
      Authorization: "Bearer " + secret,
      "Stripe-Version": STRIPE_API_VERSION
    }
  };
  const extra = fetchOptions || {};
  Object.assign(requestOptions.headers, extra.headers || {});
  if (upper === "GET") {
    formParams(data).forEach(function (value, key) { url.searchParams.append(key, value); });
  } else {
    requestOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
    requestOptions.body = formParams(data);
  }
  const response = await fetch(url.toString(), requestOptions);
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch (_error) { body = bodyText; }
  }
  if (!response.ok) {
    const error = new Error(body && body.error && body.error.message || "Stripe request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function bearerToken(event) {
  const headers = event && event.headers || {};
  const header = text(headers.authorization || headers.Authorization, 500);
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? text(match[1], 500) : "";
}

function subjectFilters(accountId, accountEmail, profileId) {
  const filters = [];
  if (accountId) filters.push("user_id.eq." + encodeFilter(accountId));
  if (accountEmail) filters.push("account_email.eq." + encodeFilter(accountEmail));
  if (profileId) filters.push("profile_id.eq." + encodeFilter(profileId));
  return filters;
}

function subjectOrFilter(accountId, accountEmail, profileId) {
  const filters = subjectFilters(accountId, accountEmail, profileId);
  return filters.length ? "or=(" + filters.join(",") + ")" : "";
}

async function authenticatedAccount(event) {
  const token = bearerToken(event);
  if (!token) return null;
  if (!hasSupabaseAuth()) {
    const error = new Error("Supabase Auth is not configured for payment identity verification");
    error.status = 503;
    throw error;
  }

  const response = await fetch(supabaseBase() + "/auth/v1/user", {
    method: "GET",
    headers: {
      apikey: supabaseAnonKey(),
      Authorization: "Bearer " + token
    }
  });
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch (_error) { body = bodyText; }
  }
  if (!response.ok || !body || !body.id) {
    const error = new Error("Sign in again before buying access");
    error.status = 401;
    error.body = body;
    throw error;
  }

  let account = null;
  const rowsByAuth = await supabaseFetch("app_accounts?select=*&auth_user_id=eq." + encodeFilter(body.id) + "&limit=1", { method: "GET" }).catch(function () { return []; });
  account = Array.isArray(rowsByAuth) ? rowsByAuth[0] : null;
  const accountEmail = email(body.email);
  if (!account && accountEmail) {
    const rowsByEmail = await supabaseFetch("app_accounts?select=*&email=eq." + encodeFilter(accountEmail) + "&limit=1", { method: "GET" }).catch(function () { return []; });
    account = Array.isArray(rowsByEmail) ? rowsByEmail[0] : null;
  }
  if (!account || !account.account_id) {
    const error = new Error("Authenticated account is not linked to Clarity Caddy yet");
    error.status = 401;
    throw error;
  }
  return account;
}

function paymentAuthRequired(options) {
  options = options || {};
  if (options.requireAuth === true) return true;
  if (env("CLARITY_ALLOW_LEGACY_PAYMENT_ACCOUNT_PAYLOAD") === "1") return false;
  return hasSupabaseAuth();
}

async function resolveAccount(payload, options) {
  options = options || {};
  const authAccount = await authenticatedAccount(options.event);
  if (authAccount) return authAccount;
  if (paymentAuthRequired(options)) {
    const error = new Error("Sign in with Supabase Auth before buying access");
    error.status = 401;
    throw error;
  }

  const accountId = text(payload && (payload.accountId || payload.userId || payload.account_id || payload.user_id), 120);
  const accountEmail = email(payload && (payload.email || payload.accountEmail || payload.account_email));
  if (!accountId && !accountEmail) {
    const error = new Error("Sign in before buying access");
    error.status = 401;
    throw error;
  }
  let account = null;
  if (accountId) {
    const rows = await supabaseFetch("app_accounts?select=*&account_id=eq." + encodeFilter(accountId) + "&limit=1", { method: "GET" });
    account = Array.isArray(rows) ? rows[0] : null;
  }
  if (!account && accountEmail) {
    const rows = await supabaseFetch("app_accounts?select=*&email=eq." + encodeFilter(accountEmail) + "&limit=1", { method: "GET" });
    account = Array.isArray(rows) ? rows[0] : null;
  }
  if (!account || !account.account_id) {
    const error = new Error("Sign in before buying access");
    error.status = 401;
    throw error;
  }
  return account;
}

// Resolve an account for endpoints that must NOT hard-require a live JWT - e.g.
// the referral dashboard, where a stale/unverifiable token would otherwise 401
// even though the user is a known account.
//
// A verified Supabase-Auth token still wins when one is present: it is the
// strongest identity we have, and it means an authenticated caller carrying no
// X-Clarity-Account-* header (the common case) resolves instead of 401'ing, and
// cannot be talked into acting as someone else by a spoofed payload accountId.
// Only when there is no usable token do we fall back to client-supplied identity
// (payload accountId/email or the X-Clarity-Account-* headers) - the same trust
// model the rest of Caddie already uses, and resolveAccount's own fallback.
async function resolveAccountByIdentity(payload, event) {
  const authAccount = await authenticatedAccount(event).catch(function () { return null; });
  if (authAccount) return authAccount;

  const headers = (event && event.headers) || {};
  const headerId = text(headers["x-clarity-account-id"] || headers["X-Clarity-Account-Id"], 120);
  const headerEmail = email(headers["x-clarity-account-email"] || headers["X-Clarity-Account-Email"]);
  const accountId = text(payload && (payload.accountId || payload.userId || payload.account_id || payload.user_id), 120) || headerId;
  const accountEmail = email(payload && (payload.email || payload.accountEmail || payload.account_email)) || headerEmail;
  if (!accountId && !accountEmail) {
    const error = new Error("Sign in before continuing");
    error.status = 401;
    throw error;
  }
  let account = null;
  if (accountId) {
    const rows = await supabaseFetch("app_accounts?select=*&account_id=eq." + encodeFilter(accountId) + "&limit=1", { method: "GET" });
    account = Array.isArray(rows) ? rows[0] : null;
  }
  if (!account && accountEmail) {
    const rows = await supabaseFetch("app_accounts?select=*&email=eq." + encodeFilter(accountEmail) + "&limit=1", { method: "GET" });
    account = Array.isArray(rows) ? rows[0] : null;
  }
  if (!account || !account.account_id) {
    const error = new Error("Sign in before continuing");
    error.status = 401;
    throw error;
  }
  return account;
}

function accountCustomerId(account) {
  return text(account && (account.stripe_customer_id || account.metadata && account.metadata.stripe_customer_id), 200);
}

async function storeAccountCustomerId(account, customerId) {
  const accountId = text(account && account.account_id, 120);
  if (!accountId || !customerId) return;
  const now = new Date().toISOString();
  try {
    await supabaseFetch("app_accounts?account_id=eq." + encodeFilter(accountId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ stripe_customer_id: customerId, updated_at: now })
    });
  } catch (_error) {
    const metadata = Object.assign({}, account && account.metadata || {}, { stripe_customer_id: customerId });
    await supabaseFetch("app_accounts?account_id=eq." + encodeFilter(accountId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ metadata, updated_at: now })
    });
  }
}

async function ensureStripeCustomer(account) {
  const existingId = accountCustomerId(account);
  if (existingId) {
    try {
      const existing = await stripeFetch("GET", "/v1/customers/" + encodeURIComponent(existingId), {});
      if (existing && !existing.deleted) return existing;
    } catch (_error) {
      // Fall through and create a replacement if the stored customer id is stale.
    }
  }
  const customer = await stripeFetch("POST", "/v1/customers", {
    email: email(account && account.email),
    name: text(account && account.name, 120),
    "metadata[app]": "clarity-caddie",
    "metadata[user_id]": text(account && account.account_id, 120),
    "metadata[account_email]": email(account && account.email)
  });
  if (customer && customer.id) await storeAccountCustomerId(account, customer.id);
  return customer;
}

function rowProductKey(row) {
  return normaliseProductKey(row && (row.product_key || row.entitlement_type || row.metadata && row.metadata.product_key));
}

function isPaidEntitlement(row) {
  return !!PAID_ACCESS_KEYS[rowProductKey(row)];
}

/* True when access was granted by Apple or Google rather than Stripe or an admin.
   Used to keep store-billed members off web billing management, since their
   subscription can only be cancelled in the store account that owns it. */
function isStoreEntitlement(row) {
  return !!STORE_ACCESS_KEYS[rowProductKey(row)];
}

function entitlementIsLive(row, nowMs) {
  if (!row || String(row.status || "").toLowerCase() !== "active") return false;
  const starts = row.starts_at ? new Date(row.starts_at).getTime() : 0;
  const expires = row.expires_at ? new Date(row.expires_at).getTime() : Infinity;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (Number.isFinite(starts) && starts > now) return false;
  return Number.isFinite(expires) ? expires > now : true;
}

function membershipAccessState(row, nowMs) {
  if (!row) return { active: false, state: "free_access" };
  const status = String(row.status || "").toLowerCase();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const accessUntil = row.access_until ? new Date(row.access_until).getTime() : NaN;
  const graceUntil = row.grace_until ? new Date(row.grace_until).getTime() : NaN;
  if (MEMBERSHIP_ACCESS_STATUSES[status] && Number.isFinite(accessUntil) && accessUntil > now) {
    return { active: true, state: row.cancel_at_period_end ? "membership_ending" : "membership_active" };
  }
  if (status === MEMBERSHIP_GRACE_STATUS && Number.isFinite(graceUntil) && graceUntil > now) {
    return { active: true, state: "payment_problem_grace" };
  }
  return { active: false, state: "free_access" };
}

function membershipBlocksNewCheckout(row, nowMs) {
  if (!row) return false;
  const status = String(row.status || "").toLowerCase();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (MEMBERSHIP_BLOCKING_STATUSES[status]) return true;
  const periodEnd = row.current_period_end || row.access_until;
  const periodEndMs = periodEnd ? new Date(periodEnd).getTime() : NaN;
  return !!(row.cancel_at_period_end && Number.isFinite(periodEndMs) && periodEndMs > now);
}

function stripeSubscriptionBlocksNewCheckout(subscription, nowMs) {
  if (!subscription || subscription.deleted) return false;
  const status = String(subscription.status || "").toLowerCase();
  if (MEMBERSHIP_BLOCKING_STATUSES[status]) return true;
  const periodEnd = Number(subscription.current_period_end) * 1000;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return !!(subscription.cancel_at_period_end && Number.isFinite(periodEnd) && periodEnd > now);
}

async function activeMembershipRows(accountId, accountEmail) {
  const filter = subjectOrFilter(accountId, accountEmail, "");
  if (!filter) return [];
  try {
    const rows = await supabaseFetch("caddie_memberships?select=*&" + filter + "&order=updated_at.desc&limit=20", { method: "GET" });
    return Array.isArray(rows) ? rows : [];
  } catch (_error) {
    return [];
  }
}

async function readPaidAccess(identity) {
  const accountId = text(identity && (identity.accountId || identity.userId || identity.account_id || identity.user_id), 120);
  const accountEmail = email(identity && (identity.email || identity.accountEmail || identity.account_email));
  const profileId = text(identity && (identity.profileId || identity.profile_id), 120);
  const checkedAt = new Date();
  const nowMs = checkedAt.getTime();
  const filter = subjectOrFilter(accountId, accountEmail, profileId);
  let entitlements = [];
  let paidRows = [];
  if (filter) {
    const rows = await supabaseFetch("user_entitlements?select=*&" + filter + "&order=expires_at.desc.nullsfirst,created_at.desc&limit=100", { method: "GET" });
    paidRows = (Array.isArray(rows) ? rows : []).filter(isPaidEntitlement);
    entitlements = paidRows.filter(function (row) {
      return isPaidEntitlement(row) && entitlementIsLive(row, nowMs);
    });
  }
  const memberships = await activeMembershipRows(accountId, accountEmail);
  const membership = memberships.filter(function (row) {
    return membershipAccessState(row, nowMs).active;
  })[0] || memberships[0] || null;
  const membershipState = membershipAccessState(membership, nowMs);
  let paymentState = "free_access";
  if (membershipState.active) {
    paymentState = membershipState.state;
  } else if (entitlements.some(function (row) { return rowProductKey(row) === ADMIN_COMPED_MEMBERSHIP_KEY || row && row.entitlement_reason === ADMIN_COMPED_MEMBERSHIP_KEY; })) {
    paymentState = "admin_comped_membership_active";
  } else if (entitlements.some(function (row) { return rowProductKey(row) === STORE_MEMBERSHIP_KEY; })) {
    /* A paid store subscription outranks a free referral month: if a user holds
       both, they are a paying member. These keys are new, so no pre-existing row
       can match here and the branches below keep their current behaviour. */
    paymentState = "store_membership_active";
  } else if (entitlements.some(function (row) { return rowProductKey(row) === STORE_MONTH_PASS_KEY; })) {
    paymentState = "store_month_pass_active";
  } else if (entitlements.some(function (row) { return rowProductKey(row) === REFERRAL_ACCESS_KEY || rowProductKey(row) === "referral" || row && row.entitlement_reason === "referral_free_month"; })) {
    paymentState = "referral_access_active";
  } else if (entitlements.some(function (row) { return rowProductKey(row) === MONTH_PASS_KEY; })) {
    paymentState = "month_pass_active";
  } else if (entitlements.length) {
    paymentState = "legacy_access_active";
  } else if (membership || paidRows.length) {
    paymentState = "paid_access_expired";
  }
  return {
    configured: true,
    active: !!(membershipState.active || entitlements.length),
    paymentState,
    entitlements,
    membership,
    memberships,
    checkedAt: checkedAt.toISOString()
  };
}

module.exports = {
  MEMBERSHIP_BLOCKING_STATUSES,
  MONTHLY_MEMBERSHIP_KEY,
  MONTH_PASS_HOURS,
  MONTH_PASS_KEY,
  ADMIN_COMPED_MEMBERSHIP_KEY,
  PAID_PERMISSION_KEYS,
  PASS_CONFIG,
  REFERRAL_ACCESS_KEY,
  STORE_ACCESS_KEYS,
  STORE_MEMBERSHIP_KEY,
  STORE_MONTH_PASS_KEY,
  STRIPE_API_VERSION,
  accountCustomerId,
  appUrl,
  authenticatedAccount,
  bearerToken,
  email,
  encodeFilter,
  ensureStripeCustomer,
  entitlementWindow,
  env,
  hasSupabase,
  hasSupabaseAuth,
  isPaidEntitlement,
  isStoreEntitlement,
  isStripePriceId,
  json,
  membershipAccessState,
  membershipBlocksNewCheckout,
  monthPassWindow,
  normaliseProductKey,
  passPriceId,
  passType,
  paymentProduct,
  productDurationHours,
  productPriceId,
  readPaidAccess,
  resolveAccount,
  resolveAccountByIdentity,
  rowProductKey,
  stripeFetch,
  stripeSubscriptionBlocksNewCheckout,
  subjectOrFilter,
  supabaseAnonKey,
  supabaseFetch,
  text
};
