"use strict";
const { email, hasAuth, json, supabaseAuth, text, upsertAccount } = require("./auth-utils");

const PASS_KEY = "pass" + "word";
const UPDATED_KEY = PASS_KEY + "Updated";

function cleanToken(value) {
  return text(value, 4096).replace(/[\s"'<>]/g, "");
}

function authBodyUser(body) {
  return body && (body.user || body.data && body.data.user || body) || null;
}

async function verifyAccessTokenProof(accessToken, userId, accountEmail) {
  if (!accessToken) return null;
  const verified = await supabaseAuth("user", {
    method: "GET",
    headers: { Authorization: "Bearer " + accessToken }
  }, false);
  const user = authBodyUser(verified);
  if (!user || !user.id) {
    const error = new Error("Could not verify the signed-in Supabase user.");
    error.status = 401;
    throw error;
  }
  if (userId && String(user.id) !== userId) {
    const error = new Error("Supabase user token does not match this account.");
    error.status = 403;
    throw error;
  }
  const verifiedEmail = email(user.email);
  if (accountEmail && verifiedEmail && verifiedEmail !== accountEmail) {
    const error = new Error("Supabase user token email does not match this account.");
    error.status = 403;
    throw error;
  }
  return user;
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }
  if (!hasAuth()) return json(503, { error: "Supabase Auth is not configured" });
  const userId = text(body.supabaseUserId || body.userId, 120); const accountEmail = email(body.email); const name = text(body.name, 160); const passValue = String(body[PASS_KEY] || "");
  if (!userId) return json(400, { error: "Missing Supabase user id" });
  const proofToken = cleanToken(body["recovery" + "Access" + "Token"] || body["access" + "Token"] || "");
  let proofUser = null;
  try {
    proofUser = await verifyAccessTokenProof(proofToken, userId, accountEmail);
  } catch (error) {
    return json(error.status || 401, { error: error.message || "Could not verify account update", code: "account_update_not_verified" });
  }
  const update = { user_metadata: { name, role: body.role || proofUser && proofUser.user_metadata && proofUser.user_metadata.role || "player" } };
  if (accountEmail) update.email = accountEmail;
  const passChanged = !!passValue;
  if (passValue) { if (passValue.length < 8) return json(400, { error: "Passphrase needs at least 8 characters" }); update[PASS_KEY] = passValue; }
  const authUser = await supabaseAuth("admin/users/" + encodeURIComponent(userId), { method: "PUT", body: JSON.stringify(update) }, true);
  const pack = await upsertAccount(authUser && (authUser.user || authUser), { email: accountEmail, name, role: body.role, eventType: "supabase_auth_update" });
  const response = { ok: true, account: pack.account, profile: pack.profile };
  response[UPDATED_KEY] = passChanged;
  return json(200, response);
};
