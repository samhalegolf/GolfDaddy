"use strict";

/* The Welcome Emails endpoint: Studio edits the two templates through it, Admin -> Users
 * sends them through it.
 *
 * The browser asks for facts and a preview only. This function resolves player, account and
 * ENTITLEMENT state, decides which of Basic Sign Up and Comped Sign Up the player should
 * actually receive, renders with the shared core, and is the only place that hands HTML to
 * Resend. Nothing about the message - not the recipient, not the copy, not which template -
 * is taken from the request. */
const { hasAuthWithServiceKey, json, supabaseAuth, supabaseRest, text, upsertAccount, claimCanonicalPlayer } = require("./auth-utils");
const { resolveCaller } = require("./clarity-caller");
const templates = require("../scripts/gd-email-templates-core.js");
const signupTemplates = require("./lib/gd-signup-templates.js");
const { ADMIN_COMPED_MEMBERSHIP_KEY } = require("./payment-utils");
const { appStoreUrl, playStoreUrl } = require("../clarity-caddy-app-store.js");

const KEYS = signupTemplates.KEYS;
function uuid(value) { const s = String(value || "").trim(); return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(s) ? s : ""; }
function email(value) { const s = String(value || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ""; }
function siteUrl() { return String(process.env.CLARITY_SITE_URL || process.env.APP_URL || templates.DEFAULT_SITE).replace(/\/+$/, ""); }
function actorId(caller) { return uuid(caller && caller.account && caller.account.auth_user_id); }
function templateKey(value) { return signupTemplates.normaliseKey(value); }
async function requireAdmin(event) { const caller = await resolveCaller(event, {}); if (!caller || !caller.isAdmin) { const e = new Error("Admin access required"); e.status = 403; throw e; } return caller; }
async function getTemplate(key) { return signupTemplates.loadTemplate(templateKey(key)); }
async function saveTemplate(key, input, caller) { return signupTemplates.saveTemplate(templateKey(key), input, actorId(caller)); }
/* Studio opens both templates at once - two independent messages, listed together. */
async function listTemplates() {
  const loaded = [];
  for (const key of KEYS) loaded.push(await getTemplate(key));
  return { templates: loaded, variables: templates.TEMPLATE_VARIABLES };
}
async function playerById(playerId) {
  playerId = uuid(playerId); if (!playerId) { const e = new Error("A valid canonical Player ID is required"); e.status = 400; throw e; }
  const rows = await supabaseRest("caddy_players?select=*&id=eq." + encodeURIComponent(playerId) + "&status=eq.active&limit=1", { method: "GET" });
  const player = Array.isArray(rows) && rows[0]; if (!player) { const e = new Error("Active canonical player not found"); e.status = 404; throw e; }
  return player;
}
/* Which of the two welcome emails a player should get is not a checkbox on this request - it
   is whatever their entitlement actually says. A resend has to describe what happened to them,
   so a player holding comped access gets the Comped Sign Up email and everyone else gets Basic
   Sign Up, whatever the browser would have preferred. */
async function compedAccess(player, account, recipientEmail) {
  const filters = [];
  if (player.account_id) filters.push("user_id.eq." + player.account_id);
  if (player.profile_id) filters.push("profile_id.eq." + player.profile_id);
  if (recipientEmail) filters.push("account_email.eq." + recipientEmail);
  if (!filters.length) return null;
  const rows = await supabaseRest(
    "user_entitlements?select=status,starts_at,expires_at,entitlement_reason,metadata&status=eq.active&or=(" + encodeURIComponent(filters.join(",")) + ")&order=expires_at.desc&limit=10",
    { method: "GET" }
  ).catch(() => null);
  const now = Date.now();
  const live = (Array.isArray(rows) ? rows : []).filter(row => !row.expires_at || new Date(row.expires_at).getTime() > now);
  const comp = live.find(row => /comp|coach_issued/i.test(String(row.entitlement_reason || "")));
  if (!comp) return null;
  const hours = Number(comp.metadata && comp.metadata.duration_hours);
  const days = Number.isFinite(hours) && hours > 0 ? Math.round(hours / 24) : 0;
  return {
    membership: String(comp.entitlement_reason || "") === ADMIN_COMPED_MEMBERSHIP_KEY,
    periodLabel: days ? (days >= 28 && days <= 31 ? "a month" : days + " days") : "",
    expiresLabel: comp.expires_at ? new Date(comp.expires_at).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" }) : ""
  };
}
async function resolvePlayer(player) {
  let authUser = null, account = null;
  if (player.auth_user_id) authUser = await supabaseAuth("admin/users/" + encodeURIComponent(player.auth_user_id), { method: "GET" }, true).catch(() => null);
  if (player.account_id) { const rows = await supabaseRest("app_accounts?select=*&account_id=eq." + encodeURIComponent(player.account_id) + "&limit=1", { method: "GET" }); account = Array.isArray(rows) && rows[0]; }
  const recipientEmail = email(authUser && authUser.email) || email(account && account.email) || email(player.normalized_email);
  const comped = await compedAccess(player, account, recipientEmail);
  /* Admin -> Users is always someone inviting a player, never a self-signup, so the resend is
     a Coach Invite - standard or comped, decided by the entitlement rather than by the
     request. */
  return { player, authUser, account, recipientEmail, comped, templateKey: signupTemplates.keyForComped(comped), accountState: authUser ? "existing" : "needs_setup" };
}
function variables(resolved, caller) {
  return signupTemplates.variablesFor({
    recipientName: resolved.player.display_name,
    email: resolved.recipientEmail,
    actorName: (caller && caller.account && caller.account.name) || "Clarity Golf",
    siteUrl: siteUrl(),
    appStoreUrl: appStoreUrl() || "",
    playStoreUrl: playStoreUrl() || "",
    comped: resolved.comped
  });
}
function render(resolved, template, caller, ctaUrl) {
  return templates.build(resolved.templateKey || KEYS[0], {
    to: resolved.recipientEmail, siteUrl: siteUrl(), recipientName: resolved.player.display_name,
    actorName: "Clarity Golf", welcomeTemplate: template, variables: variables(resolved, caller),
    accountState: resolved.accountState, ctaUrl: ctaUrl || "",
    appStoreUrl: appStoreUrl() || "", playStoreUrl: playStoreUrl() || ""
  });
}
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
async function record(resolved, caller, status, providerId, failure) { await supabaseRest("caddy_email_delivery_attempts", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ player_id: resolved.player.id, recipient_email: resolved.recipientEmail, template_key: resolved.templateKey || KEYS[0], sent_by_auth_user_id: actorId(caller) || null, provider_message_id: providerId || null, status, failure_detail: failure ? text(failure, 1000) : null }) }); }
/* The log spans both templates and the key the first version wrote under, so "when did this
   player last get a welcome email" keeps answering across the rename. */
const WELCOME_LOG_KEYS = ["coach_invite_basic", "coach_invite_comped", "player_signup_welcome", "player_signup_basic", "player_signup_comped", "player_welcome"];
/* The log spans both invite templates and the keys they were written under before the split,
   so "when did this player last get a welcome email" keeps answering across the rename. */
async function history() { const rows = await supabaseRest("caddy_email_delivery_attempts?select=player_id,recipient_email,sent_at,status,provider_message_id,template_key&template_key=in." + encodeURIComponent("(" + WELCOME_LOG_KEYS.join(",") + ")") + "&order=sent_at.desc", { method: "GET" }); const result = {}; (rows || []).forEach(row => { if (!result[row.player_id]) result[row.player_id] = row; }); return result; }
async function send(resolved, template, caller, options) {
  options = options || {};
  if (!resolved.recipientEmail) { const e = new Error("Welcome email — no email address"); e.status = 400; throw e; }
  /* Empty, not the site: an empty destination lets the template's own button destination
     stand. Only a secure setup link overrides it. */
  let ctaUrl = "", setup = null;
  try { if (resolved.accountState === "needs_setup") { setup = await secureSetup(resolved); ctaUrl = setup.link; } const built = render(resolved, template, caller, ctaUrl); const key = process.env.RESEND_API_KEY; if (!key) { const e = new Error("Email delivery is not configured"); e.status = 503; throw e; } const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.CLARITY_EMAIL_FROM || templates.DEFAULT_FROM, to: [resolved.recipientEmail], subject: built.subject, html: built.html, text: built.text }) }); const body = await response.json().catch(() => null); if (!response.ok) { const e = new Error("Email provider rejected the message"); e.status = response.status; e.body = body; throw e; } if (!options.skipHistory) await record(resolved, caller, "sent", body && body.id, ""); return { sent: true, id: body && body.id || null, recipientEmail: resolved.recipientEmail }; }
  catch (error) { if (setup && setup.rollback) await setup.rollback(); if (!options.skipHistory) await record(resolved, caller, "failed", "", error.message).catch(() => {}); throw error; }
}
exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {}); if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" }); if (!hasAuthWithServiceKey()) return json(503, { error: "Supabase is not configured" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "Invalid JSON" }); }
  try {
    const caller = await requireAdmin(event), action = text(body.action, 40), key = templateKey(body.templateKey);
    if (action === "list_templates") return json(200, Object.assign({ ok: true }, await listTemplates()));
    if (action === "get_template") return json(200, Object.assign({ ok: true }, await getTemplate(key)));
    if (action === "save_template") return json(200, Object.assign({ ok: true }, await saveTemplate(key, body.template, caller)));

    /* Preview and Send Test go through the same render() and the same send() as a real
       delivery - a second, friendlier approximation of the email is how a preview starts
       lying. Only the recipient and the sample player are different. */
    if (action === "preview" || action === "send_test") {
      const saved = await getTemplate(key);
      const sample = {
        player: { id: null, display_name: "Alex Fenwick" },
        recipientEmail: email(caller.account && caller.account.email),
        templateKey: key,
        comped: key === "coach_invite_comped" ? { membership: true, periodLabel: "a month", expiresLabel: new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" }) } : null,
        accountState: "existing"
      };
      if (!sample.recipientEmail) { const e = new Error("Your admin account has no usable email address"); e.status = 400; throw e; }
      const draft = signupTemplates.sanitise(key, body.template || saved.template);
      const built = render(sample, draft, caller, "");
      if (action === "preview") return json(200, { ok: true, templateKey: key, preview: { subject: built.subject, html: built.html, text: built.text } });
      /* Marked as a test in the subject line only, on a copy of the draft. The stored template
         is never touched, so a test send cannot leave "Test —" on a customer email. */
      const result = await send(sample, Object.assign({}, draft, { subject: "Test — " + draft.subject }), caller, { skipHistory: true });
      return json(200, { ok: true, templateKey: key, result });
    }

    /* A player send never takes the template key from the request. resolvePlayer reads the
       entitlement and decides, so the email always describes what actually happened. */
    const resolved = await resolvePlayer(await playerById(body.playerId));
    const saved = await getTemplate(resolved.templateKey);
    if (!resolved.recipientEmail) return json(400, { ok: false, error: "Welcome email — no email address" });
    if (action === "player_preview") {
      const built = render(resolved, saved.template, caller, "");
      return json(200, { ok: true, templateKey: resolved.templateKey, player: { name: resolved.player.display_name, email: resolved.recipientEmail, accountState: resolved.accountState, comped: !!resolved.comped }, preview: { subject: built.subject, html: built.html, text: built.text } });
    }
    if (action === "send_player") return json(200, { ok: true, templateKey: resolved.templateKey, result: await send(resolved, saved.template, caller) });
    return json(400, { error: "Unsupported Welcome Email action" });
  } catch (error) { return json(error.status || 502, { ok: false, error: error.message || "Welcome Email operation failed", details: error.body || null }); }
};
