"use strict";

/* Clear golf data, keep the account.
 *
 * Play's Data safety form asks whether users can request that "some or all of
 * their data is deleted, without requiring them to delete their account". Until
 * this existed the honest answer was no: account-delete.js was all-or-nothing,
 * so a player who wanted a clean slate had to destroy their sign-in and their
 * paid membership along with it.
 *
 * This is the middle option. It is deliberately NOT a second delete endpoint
 * with a softer name - the account, the sign-in and anything the player paid for
 * all survive, and that difference is the whole point.
 *
 * IDENTITY IS TAKEN FROM THE TOKEN, NEVER FROM THE BODY.
 *
 * Same rule as account-delete.js, for the same reason: an account id in the body
 * would let anyone wipe anyone else's rounds by guessing an id. The token is
 * validated against Supabase and every row touched is resolved from it.
 *
 * WHAT IS CLEARED VS KEPT
 *
 * Cleared: golf history - practice imports and shots, launch monitor readings,
 * captured surfaces, shot library batches, the sync log and client error
 * reports.
 *
 * Kept: the account and sign-in, the player profile and bag setup, purchases,
 * entitlements and referral records, and any course maps published to the shared
 * library. Course maps stay for the same reason they survive account deletion -
 * other players are using them.
 *
 * The kept/cleared split is stated on /delete-account.html and privacy.html.
 * Those pages and this list have to change together, or the app claims one thing
 * and the policy another.
 *
 * NOTE ON app_accounts / app_profiles
 *
 * Neither is touched here, and dev/account-clear-data.test.js asserts that. A
 * clear that removed the account row would silently be a deletion, which is the
 * one outcome a user choosing this option is explicitly trying to avoid.
 */

const { hasAuth, hasAuthWithServiceKey, json, supabaseAuth, supabaseRest } = require("./auth-utils");

function encodeFilter(value) { return encodeURIComponent(String(value || "")); }

/* Golf history, keyed by account_id. Mirrors ACCOUNT_ID_TABLES in
   account-delete.js minus referral_analytics_events, which is referral
   accounting rather than golf data and survives for the same reason the reward
   ledger does. */
const GOLF_DATA_TABLES = [
  "app_sync_events",
  "captured_surfaces",
  "client_error_events",
  "practice_import_batches",
  "practice_native_shots",
  "practice_email_intake_events",
  "shot_library_batches"
];

/* Rows this endpoint must never touch. Asserted by the test rather than only
   documented, because the failure mode - a "clear" that quietly deletes the
   account - is invisible until a user reports losing their membership. */
const PROTECTED_TABLES = ["app_accounts", "app_profiles", "user_entitlements", "caddie_memberships"];

async function deleteWhere(table, column, value) {
  /* PostgREST refuses an unfiltered DELETE, but an empty value would build
     "column=eq." and match rows with an empty string rather than none. */
  if (!value) return 0;
  if (PROTECTED_TABLES.indexOf(table) !== -1) {
    throw new Error("Refusing to delete from protected table " + table);
  }
  await supabaseRest(
    table + "?" + column + "=eq." + encodeFilter(value),
    { method: "DELETE", headers: { Prefer: "return=minimal" } }
  );
  return 1;
}

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
    return json(401, { error: "Sign in again to clear your data", code: "token_required" });
  }

  /* CLEAR, not DELETE. The two flows sit next to each other in the same settings
     menu and destroy different amounts, so they must not share a confirmation
     word - muscle memory from one would otherwise carry into the other. */
  if (String(body.confirm || "").trim().toUpperCase() !== "CLEAR") {
    return json(400, { error: "Clearing was not confirmed", code: "confirm_required" });
  }

  let authUser;
  try {
    authUser = await supabaseAuth("user", {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken }
    }, false);
  } catch (_error) {
    return json(401, { error: "Your session has expired. Sign in again to clear your data.", code: "invalid_token" });
  }

  if (!authUser || !authUser.id) {
    return json(401, { error: "Your session has expired. Sign in again to clear your data.", code: "invalid_token" });
  }

  const authUserId = String(authUser.id);
  const accountEmail = String(authUser.email || "").toLowerCase();

  let accountRow = null;
  try {
    const byAuthId = await supabaseRest(
      "app_accounts?select=account_id,profile_id,email&auth_user_id=eq." + encodeFilter(authUserId) + "&limit=1",
      { method: "GET" }
    );
    accountRow = Array.isArray(byAuthId) && byAuthId[0] || null;
    if (!accountRow && accountEmail) {
      const byEmail = await supabaseRest(
        "app_accounts?select=account_id,profile_id,email&email=eq." + encodeFilter(accountEmail) + "&limit=1",
        { method: "GET" }
      );
      accountRow = Array.isArray(byEmail) && byEmail[0] || null;
    }
  } catch (_error) {
    return json(502, { error: "Could not reach the account store. Try again.", code: "lookup_failed" });
  }

  const accountId = accountRow && accountRow.account_id || "";
  if (!accountId) {
    /* No account row means nothing server-side to clear. The client still wipes
       its local golf data, so this is a success rather than an error - reporting
       failure here would leave the user retrying something already done. */
    return json(200, { ok: true, cleared: true, tables: 0 });
  }

  let cleared = 0;
  try {
    for (const table of GOLF_DATA_TABLES) {
      cleared += await deleteWhere(table, "account_id", accountId);
    }
  } catch (_error) {
    return json(502, {
      error: "Your data could not be fully cleared. Nothing else was changed - please try again, or email samhalegolf@gmail.com.",
      code: "clear_failed"
    });
  }

  return json(200, { ok: true, cleared: true, tables: cleared });
};
