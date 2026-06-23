"use strict";

const { email, env, hasSupabase, json, supabaseFetch, text, encodeFilter } = require("./payment-utils");

function authorised(event) {
  const token = text(process.env.CLARITY_ADMIN_DIAGNOSTICS_TOKEN, 240);
  if (!token) return false;
  const header = text(event.headers && (event.headers.authorization || event.headers.Authorization), 300);
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const query = event.queryStringParameters || {};
  return bearer === token || text(query.token, 240) === token;
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!authorised(event)) return json(401, { error: "Admin diagnostics token required" });
  if (!hasSupabase()) return json(503, { configured: false, error: "Supabase is not configured" });

  let payload = {};
  if (event.httpMethod === "POST") {
    try { payload = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }
  }
  const query = event.queryStringParameters || {};
  const accountEmail = email(payload.email || query.email);
  const accountId = text(payload.accountId || query.accountId, 120);
  const response = { configured: true, checkedAt: new Date().toISOString(), account: null, profile: null, activeEntitlements: [], recentSyncEvents: [], recentPaymentEvents: [] };

  try {
    if (accountEmail || accountId) {
      const filters = [];
      if (accountEmail) filters.push("email.eq." + encodeFilter(accountEmail));
      if (accountId) filters.push("account_id.eq." + encodeFilter(accountId));
      const accounts = await supabaseFetch("app_accounts?select=account_id,profile_id,auth_user_id,email,name,role,last_login_at,created_at,updated_at&or=(" + filters.join(",") + ")&limit=1", { method: "GET" });
      response.account = Array.isArray(accounts) && accounts[0] || null;
      const profileId = response.account && response.account.profile_id;
      if (profileId) {
        const profiles = await supabaseFetch("app_profiles?select=profile_id,account_id,auth_user_id,email,name,permission,handedness,handicap,updated_at&profile_id=eq." + encodeFilter(profileId) + "&limit=1", { method: "GET" });
        response.profile = Array.isArray(profiles) && profiles[0] || null;
      }
      const entitlements = await supabaseFetch("user_entitlements?select=id,user_id,account_email,entitlement_type,status,starts_at,expires_at,stripe_checkout_session_id,created_at&status=eq.active&or=(account_email.eq." + encodeFilter(accountEmail || (response.account && response.account.email) || "") + ",user_id.eq." + encodeFilter(accountId || (response.account && response.account.account_id) || "") + ")&order=created_at.desc&limit=10", { method: "GET" });
      response.activeEntitlements = Array.isArray(entitlements) ? entitlements : [];
      const syncEvents = await supabaseFetch("app_sync_events?select=account_id,profile_id,event_type,status,payload_json,created_at&order=created_at.desc&limit=10" + (accountId ? "&account_id=eq." + encodeFilter(accountId) : ""), { method: "GET" });
      response.recentSyncEvents = Array.isArray(syncEvents) ? syncEvents : [];
    } else {
      const syncEvents = await supabaseFetch("app_sync_events?select=account_id,profile_id,event_type,status,payload_json,created_at&order=created_at.desc&limit=10", { method: "GET" });
      response.recentSyncEvents = Array.isArray(syncEvents) ? syncEvents : [];
    }
    const paymentEvents = await supabaseFetch("payment_events?select=stripe_event_id,event_type,processed_at,created_at&order=created_at.desc&limit=10", { method: "GET" });
    response.recentPaymentEvents = Array.isArray(paymentEvents) ? paymentEvents : [];
    return json(200, response);
  } catch (error) {
    return json(error.status || 502, { error: "Diagnostics failed", details: error.body || error.message || String(error) });
  }
};
