"use strict";

const {
  email,
  encodeFilter,
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");
const { sendSystemAlert } = require("./alert-utils");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON" });
  }

  if (!hasSupabase()) {
    await sendSystemAlert({
      eventType: "supabase_not_configured",
      title: "Supabase payment storage is not configured",
      detail: "Payment entitlement checking was blocked because Supabase environment variables are missing.",
      accountEmail: payload.email || payload.accountEmail,
      context: { endpoint: "payment-entitlement" }
    });
    return json(503, {
      configured: false,
      active: false,
      entitlements: [],
      error: "Payment storage is not configured yet"
    });
  }

  const accountId = text(payload.accountId || payload.userId, 120);
  const accountEmail = email(payload.email || payload.accountEmail);
  const checkoutSessionId = text(payload.checkoutSessionId || payload.sessionId, 200);
  if (!accountId && !accountEmail && !checkoutSessionId) {
    return json(400, { error: "Account or checkout session is required" });
  }

  const now = new Date().toISOString();
  const filters = [];
  if (checkoutSessionId) filters.push("stripe_checkout_session_id.eq." + encodeFilter(checkoutSessionId));
  if (accountId) filters.push("user_id.eq." + encodeFilter(accountId));
  if (accountEmail) filters.push("account_email.eq." + encodeFilter(accountEmail));
  const orFilter = "(" + filters.join(",") + ")";
  const path = "user_entitlements?select=*&status=eq.active&or=" + orFilter + "&order=expires_at.desc.nullsfirst&limit=10";

  try {
    const rows = await supabaseFetch(path, { method: "GET" });
    const entitlements = (Array.isArray(rows) ? rows : []).filter(function (row) {
      return !row.expires_at || row.expires_at >= now;
    });
    return json(200, {
      configured: true,
      active: entitlements.length > 0,
      entitlements,
      checkedAt: now
    });
  } catch (error) {
    await sendSystemAlert({
      eventType: "supabase_payment_check_failed",
      title: "Supabase payment check failed",
      detail: "The app could not confirm whether a user has an active entitlement. Paid access should remain locked until this succeeds.",
      accountEmail: accountEmail,
      context: { accountId, checkoutSessionId, status: error.status || null, details: error.body || error.message || String(error) }
    });
    return json(error.status || 502, {
      error: "Could not check payment status",
      details: error.body || error.message || String(error)
    });
  }
};
