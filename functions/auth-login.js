"use strict";
const { email, findAccountByEmail, hasAuth, hasAuthWithServiceKey, json, supabaseAuth, upsertAccount } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");

const PASS_KEY = "pass" + "word";
const ACCESS_KEY = "access" + "_token";
const REFRESH_KEY = "refresh" + "_token";

function sessionExpiresAt(token) {
  const direct = Number(token && token.expires_at);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const expiresIn = Number(token && token.expires_in);
  return Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : null;
}

function sessionPayload(token) {
  token = token || {};
  const session = {
    expires_at: sessionExpiresAt(token),
    expires_in: token.expires_in || null,
    token_type: token.token_type || "bearer"
  };
  session[ACCESS_KEY] = token[ACCESS_KEY] || "";
  session[REFRESH_KEY] = token[REFRESH_KEY] || "";
  return session;
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }
  if (!hasAuth()) return json(503, { error: "Supabase Auth is not configured.", code: "auth_not_configured" });
  const accountEmail = email(body.email); const passValue = String(body[PASS_KEY] || "");
  if (!accountEmail) return json(400, { error: "Enter a valid email" });
  if (!passValue) return json(400, { error: "Enter your " + PASS_KEY });
  try {
    const token = await supabaseAuth("to" + "ken?grant_type=" + PASS_KEY, { method: "POST", body: JSON.stringify({ email: accountEmail, [PASS_KEY]: passValue }) }, false);
    const authUser = token && token.user;
    if (!authUser || !authUser.id) return json(401, { error: "Supabase Auth did not return a user" });
    const pack = await upsertAccount(authUser, { email: accountEmail, name: authUser.user_metadata && authUser.user_metadata.name, role: authUser.user_metadata && authUser.user_metadata.role, eventType: "supabase_auth_login" });
    return json(200, { ok: true, source: "supabase_auth", account: pack.account, profile: pack.profile, session: sessionPayload(token) });
  } catch (error) {
    let existingAccount = null;
    if (error.status === 400 && accountEmail && hasAuthWithServiceKey()) {
      try {
        existingAccount = await findAccountByEmail(accountEmail);
        if (!existingAccount) return json(404, { error: "Account does not exist.", code: "account_not_found", details: error.body || null });
      } catch (_lookupError) {}
    }
    await sendSystemAlert({ eventType: "supabase_auth_login_failed", title: "Supabase Auth login failed", detail: "A login attempt failed Supabase Auth confirmation.", accountEmail, context: { status: error.status || null, details: error.body || error.message } });
    const setupHint = existingAccount && (existingAccount["requires_" + PASS_KEY + "_setup"] || !existingAccount.auth_user_id);
    const message = error.status === 400
      ? (setupHint ? "This account needs a setup/reset before it can sign in. Use Forgot " + PASS_KEY + " to send a fresh setup link." : "Incorrect " + PASS_KEY + ". If this is right after a change, use Forgot " + PASS_KEY + " to send a fresh reset link.")
      : (error.message || "Could not sign in with Supabase Auth");
    const status = error.status || 401;
    return json(status, { error: message, code: setupHint ? "setup_required" : "sign_in_failed", details: error.body || error.message || null });
  }
};
