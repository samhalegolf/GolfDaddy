"use strict";

const { email, hasAuth, json, role, supabaseAuth, supabaseRest, text, upsertAccount } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");

function env(name) { return process.env[name] || ""; }
function siteUrl() { return (env("CLARITY_SITE_URL") || env("APP_URL") || "https://caddy.claritygolf.app").replace(/\/+$/, ""); }
function tempPassword() { return "Clarity-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + "!"; }
function escapeHTML(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); }
function firstName(value) { return (String(value || "there").trim().split(/\s+/)[0] || "there").replace(/[^\w'-]/g, "") || "there"; }
function cleanId(value) { return text(value, 120).replace(/[^a-zA-Z0-9_:-]/g, ""); }
function unique(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function(item) {
    item = cleanId(item);
    if (item && out.indexOf(item) === -1) out.push(item);
  });
  return out;
}

async function sendEmail(to, name, actorName, setupLink) {
  const resendKey = env("RESEND_API_KEY");
  if (!resendKey) return { sent: false, provider: "not_configured" };
  const from = env("CLARITY_EMAIL_FROM") || "Clarity Golf Systems <notifications@claritygolf.app>";
  const app = siteUrl();
  const logoUrl = app + "/assets/brand/cg-logo-white-g.png";
  const detail = "Your Clarity Caddy account has been created by " + (actorName || "your coach") + ". Use the secure button below to set your password. This link is unique to your account.";
  const html = [
    "<!doctype html><html><body style=\"margin:0;background:#07100b;color:#f7faf7;font-family:Arial,Helvetica,sans-serif\">",
    "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#07100b;padding:28px 14px\"><tr><td align=\"center\">",
    "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:560px;background:#101b15;border:1px solid #24342c;border-radius:20px;overflow:hidden\">",
    "<tr><td style=\"padding:24px 24px 16px;background:#07100b\"><img src=\"" + escapeHTML(logoUrl) + "\" width=\"44\" height=\"44\" alt=\"Clarity Golf\" style=\"vertical-align:middle;margin-right:12px\"><span style=\"font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#b9c4bd;font-weight:700\">Clarity Golf Systems</span></td></tr>",
    "<tr><td style=\"padding:24px\"><p style=\"margin:0 0 10px;color:#42b66a;font-weight:700\">Hi " + escapeHTML(firstName(name)) + ",</p>",
    "<h1 style=\"margin:0 0 12px;color:#fff;font-size:28px;line-height:1.05\">Set up your Clarity account</h1>",
    "<p style=\"margin:0 0 18px;color:#c8d1cc;font-size:16px;line-height:1.45\">" + escapeHTML(detail) + "</p>",
    "<a href=\"" + escapeHTML(setupLink) + "\" style=\"display:inline-block;background:#ff9f2f;color:#06110b;text-decoration:none;font-weight:800;border-radius:999px;padding:12px 18px\">Set up your password</a>",
    "<p style=\"margin:18px 0 0;color:#8fa199;font-size:13px;line-height:1.4\">If the button does not work, copy the secure link from this button into your browser.</p>",
    "</td></tr><tr><td style=\"padding:16px 24px 24px;color:#708178;font-size:12px;line-height:1.45\">You are receiving this because it relates to your Clarity account access.</td></tr>",
    "</table></td></tr></table></body></html>"
  ].join("");
  const plain = "Hi " + firstName(name) + ",\n\nSet up your Clarity account\n\n" + detail + "\n\n" + setupLink;
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + resendKey, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject: "Set up your Clarity account", html, text: plain }) });
  const body = await response.json().catch(function() { return null; });
  if (!response.ok) { const error = new Error("Email provider rejected the invite email"); error.status = response.status; error.body = body; throw error; }
  return { sent: true, provider: "resend", id: body && body.id || null };
}

async function createOrFindUser(accountEmail, name, accountRole) {
  try {
    const created = await supabaseAuth("admin/users", { method: "POST", body: JSON.stringify({ email: accountEmail, password: tempPassword(), email_confirm: true, user_metadata: { name, role: accountRole, invited: true } }) }, true);
    return created && (created.user || created);
  } catch (error) {
    if (error.status !== 400 && error.status !== 422) throw error;
    const listing = await supabaseAuth("admin/users?email=" + encodeURIComponent(accountEmail), { method: "GET" }, true);
    const users = Array.isArray(listing && listing.users) ? listing.users : Array.isArray(listing) ? listing : [];
    const existing = users.find(function(user) { return String(user && user.email || "").toLowerCase() === accountEmail; });
    if (!existing) throw error;
    return existing;
  }
}

async function setupLink(accountEmail) {
  const generated = await supabaseAuth("admin/generate_link", { method: "POST", body: JSON.stringify({ type: "recovery", email: accountEmail, options: { redirect_to: siteUrl() + "/?claritySetPassword=1" } }) }, true);
  const link = generated && (generated.action_link || generated.actionLink || generated.properties && generated.properties.action_link);
  if (!link || !/^https?:\/\//.test(String(link))) throw new Error("Supabase did not return a setup link");
  return String(link);
}

async function linkAccounts(coachId, playerId) {
  coachId = cleanId(coachId);
  playerId = cleanId(playerId);
  if (!coachId || !playerId || coachId === playerId) return { linked: false };
  const coachRows = await supabaseRest("app_accounts?select=account_id,linked_player_ids&account_id=eq." + encodeURIComponent(coachId) + "&limit=1", { method: "GET" });
  const playerRows = await supabaseRest("app_accounts?select=account_id,linked_coach_ids&account_id=eq." + encodeURIComponent(playerId) + "&limit=1", { method: "GET" });
  const coach = Array.isArray(coachRows) && coachRows[0];
  const player = Array.isArray(playerRows) && playerRows[0];
  const now = new Date().toISOString();
  if (coach) {
    await supabaseRest("app_accounts?account_id=eq." + encodeURIComponent(coachId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ linked_player_ids: unique([].concat(coach.linked_player_ids || [], [playerId])), updated_at: now })
    });
  }
  if (player) {
    await supabaseRest("app_accounts?account_id=eq." + encodeURIComponent(playerId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ linked_coach_ids: unique([].concat(player.linked_coach_ids || [], [coachId])), created_by_coach_id: coachId, updated_at: now })
    });
  }
  return { linked: !!(coach && player) };
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_error) { return json(400, { error: "Invalid JSON" }); }
  if (!hasAuth()) return json(503, { error: "Supabase Auth is not configured" });
  const accountEmail = email(body.email);
  const name = text(body.name, 160) || (accountEmail ? accountEmail.split("@")[0] : "Player");
  const accountRole = role(body.role);
  const actorName = text(body.actorName, 120) || "your coach";
  const actorAccountId = cleanId(body.actorAccountId || body.coachAccountId || "");
  const targetAccountId = cleanId(body.targetAccountId || body.accountId || "");
  if (!accountEmail) return json(400, { error: "Enter a valid email" });
  try {
    const authUser = await createOrFindUser(accountEmail, name, accountRole);
    const pack = await upsertAccount(authUser, { accountId: targetAccountId, email: accountEmail, name, role: accountRole, coachId: actorAccountId || null, eventType: "admin_user_invite" });
    const playerId = pack && pack.account && pack.account.accountId || targetAccountId;
    const linkResult = accountRole === "player" ? await linkAccounts(actorAccountId, playerId) : { linked: false };
    if (linkResult.linked && pack && pack.account) {
      pack.account.linkedCoachIds = unique([].concat(pack.account.linkedCoachIds || [], [actorAccountId]));
      pack.account.createdByCoachId = pack.account.createdByCoachId || actorAccountId;
    }
    const link = await setupLink(accountEmail);
    const emailResult = await sendEmail(accountEmail, name, actorName, link);
    return json(200, { ok: true, invited: true, linked: linkResult.linked, email: accountEmail, emailResult, account: pack.account, profile: pack.profile });
  } catch (error) {
    await sendSystemAlert({ eventType: "admin_user_invite_failed", title: "Clarity account invite failed", detail: "A user invite could not create a setup-password link.", accountEmail, context: { status: error.status || null, details: error.body || error.message } });
    return json(error.status || 502, { error: error.message || "Could not invite user", details: error.body || null });
  }
};
