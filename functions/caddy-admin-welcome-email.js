"use strict";

/* Admin Player Welcome Email. The browser asks for facts and a preview only;
 * this function resolves player/account state, renders with the shared core,
 * and is the only place that hands HTML to Resend. */
const { hasAuthWithServiceKey, json, supabaseAuth, supabaseRest, text, upsertAccount, claimCanonicalPlayer } = require("./auth-utils");
const { resolveCaller } = require("./clarity-caller");
const templates = require("../scripts/gd-email-templates-core.js");
const { appStoreUrl } = require("../clarity-caddy-app-store.js");

const KEY = "player_welcome";
function uuid(value) { const s = String(value || "").trim(); return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(s) ? s : ""; }
function email(value) { const s = String(value || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ""; }
function siteUrl() { return String(process.env.CLARITY_SITE_URL || process.env.APP_URL || templates.DEFAULT_SITE).replace(/\/+$/, ""); }
function actorId(caller) { return uuid(caller && caller.account && caller.account.auth_user_id); }
function safeTemplate(input) {
  input = input && typeof input === "object" ? input : {};
  return templates.welcomeTemplate({ subject: text(input.subject, 140), headline: text(input.headline, 180), body: text(input.body, 4000), ctaLabel: text(input.ctaLabel, 80) });
}
async function requireAdmin(event) { const caller = await resolveCaller(event, {}); if (!caller || !caller.isAdmin) { const e = new Error("Admin access required"); e.status = 403; throw e; } return caller; }
async function getTemplate() {
  const rows = await supabaseRest("caddy_email_templates?select=content_json,updated_at&template_key=eq." + KEY + "&limit=1", { method: "GET" });
  const row = Array.isArray(rows) && rows[0];
  return { template: safeTemplate(row && row.content_json), updatedAt: row && row.updated_at || null, isDefault: !row };
}
async function saveTemplate(input, caller) {
  const template = safeTemplate(input);
  await supabaseRest("caddy_email_templates?on_conflict=template_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ template_key: KEY, content_json: template, updated_at: new Date().toISOString(), updated_by_auth_user_id: actorId(caller) || null }) });
  return { template };
}
async function playerById(playerId) {
  playerId = uuid(playerId); if (!playerId) { const e = new Error("A valid canonical Player ID is required"); e.status = 400; throw e; }
  const rows = await supabaseRest("caddy_players?select=*&id=eq." + encodeURIComponent(playerId) + "&status=eq.active&limit=1", { method: "GET" });
  const player = Array.isArray(rows) && rows[0]; if (!player) { const e = new Error("Active canonical player not found"); e.status = 404; throw e; }
  return player;
}
async function resolvePlayer(player) {
  let authUser = null, account = null;
  if (player.auth_user_id) authUser = await supabaseAuth("admin/users/" + encodeURIComponent(player.auth_user_id), { method: "GET" }, true).catch(() => null);
  if (player.account_id) { const rows = await supabaseRest("app_accounts?select=*&account_id=eq." + encodeURIComponent(player.account_id) + "&limit=1", { method: "GET" }); account = Array.isArray(rows) && rows[0]; }
  const recipientEmail = email(authUser && authUser.email) || email(account && account.email) || email(player.normalized_email);
  return { player, authUser, account, recipientEmail, accountState: authUser ? "existing" : "needs_setup" };
}
function variables(resolved, caller) {
  const name = String(resolved.player.display_name || resolved.recipientEmail || "Player").trim();
  const coachName = (caller && caller.account && caller.account.name) || "Clarity Golf";
  return { firstName: (name.split(/\s+/)[0] || "there").replace(/[^\w'-]/g, "") || "there", fullName: name, email: resolved.recipientEmail, coachName, appUrl: siteUrl(), appStoreUrl: appStoreUrl() || "" };
}
function render(resolved, template, caller, ctaUrl) { return templates.build("player_welcome", { to: resolved.recipientEmail, siteUrl: siteUrl(), recipientName: resolved.player.display_name, actorName: "Clarity Golf", welcomeTemplate: template, variables: variables(resolved, caller), accountState: resolved.accountState, ctaUrl: ctaUrl || siteUrl(), appStoreUrl: "" }); }
async function createOrFindAuth(accountEmail, name) {
  try { const created = await supabaseAuth("admin/users", { method: "POST", body: JSON.stringify({ email: accountEmail, password: "Clarity-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + "!", email_confirm: true, user_metadata: { name, role: "player", invited: true } }) }, true); return { user: created && (created.user || created), created: true }; }
  catch (error) { if (error.status !== 400 && error.status !== 422) throw error; const found = await supabaseAuth("admin/users?email=" + encodeURIComponent(accountEmail), { method: "GET" }, true); const users = Array.isArray(found && found.users) ? found.users : []; const user = users.find(u => email(u.email) === accountEmail); if (!user) throw error; return { user, created: false }; }
}
async function secureSetup(resolved) {
  const original = { authUserId: resolved.player.auth_user_id || null, accountId: resolved.player.account_id || null, profileId: resolved.player.profile_id || null, hadAccount: !!resolved.account };
  const provision = resolved.authUser ? { user: resolved.authUser, created: false } : await createOrFindAuth(resolved.recipientEmail, resolved.player.display_name);
  const authUser = provision.user;
  const accountId = resolved.player.account_id || "acct_" + resolved.player.id.replace(/-/g, "").slice(0, 16);
  const profileId = resolved.player.profile_id || "profile_" + resolved.player.id.replace(/-/g, "").slice(0, 16);
  await upsertAccount(authUser, { accountId, profileId, email: resolved.recipientEmail, name: resolved.player.display_name, role: "player", eventType: "player_welcome_setup" });
  await claimCanonicalPlayer(authUser, { accountId, profileId, email: resolved.recipientEmail, name: resolved.player.display_name });
  const generated = await supabaseAuth("admin/generate_link", { method: "POST", body: JSON.stringify({ type: "recovery", email: resolved.recipientEmail, options: { redirect_to: siteUrl() + "/?claritySetPassword=1&clarityAccountSetup=1" } }) }, true);
  const link = generated && (generated.action_link || generated.actionLink || generated.properties && generated.properties.action_link);
  if (!link || !/^https:\/\//.test(String(link))) throw new Error("Supabase did not return a secure setup link");
  resolved.accountState = "needs_setup";
  return { link: String(link), rollback: async function () {
    /* A setup link can only exist after Auth has minted a user. If Resend rejects
       the message, undo only the Auth/account edges created by THIS attempt.
       Existing Auth users are never deleted or altered. */
    if (!provision.created) return;
    const playerPath = "caddy_players?id=eq." + encodeURIComponent(resolved.player.id);
    await supabaseRest(playerPath, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ auth_user_id: original.authUserId, account_id: original.accountId, profile_id: original.profileId, updated_at: new Date().toISOString() }) }).catch(() => {});
    if (original.hadAccount) {
      await supabaseRest("app_accounts?account_id=eq." + encodeURIComponent(accountId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ auth_user_id: null, updated_at: new Date().toISOString() }) }).catch(() => {});
      await supabaseRest("app_profiles?profile_id=eq." + encodeURIComponent(profileId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ auth_user_id: null, updated_at: new Date().toISOString() }) }).catch(() => {});
    } else {
      await supabaseRest("app_profiles?profile_id=eq." + encodeURIComponent(profileId), { method: "DELETE" }).catch(() => {});
      await supabaseRest("app_accounts?account_id=eq." + encodeURIComponent(accountId), { method: "DELETE" }).catch(() => {});
    }
    await supabaseAuth("admin/users/" + encodeURIComponent(authUser.id), { method: "DELETE" }, true).catch(() => {});
  } };
}
async function record(resolved, caller, status, providerId, failure) { await supabaseRest("caddy_email_delivery_attempts", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ player_id: resolved.player.id, recipient_email: resolved.recipientEmail, template_key: KEY, sent_by_auth_user_id: actorId(caller) || null, provider_message_id: providerId || null, status, failure_detail: failure ? text(failure, 1000) : null }) }); }
async function history() { const rows = await supabaseRest("caddy_email_delivery_attempts?select=player_id,recipient_email,sent_at,status,provider_message_id&template_key=eq." + KEY + "&order=sent_at.desc", { method: "GET" }); const result = {}; (rows || []).forEach(row => { if (!result[row.player_id]) result[row.player_id] = row; }); return result; }
async function send(resolved, template, caller, options) {
  options = options || {};
  if (!resolved.recipientEmail) { const e = new Error("Welcome email — no email address"); e.status = 400; throw e; }
  let ctaUrl = siteUrl(), setup = null;
  try { if (resolved.accountState === "needs_setup") { setup = await secureSetup(resolved); ctaUrl = setup.link; } const built = render(resolved, template, caller, ctaUrl); const key = process.env.RESEND_API_KEY; if (!key) { const e = new Error("Email delivery is not configured"); e.status = 503; throw e; } const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.CLARITY_EMAIL_FROM || templates.DEFAULT_FROM, to: [resolved.recipientEmail], subject: built.subject, html: built.html, text: built.text }) }); const body = await response.json().catch(() => null); if (!response.ok) { const e = new Error("Email provider rejected the message"); e.status = response.status; e.body = body; throw e; } if (!options.skipHistory) await record(resolved, caller, "sent", body && body.id, ""); return { sent: true, id: body && body.id || null, recipientEmail: resolved.recipientEmail }; }
  catch (error) { if (setup && setup.rollback) await setup.rollback(); if (!options.skipHistory) await record(resolved, caller, "failed", "", error.message).catch(() => {}); throw error; }
}
exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {}); if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" }); if (!hasAuthWithServiceKey()) return json(503, { error: "Supabase is not configured" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "Invalid JSON" }); }
  try { const caller = await requireAdmin(event), action = text(body.action, 40);
    if (action === "get_template") return json(200, Object.assign({ ok: true }, await getTemplate()));
    if (action === "save_template") return json(200, Object.assign({ ok: true }, await saveTemplate(body.template, caller)));
    if (action === "preview" || action === "send_test") { const saved = await getTemplate(); const sample = { player: { id: null, display_name: "Alex Fenwick" }, recipientEmail: email(caller.account && caller.account.email), accountState: "existing" }; if (!sample.recipientEmail) { const e = new Error("Your admin account has no usable email address"); e.status = 400; throw e; } const draft = safeTemplate(body.template || saved.template); const built = render(sample, draft, caller, siteUrl()); if (action === "preview") return json(200, { ok: true, preview: { subject: built.subject, html: built.html, text: built.text } }); const testTemplate = Object.assign({}, draft, { subject: "Test — " + draft.subject }); const result = await send(sample, testTemplate, caller, { skipHistory: true }); return json(200, { ok: true, result }); }
    const resolved = await resolvePlayer(await playerById(body.playerId)); const saved = await getTemplate(); if (!resolved.recipientEmail) return json(400, { ok: false, error: "Welcome email — no email address" }); const built = render(resolved, saved.template, caller, siteUrl()); if (action === "player_preview") return json(200, { ok: true, player: { name: resolved.player.display_name, email: resolved.recipientEmail, accountState: resolved.accountState }, preview: { subject: built.subject, html: built.html, text: built.text } }); if (action === "send_player") return json(200, { ok: true, result: await send(resolved, saved.template, caller) }); return json(400, { error: "Unsupported Welcome Email action" });
  } catch (error) { return json(error.status || 502, { ok: false, error: error.message || "Welcome Email operation failed", details: error.body || null }); }
};
