"use strict";

const {
  ADMIN_COMPED_MEMBERSHIP_KEY,
  MONTHLY_MEMBERSHIP_KEY,
  MONTH_PASS_KEY,
  authenticatedAccount,
  email,
  encodeFilter,
  env,
  hasSupabase,
  isStripePriceId,
  json,
  normaliseProductKey,
  productPriceId,
  supabaseFetch,
  text
} = require("./payment-utils");
const { sendSystemAlert } = require("./alert-utils");
const { sendCompedAccessEmail } = require("./email-notification");

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
    if (!auth) return json(401, { error: "Sign in as an admin to manage payments", code: "token_required" });

    /* GET is gated too. readSettings used to run before the isAdmin check, so it
       returned product configuration, webhook failure counts and which server
       secrets are present to any caller at all - a free reconnaissance endpoint
       even without the write access below. */
    if (!auth.isAdmin) return json(403, { error: "Admin access required" });

    if (event.httpMethod === "GET") return await readSettings(auth);
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

    const payload = parseBody(event);

    if (payload.action === "upsertProduct") return await upsertProduct(payload.product, auth);
    if (payload.action === "setProductActive") return await setProductActive(payload.productKey, payload.active, auth);
    if (payload.action === "issueFreePass") return await issueFreePass(payload, auth);
    if (payload.action === "queryEntitlements") return await queryEntitlements(payload, auth);
    if (payload.action === "listIssuedPasses") return await listIssuedPasses(payload, auth);
    if (payload.action === "listUsers") return await listUsers(payload, auth);
    if (payload.action === "manualGrantPermission") return await manualGrantPermission(payload, auth);
    if (payload.action === "manualRevokePermission") return await manualRevokePermission(payload, auth);
    if (payload.action === "seedDefaults") return await seedDefaults(auth);

    return json(400, { error: "Unknown payment admin action" });
  } catch (error) {
    // Alert only on genuine server faults (5xx or an unexpected throw with no
    // status). Client/auth failures (401/403 stale token, 400 bad input) are
    // expected and must not email an alert per request - a reloading admin
    // screen otherwise floods the inbox.
    const status = error && error.status;
    if (!status || status >= 500) {
      await sendSystemAlert({
        eventType: "payment_admin_failed",
        title: "Payment admin action failed",
        detail: error && error.message ? error.message : "Payment admin failed",
        context: { status: status || null, details: error.body || String(error) }
      }).catch(function () {});
    }
    return json(error.status || 500, { error: error && error.message ? error.message : "Payment admin failed", details: error.body || null });
  }
};

function parseBody(event) {
  try { return JSON.parse(event.body || "{}"); } catch (_error) { return {}; }
}

/* Who is calling, and what are they allowed to do.
 *
 * Until 2026-07-27 this read the X-Clarity-Account-Id / X-Clarity-Account-Email
 * REQUEST HEADERS, looked the account up, and handed back admin if that row said
 * admin. Nothing proved the caller owned the account, and the headers are
 * attacker-supplied - so an unauthenticated POST carrying the admin's email
 * address was full billing-admin access: issuing free memberships, granting and
 * revoking entitlements, rewriting product configuration. An email address is
 * not a secret; ours is printed on our own privacy and support pages.
 *
 * Identity now comes from a validated Supabase access token and nothing else.
 * authenticatedAccount() checks the bearer token against /auth/v1/user and
 * returns the app_accounts row for the user that token actually belongs to, so
 * the role is read from the database for a caller we have proven. Headers are
 * ignored entirely - there is deliberately no fallback, because a fallback is
 * exactly the hole being closed here.
 *
 * Returns null when there is no usable token; the caller turns that into a 401.
 */
async function adminContext(event) {
  const account = await authenticatedAccount(event);
  if (!account) return null;
  const role = String(account.role || "").toLowerCase();
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

/* Everything an admin has issued by hand - comped memberships, promotional free
   passes and manual grants - newest first. Exists so the admin screen can show
   what is currently out there without the admin having to remember who to look
   up. Stripe-purchased entitlements are deliberately excluded; they have their
   own diagnostics. Read-only, so it is not written to payment_admin_events -
   logging every screen load would bury the actual grant/revoke audit trail. */
async function listIssuedPasses(payload, auth) {
  const limit = Number(payload && payload.limit || 50);
  const resolvedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const adminSources = "or=(source_type.eq.admin_free_pass,source_type.eq.admin_comped_membership,entitlement_reason.eq.admin_manual_grant,entitlement_reason.eq.admin_comped_membership)";
  const rows = await supabaseFetch(
    "user_entitlements?select=id,user_id,account_email,entitlement_type,product_key,status,starts_at,expires_at,entitlement_reason,metadata,created_at&" + adminSources + "&order=created_at.desc&limit=" + resolvedLimit,
    { method: "GET" }
  );
  return json(200, { ok: true, passes: Array.isArray(rows) ? rows : [] });
}

/* The whole user base with each person's access state: who they are, when they
   signed up, what pass they hold, when it ends and how it is paying. Reads the
   same three tables the entitlement resolver reads and merges them here, so the
   admin screen gets one row per account instead of doing N lookups. Read-only,
   so not audit-logged (same reasoning as listIssuedPasses). Capped at 500
   accounts / 1000 entitlements - revisit with pagination if the user base
   outgrows that, and the cap is stated in the response so the screen can say
   so instead of silently truncating. */
async function listUsers(payload, auth) {
  const accounts = await supabaseFetch("app_accounts?select=account_id,profile_id,email,name,role,created_at,last_login_at,stripe_customer_id&order=created_at.desc&limit=500", { method: "GET" });
  const entitlements = await supabaseFetch("user_entitlements?select=user_id,account_email,profile_id,product_key,entitlement_type,status,starts_at,expires_at,source_type,entitlement_reason&order=created_at.desc&limit=1000", { method: "GET" }).catch(function () { return []; });
  const memberships = await supabaseFetch("caddie_memberships?select=user_id,account_email,status,access_until,grace_until,current_period_end&limit=500", { method: "GET" }).catch(function () { return []; });
  const nowMs = Date.now();

  const stillLive = (value) => !value || new Date(value).getTime() > nowMs;
  const entitlementLabel = (row) => {
    const key = String(row.product_key || row.entitlement_type || "");
    const reason = String(row.entitlement_reason || row.source_type || "");
    if (key === "month_pass" || key === "store_month_pass") return "Month Pass";
    if (key === "admin_comped_membership" || reason.indexOf("admin_comped") !== -1) return "Comped Membership";
    if (key === "referral_membership" || reason.indexOf("referral") !== -1) return "Referral month";
    if (key === "free_pass" || reason.indexOf("free_pass") !== -1) return "Free pass";
    return "Paid access";
  };

  const users = (Array.isArray(accounts) ? accounts : []).map((acct) => {
    const mine = (Array.isArray(entitlements) ? entitlements : []).filter((row) =>
      (row.user_id && row.user_id === acct.account_id)
      || (row.account_email && acct.email && row.account_email === acct.email)
      || (row.profile_id && acct.profile_id && row.profile_id === acct.profile_id));
    const activeRows = mine.filter((row) => String(row.status || "") === "active" && stillLive(row.expires_at));
    const membership = (Array.isArray(memberships) ? memberships : []).find((row) =>
      (row.user_id && row.user_id === acct.account_id)
      || (row.account_email && acct.email && row.account_email === acct.email)) || null;
    const membershipLive = !!membership && (
      ["active", "trialing"].indexOf(String(membership.status || "")) !== -1
      || (membership.grace_until && new Date(membership.grace_until).getTime() > nowMs)
    );
    /* "Best" = the active entitlement that lasts longest; no-expiry beats dated. */
    const best = activeRows.slice().sort((a, b) => {
      const aEnd = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
      const bEnd = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
      return bEnd - aEnd;
    })[0] || null;
    const activeStarts = activeRows.map((row) => row.starts_at).filter(Boolean).sort();

    let access = "None";
    let expiresAt = null;
    let paymentStatus = "";
    if (membershipLive) {
      access = "Membership";
      expiresAt = membership.current_period_end || membership.access_until || null;
      paymentStatus = String(membership.status || "active");
    } else if (best) {
      access = entitlementLabel(best);
      expiresAt = best.expires_at || null;
      paymentStatus = String(best.status || "active");
    }

    return {
      accountId: acct.account_id,
      email: acct.email || "",
      name: acct.name || "",
      role: acct.role || "player",
      signedUpAt: acct.created_at || "",
      lastLoginAt: acct.last_login_at || "",
      stripeCustomer: !!acct.stripe_customer_id,
      active: membershipLive || !!best,
      access: access,
      memberSince: activeStarts[0] || null,
      expiresAt: expiresAt,
      paymentStatus: paymentStatus
    };
  });

  return json(200, { ok: true, users: users, capped: users.length >= 500 });
}

async function manualGrantPermission(payload, auth) {
  const accountId = text(payload.accountId || payload.targetAccountId, 120);
  const accountEmail = email(payload.accountEmail || payload.email || payload.targetEmail);
  const profileId = text(payload.profileId, 120);
  const permissionKey = text(payload.permissionKey || payload.entitlementType, 120);
  const allowMemberReferrals = permissionKey === ADMIN_COMPED_MEMBERSHIP_KEY && boolFlag(payload.allowMemberReferrals, true);
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
      product_key: permissionKey,
      status: "active",
      starts_at: starts.toISOString(),
      expires_at: expires ? expires.toISOString() : null,
      entitlement_reason: permissionKey === ADMIN_COMPED_MEMBERSHIP_KEY ? ADMIN_COMPED_MEMBERSHIP_KEY : "admin_manual_grant",
      referral_eligible: allowMemberReferrals,
      usage_count: 0,
      metadata: {
        source: permissionKey === ADMIN_COMPED_MEMBERSHIP_KEY ? ADMIN_COMPED_MEMBERSHIP_KEY : "admin_manual_grant",
        note: notes,
        granted_by: auth.account && auth.account.email || "admin",
        permission_key: permissionKey,
        entitlement_reason: permissionKey === ADMIN_COMPED_MEMBERSHIP_KEY ? ADMIN_COMPED_MEMBERSHIP_KEY : "admin_manual_grant",
        allow_member_referrals: allowMemberReferrals
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
  const isCompedMembership = productKey === ADMIN_COMPED_MEMBERSHIP_KEY;
  const allowMemberReferrals = isCompedMembership && boolFlag(payload.allowMemberReferrals, true);
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
      product_key: productKey,
      status: "active",
      starts_at: starts.toISOString(),
      expires_at: expires.toISOString(),
      source_type: isCompedMembership ? ADMIN_COMPED_MEMBERSHIP_KEY : "admin_free_pass",
      entitlement_reason: isCompedMembership ? ADMIN_COMPED_MEMBERSHIP_KEY : productKey,
      referral_eligible: allowMemberReferrals,
      non_renewing: true,
      metadata: {
        source: isCompedMembership ? ADMIN_COMPED_MEMBERSHIP_KEY : "admin_free_pass",
        entitlement_reason: isCompedMembership ? ADMIN_COMPED_MEMBERSHIP_KEY : productKey,
        note: text(payload.note, 500),
        issued_by: auth.account && auth.account.email || "admin",
        duration_hours: cleanHours,
        membership_level: isCompedMembership,
        allow_member_referrals: allowMemberReferrals
      }
    })
  });
  /* Notify the recipient, after the entitlement is safely written. A failed
     email is reported in emailStatus but never fails the request - the pass
     exists either way, and claiming otherwise is how this screen used to lie.
     The template branches on whether the address already has an account
     (gift email) or not (welcome email whose CTA is a set-password link that
     doubles as their first login). Untick "Email them about it" on the form
     for silent comps like the App Store review account. */
  let emailStatus = "skipped";
  if (boolFlag(payload.sendEmail, true) && accountEmail) {
    try {
      const accountRows = await supabaseFetch("app_accounts?select=account_id,name&email=eq." + encodeFilter(accountEmail) + "&limit=1", { method: "GET" });
      const existingAccount = Array.isArray(accountRows) ? accountRows[0] : null;
      const days = Math.round(cleanHours / 24);
      const result = await sendCompedAccessEmail({
        to: accountEmail,
        recipientName: existingAccount && existingAccount.name || "",
        hasAccount: !!existingAccount,
        membership: isCompedMembership,
        periodLabel: days >= 28 && days <= 31 ? "a month" : days + " days",
        expiresLabel: expires.toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" }),
        issuedByName: "Clarity Golf"
      });
      emailStatus = result && result.sent ? "sent" : "skipped";
    } catch (_error) {
      emailStatus = "failed";
    }
  }

  await logAdmin(auth, "issue_free_pass", { accountEmail, accountId, productKey, hours: cleanHours, emailStatus });
  return json(200, { ok: true, message: "Free pass issued", emailStatus });
}

function boolFlag(value, defaultValue) {
  if (value === undefined || value === null || value === "") return !!defaultValue;
  if (value === true || value === "true" || value === "on" || value === "1") return true;
  if (value === false || value === "false" || value === "off" || value === "0") return false;
  return !!defaultValue;
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
    monthPassPriceConfigured: isStripePriceId(productPriceId(monthPass, MONTH_PASS_KEY)),
    monthlyMembershipPriceConfigured: isStripePriceId(productPriceId(membership, MONTHLY_MEMBERSHIP_KEY)),
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
