"use strict";
const { email, hasAuth, json, supabaseAuth, upsertAccount } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");
exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }
  if (!hasAuth()) return json(503, { error: "Supabase Auth is not configured. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY." });
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
    await sendSystemAlert({ eventType: "supabase_auth_login_failed", title: "Supabase Auth login failed", detail: "A login attempt failed Supabase Auth confirmation.", accountEmail, context: { status: error.status || null, details: error.body || error.message } });
    return json(error.status || 401, { error: error.status === 400 ? "Email or password does not match" : (error.message || "Could not sign in with Supabase Auth"), details: error.body || null });
  }
};
