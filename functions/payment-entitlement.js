"use strict";

const {
  email,
  encodeFilter,
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");

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
    return json(200, {
      configured: false,
      active: false,
      entitlements: [],
      message: "Payment storage is not configured yet"
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
    return json(error.status || 502, {
      error: "Could not check payment status",
      details: error.body || error.message || String(error)
    });
  }
};
