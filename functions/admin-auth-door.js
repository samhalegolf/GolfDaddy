"use strict";

const { email, hasAuth, json, role, supabaseAuth, text, upsertAccount } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");

function env(name) { return process.env[name] || ""; }
function siteUrl() { return (env("CLARITY_SITE_URL") || env("APP_URL") || "https://caddy.claritygolf.app").replace(/\/+$/, ""); }
function adminToken() { return text(env("CLARITY_ADMIN_AUTH_TOKEN") || env("CLARITY_ADMIN_DIAGNOSTICS_TOKEN"), 240); }
function tempPassword() { return "Clarity-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + "!"; }

function authorised(event, body) {
  const token = adminToken();
  if (!token) return false;
  const header = text(event.headers && (event.headers.authorization || event.headers.Authorization), 300);
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const supplied = text(body && (body.adminToken || body.token), 240);
  return bearer === token || supplied === token;
}

async function findAuthUser(accountEmail) {
  const listing = await supabaseAuth("admin/users?email=" + encodeURIComponent(accountEmail), { method: "GET" }, true);
  const users = Array.isArray(listing && listing.users) ? listing.users : Array.isArray(listing) ? listing : [];
  return users.find(function(user) { return String(user && user.email || "").toLowerCase() === accountEmail; }) || null;
}

async function createAuthUser(accountEmail, name, accountRole) {
  const created = await supabaseAuth("admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: accountEmail,
      password: tempPassword(),
      email_confirm: true,
      user_metadata: { name, role: accountRole, adminDoor: true }
    })
  }, true);
  return created && (created.user || created);
}

async function recoveryLink(accountEmail) {
  const generated = await supabaseAuth("admin/generate_link", {
    method: "POST",
    body: JSON.stringify({
      type: "recovery",
      email: accountEmail,
      options: { redirect_to: siteUrl() + "/?claritySetPassword=1" }
    })
  }, true);
  const link = generated && (generated.action_link || generated.actionLink || generated.properties && generated.properties.action_link);
  if (!link || !/^https?:\/\//.test(String(link))) throw new Error("Supabase did not return a password setup link");
  return String(link);
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_error) { return json(400, { error: "Invalid JSON" }); }

  if (!authorised(event, body)) return json(401, { error: "Admin auth token required" });
  if (!hasAuth()) return json(503, { error: "Supabase Auth is not configured" });

  const accountEmail = email(body.email);
  const name = text(body.name, 160) || (accountEmail ? accountEmail.split("@")[0] : "Player");
  const accountRole = role(body.role || "admin");
  const createIfMissing = body.createIfMissing !== false;

  if (!accountEmail) return json(400, { error: "Enter a valid email" });

  try {
    let authUser = await findAuthUser(accountEmail);
    let created = false;
    if (!authUser) {
      if (!createIfMissing) return json(404, { error: "No Supabase Auth user found for that email" });
      authUser = await createAuthUser(accountEmail, name, accountRole);
      created = true;
    }
    if (!authUser || !authUser.id) return json(502, { error: "Supabase Auth did not return a user" });

    const pack = await upsertAccount(authUser, { email: accountEmail, name, role: accountRole, eventType: "admin_auth_door" });
    const link = await recoveryLink(accountEmail);

    return json(200, {
      ok: true,
      created,
      email: accountEmail,
      role: accountRole,
      account: pack.account,
      profile: pack.profile,
      recoveryLink: link,
      note: "Use this link to set a new password. It is token-protected and should not be shared publicly."
    });
  } catch (error) {
    await sendSystemAlert({
      eventType: "admin_auth_door_failed",
      title: "Admin auth door failed",
      detail: "Admin password setup link could not be generated.",
      accountEmail,
      context: { status: error.status || null, details: error.body || error.message }
    });
    return json(error.status || 502, { error: error.message || "Could not create admin auth link", details: error.body || null });
  }
};
