"use strict";

const {
  hasSupabase,
  json,
  resolveAccount,
  text
} = require("./payment-utils");
const referrals = require("./referral-service");
const { sendSystemAlert } = require("./alert-utils");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  if (!hasSupabase()) {
    return json(503, { error: "Supabase is not configured for referrals" });
  }

  let payload = {};
  if (event.httpMethod === "POST") {
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (_error) {
      return json(400, { error: "Invalid JSON" });
    }
  }

  const action = event.httpMethod === "GET" ? "dashboard" : text(payload.action || "dashboard", 80);

  try {
    if (action === "open") {
      const token = text(payload.referralToken || payload.token || payload.ref, 500);
      const result = await referrals.openReferralToken(token, { event });
      return json(200, result);
    }

    const account = await resolveAccount(payload, { event, requireAuth: true });

    if (action === "dashboard") {
      const result = await referrals.getReferralDashboard(account);
      return json(200, result);
    }
    if (action === "createInvite") {
      const result = await referrals.createReferralInvite(account, { event, payload });
      return json(200, result);
    }
    if (action === "accept") {
      const token = text(payload.referralToken || payload.token || payload.ref, 500);
      const result = await referrals.acceptReferralInvite(account, token, { event });
      return json(200, result);
    }
    if (action === "revokeInvite") {
      const result = await referrals.revokeReferralInvite(account, payload.referralId || payload.invitationId, payload.reason || "");
      return json(200, result);
    }

    return json(400, { error: "Unsupported referral action" });
  } catch (error) {
    // Only alert on genuine server faults. Routine client/auth failures - a
    // stale or malformed token hitting the dashboard (401), bad input (400) -
    // are expected and must not email an admin alert on every request, or an
    // unauthenticated poll floods the inbox.
    const status = error && error.status;
    if (!status || status >= 500) {
      await sendSystemAlert({
        eventType: "referral_action_failed",
        title: "Referral action failed",
        detail: "A referral endpoint action could not complete.",
        accountEmail: payload && (payload.email || payload.accountEmail),
        context: { action, status: status || null, details: error.body || error.message || String(error) }
      }).catch(function () {});
    }
    return json(error.status || 502, {
      error: error && error.message ? error.message : "Referral action failed",
      details: error.body || null
    });
  }
};
