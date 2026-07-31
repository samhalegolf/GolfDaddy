"use strict";

const {
  authenticatedAccount,
  hasSupabase,
  json,
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
  /* Filled in once the caller is authenticated, so the failure alert below names
     whoever the token actually belongs to. It used to report payload.email,
     which is now unauthenticated attacker input - and an alert that echoes it
     lets a stranger put any address they like into our admin inbox. */
  let actingEmail = "";

  try {
    /* The one genuinely public action. The referral token IS the credential
       here - a caller who has the link is the person the link was sent to - so
       no sign-in is required to see what an invitation offers. The preview it
       returns deliberately carries nothing about the invitee; see
       invitationPreview in referral-service.js. */
    if (action === "open") {
      const token = text(payload.referralToken || payload.token || payload.ref, 500);
      const result = await referrals.openReferralToken(token, { event });
      return json(200, result);
    }

    /* Everything below reads or writes one member's referral state, so the
       caller has to prove who they are.
     *
     * Until 2026-07-27 this called resolveAccountByIdentity, which preferred a
     * verified token but fell back to client-supplied identity when there was
     * no usable one: payload.accountId / payload.email, or the
     * X-Clarity-Account-Id / X-Clarity-Account-Email request headers. None of
     * those are authenticated. An unauthenticated caller who knew another
     * member's account id or email address - an email address is not a secret -
     * was treated as that member: able to read their referral dashboard, which
     * lists the email address of every friend they invited, and to create,
     * accept and revoke invitations in their name.
     *
     * The fallback existed so that a stale access token would not 401 the
     * dashboard for a known account. That case is no longer real: every shipped
     * client reaches this endpoint through authedHeaders(), which refreshes an
     * expired token before the request and retries once with a force-refreshed
     * one after a 401 (scripts/clarity-payments.js, mirrored into the iOS and
     * Android bundles). So identity now comes from a validated Supabase token
     * and nothing else, with no fallback - the fallback was the hole.
     *
     * authenticatedAccount returns null only when no token was sent at all; a
     * token that fails validation throws its own 401, and a server missing
     * SUPABASE_ANON_KEY throws 503 rather than quietly trusting the payload. */
    const account = await authenticatedAccount(event);
    if (!account) return json(401, { error: "Sign in to manage referrals", code: "token_required" });
    actingEmail = text(account.email, 240);

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
        accountEmail: actingEmail,
        context: { action, status: status || null, details: error.body || error.message || String(error) }
      }).catch(function () {});
    }
    return json(error.status || 502, {
      error: error && error.message ? error.message : "Referral action failed",
      details: error.body || null
    });
  }
};
