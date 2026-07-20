"use strict";

/* Restore an app account onto a device that does not have it locally.
 *
 * The gap this closes: a coach-invited user opens the setup link on a fresh
 * phone. The client looks for their account in local storage, does not find it,
 * and there was no way to fetch it - the fallback it called (ClarityCloudSync
 * .restoreAccounts) was never defined, so the user was told "we could not find
 * this account" with no recourse.
 *
 * The security gate is the Supabase access token that the recovery/setup email
 * link carries. This endpoint NEVER trusts an email from the client: it validates
 * the token against Supabase /auth/v1/user, and returns only the account that
 * token's verified identity owns. So it cannot be used to enumerate or fetch
 * anyone else's account - the token is the proof, not a client-supplied email.
 *
 * Once the account is verified it is upserted the same way a login does, so the
 * device gets exactly the account+profile shape it would after signing in.
 */

const { email, hasAuth, hasAuthWithServiceKey, json, supabaseAuth, upsertAccount } = require("./auth-utils");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }

  if (!hasAuth() || !hasAuthWithServiceKey()) {
    return json(503, { error: "Supabase Auth is not configured", code: "auth_not_configured" });
  }

  const accessToken = String(body.accessToken || body.access_token || "").trim();
  if (!accessToken) {
    /* No token means no proof of identity. Deliberately not falling back to an
       email lookup - that is the enumeration vector this design avoids. */
    return json(400, { error: "A recovery token is required to restore an account", code: "token_required" });
  }

  try {
    /* Validate the token. /auth/v1/user returns the user the token belongs to,
       or 401 if it is invalid or expired. The anon apikey stays in place; the
       user token overrides the Authorization header. */
    const authUser = await supabaseAuth("user", {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken }
    }, false);

    if (!authUser || !authUser.id) {
      return json(401, { error: "This recovery link is no longer valid. Request a new one.", code: "invalid_token" });
    }

    /* Upsert the same way login does, so the caller gets an identical
       account+profile pack and the Supabase record is the source of truth. */
    const pack = await upsertAccount(authUser, {
      email: email(authUser.email),
      name: authUser.user_metadata && authUser.user_metadata.name,
      role: authUser.user_metadata && authUser.user_metadata.role,
      eventType: "supabase_auth_restore"
    });

    return json(200, { ok: true, source: "supabase_auth_restore", account: pack.account, profile: pack.profile });
  } catch (error) {
    const status = error && error.status;
    if (status === 401 || status === 403) {
      return json(401, { error: "This recovery link is no longer valid. Request a new one.", code: "invalid_token" });
    }
    return json(status || 502, {
      error: "Could not restore this account",
      code: "restore_failed",
      details: error && (error.body || error.message) || String(error)
    });
  }
};
