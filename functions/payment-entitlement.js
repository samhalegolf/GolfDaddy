"use strict";

const {
  authenticatedAccount,
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
      /* No account is named: nobody has been authenticated at this point (we
         cannot, without Supabase), and the request body is unauthenticated input
         - echoing it here would let a stranger put any address they like into
         the admin inbox. */
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

  /* Echoed back to the caller so the post-checkout return flow can correlate the
     response with the redirect it came from. It is the caller's own input and is
     never used to look anything up. */
  const checkoutSessionId = text(payload.checkoutSessionId || payload.sessionId, 200);

  /* Whose payment state is being read.
   *
   * Until 2026-07-27 this came from the request body - payload.accountId /
   * payload.userId / payload.email / payload.accountEmail - with no
   * authentication anywhere in the handler. Anyone who knew a member's email
   * address, which is not a secret, could POST it here and receive that member's
   * complete payment state: the raw user_entitlements and caddie_memberships
   * rows, carrying Stripe subscription and invoice identifiers, billing period
   * dates, grace periods and entitlement metadata.
   *
   * It is now read from a validated Supabase access token and nothing else, so
   * you can only ever ask about yourself. The body no longer names an account at
   * all; profile_id comes off the resolved account row, which is what keeps
   * profile-scoped entitlements resolving.
   *
   * There is deliberately no unauthenticated path. The old handler accepted a
   * request carrying only a checkoutSessionId, but that never worked: the
   * session id was echoed and never queried, so with no account identity
   * readPaidAccess had nothing to filter on and returned a blank "free_access"
   * result. Requiring a token turns a meaningless 200 into an honest 401, and
   * the real return flow (refresh({sessionId}) after the Stripe redirect) is
   * signed in - buying requires it. */
  let account = null;
  try {
    account = await authenticatedAccount(event);
  } catch (error) {
    /* Its own catch, ahead of the readPaidAccess one below, for two reasons: an
       expired or rejected token is a routine client condition that must not fire
       the admin alert that catch sends, and the throw has to be handled at all -
       authenticatedAccount rejects on a bad token rather than returning null, so
       calling it bare would reject the whole handler. */
    return json(error.status || 401, {
      error: error && error.message ? error.message : "Sign in to check payment access",
      code: "token_required"
    });
  }
  if (!account) return json(401, { error: "Sign in to check payment access", code: "token_required" });
  const accountId = text(account.account_id, 120);
  const accountEmail = account.email || "";

  try {
    const result = await readPaidAccess({
      accountId,
      accountEmail,
      profileId: account.profile_id || ""
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
