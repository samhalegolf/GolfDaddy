"use strict";

/* The account's player profiles, for restoring a device that has lost them.
 *
 * WHY THIS EXISTS
 *
 * The player list lives in localStorage under gd_player_profiles_v27 and nothing
 * ever read it back from the server. Sync is one-directional: clarity-cloud-sync
 * pushes the active profile up, and account-sync returns exactly one profile -
 * the one app_accounts.profile_id points at - so a device with an empty list had
 * no way to discover the others.
 *
 * That turned every localStorage wipe into data loss the user could see: the
 * player list rendered 0, the app minted a fresh profile with a new random id
 * (gdNewProfileId picks "player" + a two-digit number), pushed it up, and the
 * account gained another orphan. One account had accumulated seven profiles all
 * named "Sam Hale" that way before this endpoint existed.
 *
 * IDENTITY IS TAKEN FROM THE TOKEN, NEVER FROM THE BODY.
 *
 * Same rule as account-delete.js and account-clear-data.js. An account id in the
 * body would let anyone read anyone else's player list.
 *
 * READ-ONLY BY CONSTRUCTION
 *
 * This handler issues no writes at all. Restoring a lost list is a read; if it
 * could also write, a bug here could damage the very records it exists to
 * recover. dev/profile-hydrate.test.js asserts the absence of write verbs.
 *
 * profile_json is returned verbatim because it holds the original client-side
 * profile object that clarity-cloud-sync uploaded. Restoring from it round-trips
 * fields the flat columns never captured, and the columns are returned alongside
 * as a fallback for rows written before profile_json existed.
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
    return json(401, { error: "Sign in again to restore your players", code: "token_required" });
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

  const accountId = accountRow && accountRow.account_id || "";
  if (!accountId) {
    /* A signed-in user with no account row has nothing to restore. Not an error:
       the client treats an empty list as "keep what you have". */
    return json(200, { ok: true, accountId: "", activeProfileId: "", profiles: [] });
  }

  let rows = [];
  try {
    rows = await supabaseRest(
      "app_profiles?select=profile_id,name,handedness,handicap,permission,bag_json,profile_json,updated_at" +
        "&account_id=eq." + encodeFilter(accountId) + "&order=updated_at.desc",
      { method: "GET" }
    );
  } catch (_error) {
    return json(502, { error: "Could not load your players. Try again.", code: "profiles_failed" });
  }

  return json(200, {
    ok: true,
    accountId,
    activeProfileId: accountRow.profile_id || "",
    profiles: Array.isArray(rows) ? rows : []
  });
};
