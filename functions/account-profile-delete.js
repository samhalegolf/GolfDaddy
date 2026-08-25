"use strict";

/* Delete one spare profile row from the caller's own account.
 *
 * WHY THIS EXISTS
 *
 * One account can carry several app_profiles rows. They accumulate from test
 * runs and from the storage-wipe loop described in account-profiles.js - the
 * app minted a replacement profile with a fresh id and the old row stayed
 * behind. The live admin account had four.
 *
 * Deleting locally is not enough on its own: account-profiles.js hands the
 * whole list back whenever a device loses its storage, so a row deleted only on
 * the phone reappears on the next restore. This is the missing server half.
 *
 * IDENTITY IS TAKEN FROM THE TOKEN, NEVER FROM THE BODY.
 *
 * Same rule as account-profiles.js and account-delete.js. An account id in the
 * body would let anyone delete anyone else's profiles.
 *
 * IT CANNOT DELETE THE ACCOUNT'S LIVE PROFILE.
 *
 * app_accounts.profile_id points at the row the account signs in as. Removing
 * it would leave the account pointing at nothing, and the app would mint a
 * replacement on next launch - the very loop this endpoint exists to drain.
 * Deleting the account itself is account-delete.js's job, and it asks for more
 * confirmation than this does.
 */

const { hasAuth, hasAuthWithServiceKey, json, supabaseAuth, supabaseRest } = require("./auth-utils");

function encodeFilter(value) { return encodeURIComponent(String(value || "")); }

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }

  if (!hasAuth() || !hasAuthWithServiceKey()) {
    return json(503, { error: "Supabase is not configured", code: "auth_not_configured" });
  }

  const accessToken = String(body.accessToken || body.access_token || "").trim();
  if (!accessToken) {
    return json(401, { error: "Sign in again to remove a profile", code: "token_required" });
  }

  const profileId = String(body.profileId || body.profile_id || "").trim();
  if (!profileId) {
    return json(400, { error: "No profile given", code: "profile_required" });
  }

  let authUser;
  try {
    authUser = await supabaseAuth("user", {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken }
    }, false);
  } catch (_error) {
    return json(401, { error: "Your session has expired. Sign in again.", code: "invalid_token" });
  }

  if (!authUser || !authUser.id) {
    return json(401, { error: "Your session has expired. Sign in again.", code: "invalid_token" });
  }

  const authUserId = String(authUser.id);
  const accountEmail = String(authUser.email || "").toLowerCase();

  let accountRow = null;
  try {
    const byAuthId = await supabaseRest(
      "app_accounts?select=account_id,profile_id&auth_user_id=eq." + encodeFilter(authUserId) + "&limit=1",
      { method: "GET" }
    );
    accountRow = Array.isArray(byAuthId) && byAuthId[0] || null;
    if (!accountRow && accountEmail) {
      const byEmail = await supabaseRest(
        "app_accounts?select=account_id,profile_id&email=eq." + encodeFilter(accountEmail) + "&limit=1",
        { method: "GET" }
      );
      accountRow = Array.isArray(byEmail) && byEmail[0] || null;
    }
  } catch (_error) {
    return json(502, { error: "Could not reach the account store. Try again.", code: "lookup_failed" });
  }

  const accountId = accountRow && String(accountRow.account_id || "") || "";
  if (!accountId) {
    return json(404, { error: "No account found for this sign-in", code: "account_not_found" });
  }

  if (profileId === String(accountRow.profile_id || "")) {
    return json(400, {
      error: "That is the profile you sign in as. Delete the account instead.",
      code: "live_profile"
    });
  }

  /* Ownership is re-checked against the row itself, not inferred from the
     request. The delete filter carries the account id too, so even a race
     cannot reach a row belonging to someone else. */
  let target = null;
  try {
    const rows = await supabaseRest(
      "app_profiles?select=profile_id,account_id&profile_id=eq." + encodeFilter(profileId) + "&limit=1",
      { method: "GET" }
    );
    target = Array.isArray(rows) && rows[0] || null;
  } catch (_error) {
    return json(502, { error: "Could not load that profile. Try again.", code: "lookup_failed" });
  }

  if (!target) {
    /* Already gone. The caller wanted it gone, so this is success. */
    return json(200, { ok: true, deleted: false, profileId });
  }

  if (String(target.account_id || "") !== accountId) {
    return json(403, { error: "That profile belongs to another account", code: "not_yours" });
  }

  try {
    await supabaseRest(
      "app_profiles?profile_id=eq." + encodeFilter(profileId) + "&account_id=eq." + encodeFilter(accountId),
      { method: "DELETE", headers: { Prefer: "return=minimal" } }
    );
  } catch (_error) {
    return json(502, { error: "Could not remove that profile. Try again.", code: "delete_failed" });
  }

  return json(200, { ok: true, deleted: true, profileId });
};
