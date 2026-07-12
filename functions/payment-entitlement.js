"use strict";

const {
  hasSupabase,
  json,
  readPaidAccess,
  text
} = require("./payment-utils");
const { sendSystemAlert } = require("./alert-utils");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_error) {
    return json(400, { error: "Invalid JSON" });
  }

  if (!hasSupabase()) {
    await sendSystemAlert({
      eventType: "supabase_not_configured",
      title: "Supabase payment storage is not configured",
      detail: "Payment entitlement checking was skipped because Supabase environment variables are missing.",
      accountEmail: payload.email || payload.accountEmail,
      context: { endpoint: "payment-entitlement" }
    });
    return json(200, {
      configured: false,
      active: false,
      paymentState: "free_access",
      entitlements: [],
      membership: null,
      checkedAt: new Date().toISOString(),
      message: "Payment storage is not configured yet"
    });
  }

  const accountId = text(payload.accountId || payload.userId, 120);
  const accountEmail = payload.email || payload.accountEmail;
  const checkoutSessionId = text(payload.checkoutSessionId || payload.sessionId, 200);
  if (!accountId && !accountEmail && !checkoutSessionId) {
    return json(400, { error: "Account or checkout session is required" });
  }

  try {
    const result = await readPaidAccess({
      accountId,
      accountEmail,
      profileId: payload.profileId
    });
    return json(200, Object.assign({}, result, { checkoutSessionId: checkoutSessionId || null }));
  } catch (error) {
    await sendSystemAlert({
      eventType: "supabase_payment_check_failed",
      title: "Supabase payment check failed",
      detail: "The app could not confirm whether a user has active paid access. Paid features should remain locked until this succeeds.",
      accountEmail,
      context: { accountId, checkoutSessionId, status: error.status || null, details: error.body || error.message || String(error) }
    });
    return json(error.status || 502, {
      error: "Could not check payment status",
      details: error.body || error.message || String(error)
    });
  }
};
