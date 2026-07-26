"use strict";

/* Account deletion.
 *
 * Play Console and App Store both require an in-app route to delete an account
 * for any app that lets you create one. The web route is documented at
 * /delete-account.html; this is the in-app half.
 *
 * IDENTITY IS TAKEN FROM THE TOKEN, NEVER FROM THE BODY.
 *
 * The caller sends a Supabase access token and nothing else that identifies an
 * account. The token is validated against Supabase, and every row this handler
 * touches is resolved from the account that token belongs to. An account id in
 * the request body is ignored entirely - accepting one would mean anyone could
 * delete anyone else's account by guessing an id, which is the single worst
 * failure mode this endpoint has. Same pattern as auth-restore-account.js.
 *
 * WHAT IS DELETED VS KEPT
 *
 * Hard-deleted: the account, profile, and all golf and personal data attached to
 * it - practice, shots, captures, sync events, entitlements, error reports.
 *
 * Kept but disconnected: purchase and referral records are retained because tax
 * and accounting law requires it, with the email scrubbed so they no longer
 * identify a person. Course maps contributed to the shared library stay
 * published - other players are using them - but lose the contributor block.
 * Both of these are stated on /delete-account.html and in privacy.html, so this
 * behaviour and the published policy have to change together.
 *
 * ORDER
 *
 * Data rows first, then the account row, then the Supabase auth user last. If a
 * later step fails the account still exists and the user can retry; deleting the
 * auth user first would strand rows with no way to identify them again.
 */

const { hasAuth, hasAuthWithServiceKey, json, supabaseAuth, supabaseRest } = require("./auth-utils");

function encodeFilter(value) { return encodeURIComponent(String(value || "")); }

/* Tables keyed by account_id, hard-deleted. */
const ACCOUNT_ID_TABLES = [
  "app_sync_events",
  "captured_surfaces",
  "client_error_events",
  "practice_import_batches",
  "practice_native_shots",
  "practice_email_intake_events",
  "referral_analytics_events",
  "shot_library_batches"
];

async function deleteWhere(table, column, value) {
  /* PostgREST refuses an unfiltered DELETE, but an empty value would build
     "column=eq." and match rows with an empty string rather than none, so the
     guard is here too. */
  if (!value) return 0;
  await supabaseRest(
    table + "?" + column + "=eq." + encodeFilter(value),
    { method: "DELETE", headers: { Prefer: "return=minimal" } }
  );
  return 1;
}

async function patchWhere(table, filter, patch) {
  await supabaseRest(
    table + "?" + filter,
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) }
  );
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
    return json(401, { error: "Sign in again to delete your account", code: "token_required" });
  }

  /* A deliberate second step. The token proves who is asking; this proves they
     meant it, so a stray POST from a retry or a mis-wired button cannot destroy
     an account. The UI sends it only after the user types DELETE. */
  if (String(body.confirm || "").trim().toUpperCase() !== "DELETE") {
    return json(400, { error: "Deletion was not confirmed", code: "confirm_required" });
  }

  let authUser;
  try {
    authUser = await supabaseAuth("user", {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken }
    }, false);
  } catch (_error) {
    return json(401, { error: "Your session has expired. Sign in again to delete your account.", code: "invalid_token" });
  }

  if (!authUser || !authUser.id) {
    return json(401, { error: "Your session has expired. Sign in again to delete your account.", code: "invalid_token" });
  }

  const authUserId = String(authUser.id);
  const accountEmail = String(authUser.email || "").toLowerCase();

  /* Resolve the account from the token's user id. Falling back to the email is
     safe because the email also comes from the validated token, never the body. */
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
  } catch (error) {
    return json(502, { error: "Could not reach the account store. Try again.", code: "lookup_failed" });
  }

  const accountId = accountRow && accountRow.account_id || "";
  const profileId = accountRow && accountRow.profile_id || "";

  try {
    if (accountId) {
      for (const table of ACCOUNT_ID_TABLES) {
        await deleteWhere(table, "account_id", accountId);
      }
    }
    if (profileId) {
      await deleteWhere("user_entitlements", "profile_id", profileId);
    }

    /* Retained, de-identified. Purchase and referral history has to survive for
       accounting, so the email comes out and the opaque ids stay. */
    if (accountId) {
      await patchWhere("caddie_memberships", "user_id=eq." + encodeFilter(accountId), { account_email: null });
      await patchWhere("referral_invitations", "inviter_account_id=eq." + encodeFilter(accountId), { inviter_account_email: null });
      await patchWhere("referral_invitations", "invitee_account_id=eq." + encodeFilter(accountId), { invitee_account_email: null });
      await patchWhere("referral_reward_ledger", "inviter_account_id=eq." + encodeFilter(accountId), { inviter_account_email: null });
      /* Shared course maps keep working for everyone else; the contributor block
         carries name, email and accountId, so it is emptied wholesale. */
      await patchWhere("course_maps", "published_by_json->>accountId=eq." + encodeFilter(accountId), { published_by_json: {} });
    }
    if (accountEmail) {
      await patchWhere("caddie_memberships", "account_email=eq." + encodeFilter(accountEmail), { account_email: null });
    }

    /* Profile and account rows last among the data, so a failure above leaves the
       account intact and retryable rather than half-erased and unidentifiable. */
    if (accountId) {
      await deleteWhere("app_profiles", "account_id", accountId);
      await deleteWhere("app_accounts", "account_id", accountId);
    }
  } catch (error) {
    return json(502, {
      error: "Your account could not be fully deleted. Nothing was lost - please email samhalegolf@gmail.com and we will finish it by hand.",
      code: "delete_failed"
    });
  }

  /* The auth user goes last. Once this succeeds the token is dead, so anything
     after it could not be retried by the same caller. */
  try {
    await supabaseAuth("admin/users/" + encodeURIComponent(authUserId), { method: "DELETE" }, true);
  } catch (error) {
    return json(502, {
      error: "Your data was deleted but your sign-in could not be removed. Please email samhalegolf@gmail.com so we can finish it.",
      code: "auth_delete_failed"
    });
  }

  return json(200, { ok: true, deleted: true });
};
