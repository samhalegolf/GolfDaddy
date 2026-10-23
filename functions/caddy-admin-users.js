"use strict";

/* Server-owned Admin → Users operations. Browser state is never accepted as
 * identity truth: the caller is resolved from their bearer token. Coach links
 * are the app_accounts linked_player_ids / linked_coach_ids pair - the same
 * ones the coach roster reads - so an assignment made here shows up there. */
const { hasAuthWithServiceKey, json, linkCoachToPlayer, supabaseAuth, supabaseRest, text } = require("./auth-utils");
const { resolveCaller } = require("./clarity-caller");

const SAM_ACCOUNT_ID = "acct_mq4k1ge6_5stlq";

function uuid(value) { const s = String(value || "").trim(); return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(s) ? s : ""; }
function email(value) { const s = String(value || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ""; }
async function rpc(name, body) { return supabaseRest("rpc/" + name, { method: "POST", body: JSON.stringify(body) }); }

async function requireAdmin(event) {
  const caller = await resolveCaller(event, {});
  if (!caller || !caller.isAdmin) { const error = new Error("Admin access required"); error.status = 403; throw error; }
  return caller;
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasAuthWithServiceKey()) return json(503, { error: "Supabase is not configured" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "Invalid JSON" }); }
  try {
    const caller = await requireAdmin(event);
    const action = text(body.action, 40);
    if (action === "list") return json(200, { ok: true, users: await listUsers() });
    if (action === "create_player") return json(200, { ok: true, player: await createPlayer(body) });
    if (action === "assign_coach") return json(200, { ok: true, assignment: await assignSam(body) });
    if (action === "merge_preview") return json(200, { ok: true, preview: await rpc("caddy_merge_preview", { p_source: uuid(body.sourcePlayerId), p_target: uuid(body.targetPlayerId) }) });
    if (action === "merge_execute") return json(200, { ok: true, result: await rpc("caddy_execute_player_merge", { p_source: uuid(body.sourcePlayerId), p_target: uuid(body.targetPlayerId), p_actor: actorAuthId(caller), p_decisions: body.decisions && typeof body.decisions === "object" ? body.decisions : {}, p_confirm_two_auth: body.confirmTwoAuth === true }) });
    return json(400, { error: "Unsupported Users action" });
  } catch (error) { return json(error.status || 502, { ok: false, error: error.message || "Users operation failed", details: error.body || null }); }
};

async function listUsers() {
  const players = await supabaseRest("caddy_players?select=*&order=updated_at.desc", { method: "GET" });
  const accounts = await supabaseRest("app_accounts?select=account_id,profile_id,auth_user_id,email,name,last_login_at,linked_player_ids,linked_coach_ids", { method: "GET" });
  const profiles = await supabaseRest("app_profiles?select=profile_id,account_id,bag_json,profile_json", { method: "GET" });
  const entitlements = await supabaseRest("user_entitlements?select=user_id,profile_id,status,expires_at,entitlement_reason", { method: "GET" });
  /* Welcome history is additive: until its migration is applied, Users still
     works normally and simply reports no history rather than failing the list. */
  const welcomeHistory = await supabaseRest("caddy_email_delivery_attempts?select=player_id,recipient_email,sent_at,status,template_key&template_key=in." + encodeURIComponent("(coach_invite_basic,coach_invite_comped,player_signup_welcome,player_signup_basic,player_signup_comped,player_welcome)") + "&order=sent_at.desc", { method: "GET" }).catch(function () { return []; });
  const known = new Set((players || []).map(p => p.auth_user_id).filter(Boolean));
  const authOnly = await supabaseAuth("admin/users?page=1&per_page=1000", { method: "GET" }, true);
  const accountById = Object.create(null); (accounts || []).forEach(a => { accountById[a.account_id] = a; });
  const profileById = Object.create(null); (profiles || []).forEach(p => { profileById[p.profile_id] = p; });
  return (players || []).map(player => {
    const profile = profileById[player.profile_id] || {};
    const account = accountById[player.account_id] || {};
    const coach = coachOf(player.account_id, account, accounts || [], accountById);
    const bag = Array.isArray(player.bag_json) && player.bag_json.length ? player.bag_json : (profile.bag_json || []);
    const generated = !!((player.profile_json || profile.profile_json || {}).bagSeededDefault || (player.profile_json || profile.profile_json || {}).ghostBagOnly);
    const playerEmail = email(player.normalized_email) || email(account.email);
    const entitlement = (entitlements || []).filter(function (e) { return e.user_id === player.account_id || e.profile_id === player.profile_id; }).sort(function(a,b){ return String(b.expires_at||"").localeCompare(String(a.expires_at||"")); })[0];
    const activeAccess = entitlement && entitlement.status === "active" && (!entitlement.expires_at || new Date(entitlement.expires_at) > new Date());
    const access = activeAccess ? (/comp|coach_issued/i.test(entitlement.entitlement_reason || "") ? "Comped" : "Active") : (entitlement ? "Expired" : "None");
    const welcome = (welcomeHistory || []).find(function (entry) { return entry.player_id === player.id; }) || null;
    return { playerId: player.id, profileId: player.profile_id || "", accountId: player.account_id || "", authUserId: player.auth_user_id || "", name: player.display_name, email: playerEmail, login: player.auth_user_id ? "Active" : "No Login", player: player.status === "active" ? "Active" : "Merged / Archived", coach: coach ? coach.name || coach.email || "Coach" : "Unassigned", access: access, bagCount: bag.length || 0, bagKind: generated ? "generated" : "real", bubble: Object.keys(player.bubble_json || {}).length ? "Present" : "None", status: player.status === "active" && (!player.auth_user_id || !coach) ? "Needs Attention" : "OK", lastLoginAt: account.last_login_at || null, mergedIntoPlayerId: player.merged_into_player_id || null, welcomeEmail: welcome ? { status: welcome.status, sentAt: welcome.sent_at, recipientEmail: welcome.recipient_email } : null };
  }).concat(((authOnly && authOnly.users) || []).filter(u => !known.has(u.id)).map(u => ({ playerId: "", profileId: "", accountId: "", authUserId: u.id || "", name: (u.user_metadata || {}).name || u.email || "Auth user", email: u.email || "", login: "Auth Only", player: "Missing", coach: "Unassigned", bagCount: 0, bubble: "None", status: "Needs Attention", lastLoginAt: u.last_sign_in_at || null })));
}
/* A link claimed by either side is a link, exactly as coach-roster.js reads it. */
function coachOf(accountId, account, accounts, accountById) {
  if (!accountId) return null;
  const ids = (account.linked_coach_ids || []).concat(accounts.filter(a => (a.linked_player_ids || []).indexOf(accountId) !== -1).map(a => a.account_id));
  return ids.filter(id => id !== accountId).map(id => accountById[id]).filter(Boolean)[0] || null;
}
function actorAuthId(caller) { return uuid(caller && caller.account && caller.account.auth_user_id); }

async function createPlayer(body) {
  const playerEmail = email(body.email); const name = text(body.name, 160) || (playerEmail ? playerEmail.split("@")[0] : "Player");
  return rpc("caddy_claim_or_create_player", { p_auth_user_id: null, p_email: playerEmail || null, p_name: name, p_account_id: null, p_profile_id: null });
}
async function assignSam(body) {
  const playerId = uuid(body.playerId);
  if (!playerId) { const error = new Error("Player is required"); error.status = 400; throw error; }
  const rows = await supabaseRest("caddy_players?select=account_id&id=eq." + playerId + "&limit=1", { method: "GET" });
  const accountId = Array.isArray(rows) && rows[0] && rows[0].account_id;
  if (!accountId) { const error = new Error("This player has no account yet, so they cannot be on a coach roster"); error.status = 409; throw error; }
  return linkCoachToPlayer(SAM_ACCOUNT_ID, accountId);
}
