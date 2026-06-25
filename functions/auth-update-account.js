"use strict";
const { email, hasAuth, json, supabaseAuth, text, upsertAccount } = require("./auth-utils");
exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }
  if (!hasAuth()) return json(503, { error: "Supabase Auth is not configured" });
  const userId = text(body.supabaseUserId || body.userId, 120); const accountEmail = email(body.email); const name = text(body.name, 160); const password = String(body.password || "");
  if (!userId) return json(400, { error: "Missing Supabase user id" });
  const update = { user_metadata: { name, role: body.role || "player" } };
  if (accountEmail) update.email = accountEmail;
  const passwordUpdated = !!password;
  if (password) { if (password.length < 8) return json(400, { error: "Password needs at least 8 characters" }); update.password = password; }
  const authUser = await supabaseAuth("admin/users/" + encodeURIComponent(userId), { method: "PUT", body: JSON.stringify(update) }, true);
  const pack = await upsertAccount(authUser && (authUser.user || authUser), { email: accountEmail, name, role: body.role, eventType: "supabase_auth_update" });
  return json(200, { ok: true, passwordUpdated, account: pack.account, profile: pack.profile });
};
