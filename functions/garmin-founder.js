"use strict";

/* Garmin Founder: recording that a signed-in player has used a Garmin watch.
 *
 * The phone calls this once the Clarity Caddy app on a Garmin has answered it
 * (scripts/clarity-garmin-founder.js decides when). It writes one permanent
 * user_entitlements row - product_key "garmin_founder", no expiry - and
 * answers with the player's Garmin Founder state.
 *
 * Who it is for comes from the bearer token and nothing else, the same rule
 * payment-entitlement follows: the body can describe the watch but never
 * names an account.
 *
 * WHAT THIS CANNOT PROVE. The watch has no identity of its own on the server
 * (it never talks to Supabase), so this endpoint trusts the signed-in phone
 * that a Garmin answered it. Someone determined could call it without a watch.
 * That is accepted: what it unlocks is small, it is never paid access, and
 * there is no stronger proof available without the watch signing in itself.
 *
 * Calling it again is harmless: an existing active row is returned untouched,
 * so the first connection date is the one that is kept. */

const {
  GARMIN_FOUNDER_KEY,
  authenticatedAccount,
  encodeFilter,
  garminFounderRow,
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");

const PLATFORMS = { ios: true, android: true };

function founderState(row) {
  return {
    garminFounder: row
      ? { active: true, since: row.starts_at || row.created_at || null }
      : { active: false, since: null }
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Account storage is not configured" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_error) {
    return json(400, { error: "Invalid JSON" });
  }

  let account = null;
  try {
    account = await authenticatedAccount(event);
  } catch (error) {
    return json(error.status || 401, { error: "Sign in to link your Garmin", code: "token_required" });
  }
  if (!account) return json(401, { error: "Sign in to link your Garmin", code: "token_required" });

  const accountId = text(account.account_id, 120);
  const accountEmail = text(account.email, 240).toLowerCase();

  try {
    const existing = await supabaseFetch(
      "user_entitlements?select=*&user_id=eq." + encodeFilter(accountId)
        + "&product_key=eq." + GARMIN_FOUNDER_KEY + "&limit=5",
      { method: "GET" }
    );
    const current = garminFounderRow(existing);
    if (current) return json(200, Object.assign({ created: false }, founderState(current)));

    const platform = text(payload.platform, 20).toLowerCase();
    const now = new Date().toISOString();
    const rows = await supabaseFetch("user_entitlements", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: accountId,
        account_email: accountEmail || null,
        profile_id: account.profile_id || null,
        entitlement_type: GARMIN_FOUNDER_KEY,
        product_key: GARMIN_FOUNDER_KEY,
        status: "active",
        starts_at: now,
        expires_at: null,
        source_type: "garmin",
        entitlement_reason: "garmin_connected",
        non_renewing: true,
        referral_eligible: false,
        metadata: {
          platform: PLATFORMS[platform] ? platform : "",
          deviceModel: text(payload.deviceModel, 80),
          firstConnectedAt: now
        }
      })
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return json(200, Object.assign({ created: true }, founderState(row || { starts_at: now })));
  } catch (error) {
    return json(error.status || 502, { error: "Could not link your Garmin" });
  }
};
