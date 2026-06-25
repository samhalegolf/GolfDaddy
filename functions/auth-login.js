"use strict";
const { email, findAccountByEmail, hasAuth, hasAuthWithServiceKey, json, supabaseAuth, upsertAccount } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");
exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }
  if (!hasAuth()) return json(503, { error: "Supabase Auth is not configured. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY.", code: "auth_not_configured" });
  const accountEmail = email(body.email); const password = String(body.password || "");
  if (!accountEmail) return json(400, { error: "Enter a valid email" });
  if (!password) return json(400, { error: "Enter your password" });
  try {
    const token = await supabaseAuth("token?grant_type=password", { method: "POST", body: JSON.stringify({ email: accountEmail, password }) }, false);
    const authUser = token && token.user;
    if (!authUser || !authUser.id) return json(401, { error: "Supabase Auth did not return a user" });
    const pack = await upsertAccount(authUser, { email: accountEmail, name: authUser.user_metadata && authUser.user_metadata.name, role: authUser.user_metadata && authUser.user_metadata.role, eventType: "supabase_auth_login" });
    return json(200, { ok: true, source: "supabase_auth", account: pack.account, profile: pack.profile, session: { access_token: token.access_token, refresh_token: token.refresh_token, expires_at: token.expires_at, token_type: token.token_type } });
  } catch (error) {
    if (error.status === 400 && accountEmail && hasAuthWithServiceKey()) {
      try {
        const account = await findAccountByEmail(accountEmail);
        if (!account) return json(404, { error: "Account does not exist.", code: "account_not_found", details: error.body || null });
      } catch (_lookupError) {}
    }
    await sendSystemAlert({ eventType: "supabase_auth_login_failed", title: "Supabase Auth login failed", detail: "A login attempt failed Supabase Auth confirmation.", accountEmail, context: { status: error.status || null, details: error.body || error.message } });
    const message = error.status === 400
      ? "Incorrect password. If this is right after a password change, clear local auth state and sign in again."
      : (error.message || "Could not sign in with Supabase Auth");
    const status = error.status || 401;
    return json(status, { error: message, code: "sign_in_failed", details: error.body || error.message || null });
  }
};
