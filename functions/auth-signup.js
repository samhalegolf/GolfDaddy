"use strict";
const { email, hasAuth, json, role, supabaseAuth, text, upsertAccount } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");
exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }
  if (!hasAuth()) return json(503, { error: "Supabase Auth is not configured. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY." });
  const accountEmail = email(body.email); const password = String(body.password || ""); const name = text(body.name, 160); const accountRole = role(body.role);
  if (!name) return json(400, { error: "Enter a name" });
  if (!accountEmail) return json(400, { error: "Enter a valid email" });
  if (password.length < 6) return json(400, { error: "Password needs at least 6 characters" });
  try {
    let created;
    try {
      created = await supabaseAuth("admin/users", { method: "POST", body: JSON.stringify({ email: accountEmail, password, email_confirm: true, user_metadata: { name, role: accountRole } }) }, true);
    } catch (error) {
      if (error.status === 422 || error.status === 400) return json(409, { error: "That email is already registered in Supabase Auth." });
      throw error;
    }
    const authUser = created && (created.user || created);
    const pack = await upsertAccount(authUser, { email: accountEmail, name, role: accountRole, eventType: "supabase_auth_signup" });
    return json(200, { ok: true, source: "supabase_auth", account: pack.account, profile: pack.profile });
  } catch (error) {
    await sendSystemAlert({ eventType: "supabase_auth_signup_failed", title: "Supabase Auth signup failed", detail: "A signup was blocked because Supabase Auth did not confirm it.", accountEmail, context: { status: error.status || null, details: error.body || error.message } });
    return json(error.status || 502, { error: error.message || "Could not create Supabase Auth user", details: error.body || null });
  }
};
