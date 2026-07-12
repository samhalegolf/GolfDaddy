"use strict";

const {
  MONTHLY_MEMBERSHIP_KEY,
  MONTH_PASS_KEY,
  email,
  encodeFilter,
  env,
  hasSupabase,
  json,
  normaliseProductKey,
  productPriceId,
  supabaseFetch,
  text
} = require("./payment-utils");
const { sendSystemAlert } = require("./alert-utils");

const PRODUCT_FIELDS = "id,product_key,product_kind,name,description,stripe_product_id,stripe_price_id,price_label,duration_hours,billing_schedule,active,colour,sort_order,metadata,created_at,updated_at";
const DEFAULT_PRODUCTS = [
  { product_key: MONTH_PASS_KEY, product_kind: "month_pass", name: "One Month Pass", description: "One payment for 30 days full access. No automatic renewal.", price_label: "One month", duration_hours: 720, billing_schedule: "one_time", active: true, colour: "green", sort_order: 10 },
  { product_key: MONTHLY_MEMBERSHIP_KEY, product_kind: "membership", name: "Monthly Membership", description: "Full access with monthly renewal. Cancel anytime.", price_label: "Monthly", duration_hours: 720, billing_schedule: "monthly", active: false, colour: "blue", sort_order: 20 }
];

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });

  try {
    const auth = await adminContext(event);
    if (event.httpMethod === "GET") return await readSettings(auth);
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

    const payload = parseBody(event);
    if (!auth.isAdmin) return json(403, { error: "Admin access required" });

    if (payload.action === "upsertProduct") return await upsertProduct(payload.product, auth);
    if (payload.action === "setProductActive") return await setProductActive(payload.productKey, payload.active, auth);
    if (payload.action === "issueFreePass") return await issueFreePass(payload, auth);
    if (payload.action === "queryEntitlements") return await queryEntitlements(payload, auth);
    if (payload.action === "manualGrantPermission") return await manualGrantPermission(payload, auth);
    if (payload.action === "manualRevokePermission") return await manualRevokePermission(payload, auth);
    if (payload.action === "seedDefaults") return await seedDefaults(auth);

    return json(400, { error: "Unknown payment admin action" });
  } catch (error) {
    await sendSystemAlert({
      eventType: "payment_admin_failed",
      title: "Payment admin action failed",
      detail: error && error.message ? error.message : "Payment admin failed",
      context: { status: error.status || null, details: error.body || String(error) }
    });
    return json(error.status || 500, { error: error && error.message ? error.message : "Payment admin failed", details: error.body || null });
  }
};

function parseBody(event) {
  try { return JSON.parse(event.body || "{}"); } catch (_error) { return {}; }
}

function header(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  return headers[name] || headers[lower] || "";
}

async function adminContext(event) {
  const accountId = text(header(event, "x-clarity-account-id"), 120);
  const accountEmail = email(header(event, "x-clarity-account-email"));
  let account = null;
  if (accountId) {
    const rows = await supabaseFetch("app_accounts?select=account_id,email,name,role&account_id=eq." + encodeFilter(accountId) + "&limit=1", { method: "GET" });
    account = Array.isArray(rows) ? rows[0] : null;
  }
  if (!account && accountEmail) {
    const rows = await supabaseFetch("app_accounts?select=account_id,email,name,role&email=eq." + encodeFilter(accountEmail) + "&limit=1", { method: "GET" });
    account = Array.isArray(rows) ? rows[0] : null;
  }
  const role = String(account && account.role || "").toLowerCase();
  return {
    account,
    isAdmin: role === "admin",
    isStaff: role === "admin" || role === "coach"
  };
}

async function readSettings(auth) {
  await ensureDefaults();
  const products = await supabaseFetch("payment_products?select=" + PRODUCT_FIELDS + "&order=sort_order.asc,created_at.asc", { method: "GET" });
  const diagnostics = await paymentDiagnostics(products);
  return json(200, {
    ok: true,
    isAdmin: !!auth.isAdmin,
    isStaff: !!auth.isStaff,
    stripeConnected: !!env("STRIPE_SECRET_KEY"),
    webhookConfigured: !!env("STRIPE_WEBHOOK_SECRET"),
    alertEmailConfigured: !!env("CLARITY_ALERT_EMAIL"),
    monthPassPriceConfigured: diagnostics.monthPassPriceConfigured,
    monthlyMembershipPriceConfigured: diagnostics.monthlyMembershipPriceConfigured,
    subscriptionWebhookEventsConfigured: diagnostics.subscriptionWebhookEventsConfigured,
    subscriptionWebhookEventsNote: diagnostics.subscriptionWebhookEventsNote,
    billingPortalConfigured: diagnostics.billingPortalConfigured,
    billingPortalConfiguredNote: diagnostics.billingPortalConfiguredNote,
    recentWebhookFailures: diagnostics.recentWebhookFailures,
    unprocessedWebhookCount: diagnostics.unprocessedWebhookCount,
    pastDueMembershipCount: diagnostics.pastDueMembershipCount,
    gracePeriodMembershipCount: diagnostics.gracePeriodMembershipCount,
    products: Array.isArray(products) ? products : [],
    serverManagedSecrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY"]
  });
}

async function ensureDefaults() {
  for (const product of DEFAULT_PRODUCTS) {
    await supabaseFetch("payment_products?on_conflict=product_key", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(product)
    });
  }
}

async function seedDefaults(auth) {
  await ensureDefaults();
  await logAdmin(auth, "seed_defaults", {});
  return await readSettings(auth);
}

function cleanProduct(input) {
  input = input || {};
  const key = text(input.product_key || input.productKey, 80).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const kindRaw = text(input.product_kind || input.productKind || "day_pass", 40).toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const allowedKinds = { month_pass: true, day_pass: true, round_pass: true, membership: true, free_pass: true };
  const duration = Number(input.duration_hours || input.durationHours || 24);
  if (!key) throw Object.assign(new Error("Product key is required"), { status: 400 });
  return {
    product_key: key,
    product_kind: allowedKinds[kindRaw] ? kindRaw : "day_pass",
    name: text(input.name || key.replace(/_/g, " "), 120),
    description: text(input.description, 500),
    stripe_product_id: text(input.stripe_product_id || input.stripeProductId, 200) || null,
    stripe_price_id: text(input.stripe_price_id || input.stripePriceId, 200) || null,
    price_label: text(input.price_label || input.priceLabel, 80),
    duration_hours: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 100) / 100 : 24,
    billing_schedule: text(input.billing_schedule || input.billingSchedule || (kindRaw === "membership" ? "subscription" : "one_time"), 80),
    active: input.active !== false,
    colour: text(input.colour || input.color, 40),
    sort_order: Number.isFinite(Number(input.sort_order || input.sortOrder)) ? Number(input.sort_order || input.sortOrder) : 100,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
    updated_at: new Date().toISOString()
  };
}

async function upsertProduct(input, auth) {
  const product = cleanProduct(input);
  await supabaseFetch("payment_products?on_conflict=product_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(product)
  });
  await logAdmin(auth, "upsert_product", { product_key: product.product_key });
  return await readSettings(auth);
}

async function setProductActive(productKey, active, auth) {
  const key = text(productKey, 80).toLowerCase();
  if (!key) return json(400, { error: "Product key is required" });
  await supabaseFetch("payment_products?product_key=eq." + encodeFilter(key), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: !!active, updated_at: new Date().toISOString() })
  });
  await logAdmin(auth, "set_product_active", { product_key: key, active: !!active });
  return await readSettings(auth);
}

async function queryEntitlements(payload, auth) {
  const accountId = text(payload.accountId || payload.targetAccountId, 120);
  const accountEmail = email(payload.accountEmail || payload.email || payload.targetEmail);
  const limit = Number(payload.limit || 20);
  const resolvedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  if (!accountId && !accountEmail) return json(400, { error: "Account ID or email is required" });

  const filters = [];
  if (accountId) filters.push("user_id=eq." + encodeFilter(accountId));
  if (accountEmail) filters.push("account_email=eq." + encodeFilter(accountEmail));
  const orFilter = "(" + filters.join(",") + ")";
  const query = "user_entitlements?select=*&or=" + orFilter + "&order=created_at.desc&limit=" + resolvedLimit;

  const entitlements = await supabaseFetch(query, { method: "GET" });
  await logAdmin(auth, "query_entitlements", {
    accountId,
    accountEmail,
    count: Array.isArray(entitlements) ? entitlements.length : 0
  });
  return json(200, {
    ok: true,
    target: { accountId: accountId, accountEmail: accountEmail },
    entitlements: Array.isArray(entitlements) ? entitlements : []
  });
}

async function manualGrantPermission(payload, auth) {
  const accountId = text(payload.accountId || payload.targetAccountId, 120);
  const accountEmail = email(payload.accountEmail || payload.email || payload.targetEmail);
  const profileId = text(payload.profileId, 120);
  const permissionKey = text(payload.permissionKey || payload.entitlementType, 120);
  const notes = text(payload.notes || payload.note, 300);
  const starts = payload.startsAt ? new Date(payload.startsAt) : new Date();
  const hours = Number(payload.durationHours || payload.duration_hours || 0);
  const cleanHours = Number.isFinite(hours) && hours > 0 ? hours : 0;
  if (!accountId && !accountEmail) return json(400, { error: "Account ID or email is required" });
  if (!permissionKey) return json(400, { error: "permissionKey is required" });
  if (Number.isNaN(starts.getTime())) return json(400, { error: "Invalid startsAt" });
  const expires = payload.expiresAt ? new Date(payload.expiresAt) : (cleanHours > 0 ? new Date(starts.getTime() + cleanHours * 60 * 60 * 1000) : null);
  if (payload.expiresAt && Number.isNaN(expires.getTime())) return json(400, { error: "Invalid expiresAt" });

  await supabaseFetch("user_entitlements", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: accountId || null,
      account_email: accountEmail || null,
      profile_id: profileId || null,
      entitlement_type: permissionKey,
      status: "active",
      starts_at: starts.toISOString(),
      expires_at: expires ? expires.toISOString() : null,
      usage_count: 0,
      metadata: {
        source: "admin_manual_grant",
        note: notes,
        granted_by: auth.account && auth.account.email || "admin",
        permission_key: permissionKey
      }
    })
  });
  await logAdmin(auth, "manual_grant_permission", {
    accountId,
    accountEmail,
    profileId,
    permissionKey,
    notes
  });
  return json(200, { ok: true, message: "Manual grant created" });
}

async function manualRevokePermission(payload, auth) {
  const entitlementId = text(payload.entitlementId, 120);
  const accountId = text(payload.accountId || payload.targetAccountId, 120);
  const accountEmail = email(payload.accountEmail || payload.email || payload.targetEmail);
  const permissionKey = text(payload.permissionKey || payload.entitlementType, 120);
  if (!entitlementId && (!accountId && !accountEmail)) return json(400, { error: "entitlementId or target account is required" });
  if (!permissionKey && !entitlementId) return json(400, { error: "permissionKey is required when entitlementId is not supplied" });

  let patchTarget = "";
  if (entitlementId) {
    patchTarget = "id=eq." + encodeFilter(entitlementId);
  } else {
    const filters = [];
    if (accountId) filters.push("user_id=eq." + encodeFilter(accountId));
    if (accountEmail) filters.push("account_email=eq." + encodeFilter(accountEmail));
    if (permissionKey) filters.push("entitlement_type=eq." + encodeFilter(permissionKey));
    patchTarget = "and=(" + filters.join(",") + ")";
  }
  if (!patchTarget) return json(400, { error: "Unable to identify entitlement to revoke" });

  await supabaseFetch("user_entitlements?" + patchTarget, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "revoked",
      metadata: {
        source: "admin_manual_revoke",
        revoked_by: auth.account && auth.account.email || "admin",
        revoked_at: new Date().toISOString(),
        notes: text(payload.notes || payload.note, 300)
      }
    })
  });
  await logAdmin(auth, "manual_revoke_permission", {
    entitlementId,
    accountId,
    accountEmail,
    permissionKey
  });
  return json(200, { ok: true, message: "Manual revoke applied" });
}

async function issueFreePass(payload, auth) {
  const accountEmail = email(payload.accountEmail || payload.email);
  const accountId = text(payload.accountId || payload.userId, 120);
  const productKey = text(payload.productKey || "free_pass", 80).toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const hours = Number(payload.durationHours || payload.duration_hours || 24);
  const cleanHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  if (!accountEmail && !accountId) return json(400, { error: "Account email or account id is required" });

  const starts = payload.startsAt ? new Date(payload.startsAt) : new Date();
  const expires = payload.expiresAt ? new Date(payload.expiresAt) : new Date(starts.getTime() + cleanHours * 60 * 60 * 1000);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(expires.getTime())) return json(400, { error: "Invalid pass dates" });

  await supabaseFetch("user_entitlements", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: accountId || null,
      account_email: accountEmail || null,
      entitlement_type: productKey,
      status: "active",
      starts_at: starts.toISOString(),
      expires_at: expires.toISOString(),
      metadata: {
        source: "admin_free_pass",
        note: text(payload.note, 500),
        issued_by: auth.account && auth.account.email || "admin",
        duration_hours: cleanHours
      }
    })
  });
  await logAdmin(auth, "issue_free_pass", { accountEmail, accountId, productKey, hours: cleanHours });
  return json(200, { ok: true, message: "Free pass issued" });
}

async function logAdmin(auth, action, payload) {
  await supabaseFetch("payment_admin_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      admin_account_id: auth.account && auth.account.account_id || null,
      admin_email: auth.account && auth.account.email || null,
      action,
      payload_json: payload || {}
    })
  });
}

async function paymentDiagnostics(products) {
  const rows = Array.isArray(products) ? products : [];
  const monthPass = rows.find(function (row) { return normaliseProductKey(row.product_key) === MONTH_PASS_KEY; });
  const membership = rows.find(function (row) { return normaliseProductKey(row.product_key) === MONTHLY_MEMBERSHIP_KEY; });
  const recentWebhookFailures = await safeRows("stripe_webhook_events?select=stripe_event_id,event_type,error_message,updated_at&processing_status=eq.failed&order=updated_at.desc&limit=5");
  const unprocessed = await safeRows("stripe_webhook_events?select=stripe_event_id&processing_status=neq.processed&limit=500");
  const pastDue = await safeRows("caddie_memberships?select=user_id,grace_until&status=eq.past_due&limit=500");
  const now = Date.now();
  const grace = pastDue.filter(function (row) {
    const graceUntil = row && row.grace_until ? new Date(row.grace_until).getTime() : NaN;
    return Number.isFinite(graceUntil) && graceUntil > now;
  });
  return {
    monthPassPriceConfigured: !!productPriceId(monthPass, MONTH_PASS_KEY),
    monthlyMembershipPriceConfigured: !!productPriceId(membership, MONTHLY_MEMBERSHIP_KEY),
    subscriptionWebhookEventsConfigured: null,
    subscriptionWebhookEventsNote: "Verify the production Stripe endpoint event list in the Stripe Dashboard; this app can confirm the webhook secret, not the endpoint's selected events.",
    billingPortalConfigured: null,
    billingPortalConfiguredNote: "A portal session is created through Stripe at runtime. Confirm Customer Portal capabilities in the Stripe Dashboard.",
    recentWebhookFailures,
    unprocessedWebhookCount: unprocessed.length,
    pastDueMembershipCount: pastDue.length,
    gracePeriodMembershipCount: grace.length
  };
}

async function safeRows(path) {
  try {
    const rows = await supabaseFetch(path, { method: "GET" });
    return Array.isArray(rows) ? rows : [];
  } catch (_error) {
    return [];
  }
}
