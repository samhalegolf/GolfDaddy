"use strict";

/* Update the signed-in user's own account.
 *
 * IDENTITY AND PRIVILEGE BOTH COME FROM THE SERVER, NEVER FROM THE BODY.
 *
 * Until 2026-07-27 this handler read `supabaseUserId` out of the POST body and
 * passed it to the Supabase Admin API with the service role key. Nothing proved
 * the caller owned that account, so an unauthenticated POST carrying someone
 * else's user id could set their password, or move their email to an
 * attacker-controlled address. Either one is a full account takeover.
 *
 * It also accepted `role` from the body, and app_accounts.role is what
 * payment-admin.js reads to decide who is an admin - so a player could hand
 * themselves the admin role in the same request. The account form only renders
 * the role selector for admins, but that is a client-side check and a crafted
 * request never goes near it.
 *
 * Both are closed the same way: the access token is validated against Supabase,
 * and the user id being modified is the one from the validated token (a
 * mismatched id in the body is refused rather than ignored, so a confused client
 * fails loudly instead of quietly editing the wrong account).
 *
 * Role is authorised against the role already stored for the caller: only an
 * account that is ALREADY an admin may set one, which keeps the admin's own
 * account-type control working while making the escalation impossible. Everyone
 * else keeps whatever role the database says they have, whatever they ask for.
 *
 * Token validation matches auth-restore-account.js: /auth/v1/user returns the
 * user the token belongs to, or 401 when it is invalid or expired.
 */

const {
  email, hasAuth, hasAuthWithServiceKey, json, role, supabaseAuth, supabaseRest, text, upsertAccount
} = require("./auth-utils");

function encodeFilter(value) { return encodeURIComponent(String(value || "")); }

/* The role already on the account. Read server-side so the request cannot
   nominate one. Returns "" when there is no row yet, which lets accountPayload
   fall back to its own default rather than inventing a privilege here. */
async function currentRole(authUserId, accountEmail) {
  try {
    const byAuthId = await supabaseRest(
      "app_accounts?select=role&auth_user_id=eq." + encodeFilter(authUserId) + "&limit=1",
      { method: "GET" }
    );
    if (Array.isArray(byAuthId) && byAuthId[0] && byAuthId[0].role) return byAuthId[0].role;
    if (accountEmail) {
      const byEmail = await supabaseRest(
        "app_accounts?select=role&email=eq." + encodeFilter(accountEmail) + "&limit=1",
        { method: "GET" }
      );
      if (Array.isArray(byEmail) && byEmail[0] && byEmail[0].role) return byEmail[0].role;
    }
  } catch (_error) {
    /* A failed lookup must not become an escalation. Falling through with ""
       lets the existing row's role stand during the upsert. */
  }
  return "";
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }

  if (!hasAuth() || !hasAuthWithServiceKey()) return json(503, { error: "Supabase Auth is not configured" });

  const accessToken = String(body.accessToken || body.access_token || "").trim();
  if (!accessToken) {
    return json(401, { error: "Sign in again to update your account", code: "token_required" });
  }

  let tokenUser;
  try {
    tokenUser = await supabaseAuth("user", {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken }
    }, false);
  } catch (_error) {
    return json(401, { error: "Your session has expired. Sign in again.", code: "invalid_token" });
  }
  if (!tokenUser || !tokenUser.id) {
    return json(401, { error: "Your session has expired. Sign in again.", code: "invalid_token" });
  }

  const userId = String(tokenUser.id);

  /* A body id that disagrees with the token is refused outright. Silently using
     the token's id would hide a client bug; refusing makes it visible, and an
     attacker supplying someone else's id gets nothing either way. */
  const claimedUserId = text(body.supabaseUserId || body.userId, 120);
  if (claimedUserId && claimedUserId !== userId) {
    return json(403, { error: "You can only update your own account", code: "user_mismatch" });
  }

  const accountEmail = email(body.email);
  const name = text(body.name, 160);
  const password = String(body.password || "");

  /* The role on record decides both what this account is and whether it is
     allowed to change that. A lookup failure yields "", which is not "admin",
     so the failure mode is refusing the change rather than granting it. */
  const storedRole = await currentRole(userId, email(tokenUser.email));
  const requestedRole = body.role ? role(body.role) : "";
  const nextRole = (storedRole === "admin" && requestedRole) ? requestedRole : storedRole;

  const update = { user_metadata: { name, role: nextRole || "player" } };
  if (accountEmail) update.email = accountEmail;
  const passwordUpdated = !!password;
  if (password) {
    if (password.length < 8) return json(400, { error: "Password needs at least 8 characters" });
    update.password = password;
  }

  const authUser = await supabaseAuth("admin/users/" + encodeURIComponent(userId), {
    method: "PUT",
    body: JSON.stringify(update)
  }, true);

  /* nextRole is the authorised value, never the requested one. Passing "" lets
     accountPayload fall back to the existing row rather than defaulting the
     account down to player on a lookup failure. */
  const pack = await upsertAccount(authUser && (authUser.user || authUser), {
    email: accountEmail,
    name,
    role: nextRole || undefined,
    eventType: "supabase_auth_update"
  });

  return json(200, { ok: true, passwordUpdated, account: pack.account, profile: pack.profile });
};
