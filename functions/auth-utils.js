"use strict";

function env(name) { return process.env[name] || ""; }
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
function text(value, limit) { const input = String(value || "").trim(); return input.length > limit ? input.slice(0, limit) : input; }
function email(value) { const input = text(value, 240).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : ""; }
function role(value) { const raw = String(value || "player").trim().toLowerCase().replace(/[\s_-]+/g, ""); if (raw === "admin") return "admin"; if (raw === "coach") return "coach"; if (raw === "subscribed" || raw === "subscriber" || raw === "subscribedplayer") return "subscribedPlayer"; return "player"; }
function permission(value) { const r = role(value); if (r === "admin") return "admin"; if (r === "coach") return "coach"; return r === "subscribedPlayer" ? "subscribed" : "player"; }
function supabaseUrl() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function serviceKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasAuth() { return !!(supabaseUrl() && serviceKey() && anonKey()); }
async function supabaseRest(path, options) {
  if (!supabaseUrl() || !serviceKey()) throw new Error("Supabase is not configured");
  const headers = Object.assign({ apikey: serviceKey(), Authorization: "Bearer " + serviceKey(), "Content-Type": "application/json" }, options && options.headers || {});
  const response = await fetch(supabaseUrl() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const raw = await response.text();
  let body = null;
  if (raw) { try { body = JSON.parse(raw); } catch (_e) { body = raw; } }
  if (!response.ok) { const error = new Error("Supabase REST request failed"); error.status = response.status; error.body = body; throw error; }
  return body;
}
async function supabaseAuth(path, options, useService) {
  if (!supabaseUrl() || !(useService ? serviceKey() : anonKey())) throw new Error("Supabase Auth is not configured");
  const key = useService ? serviceKey() : anonKey();
  const headers = Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, options && options.headers || {});
  const response = await fetch(supabaseUrl() + "/auth/v1/" + path, Object.assign({}, options, { headers }));
  const raw = await response.text();
  let body = null;
  if (raw) { try { body = JSON.parse(raw); } catch (_e) { body = raw; } }
  if (!response.ok) { const error = new Error((body && (body.error_description || body.msg || body.message || body.error)) || "Supabase Auth request failed"); error.status = response.status; error.body = body; throw error; }
  return body;
}
function encodeFilter(value) { return encodeURIComponent(String(value || "")); }
function newId(prefix) { return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9); }
function accountPayload(row, authUser, input) {
  const now = new Date().toISOString();
  const accountId = text(row && row.account_id || input && input.accountId, 120) || newId("acct");
  const profileId = text(row && row.profile_id || input && input.profileId, 120) || newId("profile");
  const accountEmail = email(authUser && authUser.email || row && row.email || input && input.email);
  const name = text(input && input.name || authUser && authUser.user_metadata && authUser.user_metadata.name || row && row.name || accountEmail.split("@")[0], 160);
  const accountRole = role(input && input.role || row && row.role || authUser && authUser.user_metadata && authUser.user_metadata.role);
  return {
    account: {
      accountId, profileId, supabaseUserId: authUser && authUser.id || row && row.auth_user_id || "",
      name, email: accountEmail, role: accountRole,
      linkedCoachIds: row && row.linked_coach_ids || [], linkedPlayerIds: row && row.linked_player_ids || [],
      createdByCoachId: row && row.created_by_coach_id || input && input.coachId || null,
      requiresPasswordSetup: !!(row && row.requires_password_setup),
      authProvider: "supabase", createdAt: row && row.created_at || now, updatedAt: now, lastLoginAt: now
    },
    profile: {
      id: profileId, accountId, supabaseUserId: authUser && authUser.id || row && row.auth_user_id || "",
      name, email: accountEmail, permission: permission(accountRole), accountPermission: permission(accountRole),
      mode: accountRole === "coach" || accountRole === "admin" ? "coach" : "player",
      handedness: row && row.handedness || "right", handicap: row && row.handicap || "", hcp: row && row.handicap || "",
      bag: row && row.bag_json || [], onboardingComplete: true, createdAt: row && row.created_at || now, updatedAt: now
    }
  };
}
async function findAccountByEmail(accountEmail) {
  const rows = await supabaseRest("app_accounts?select=*&email=eq." + encodeFilter(accountEmail) + "&limit=1", { method: "GET" });
  return Array.isArray(rows) && rows[0] || null;
}
async function upsertAccount(authUser, input) {
  const accountEmail = email(authUser && authUser.email || input && input.email);
  const existing = accountEmail ? await findAccountByEmail(accountEmail) : null;
  const pack = accountPayload(existing, authUser, input || {});
  const now = new Date().toISOString();
  await supabaseRest("app_accounts?on_conflict=account_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({
    account_id: pack.account.accountId, profile_id: pack.account.profileId, auth_user_id: authUser.id,
    email: pack.account.email, name: pack.account.name, role: pack.account.role,
    created_by_coach_id: pack.account.createdByCoachId || null, linked_coach_ids: pack.account.linkedCoachIds, linked_player_ids: pack.account.linkedPlayerIds,
    requires_password_setup: false, password_salt: null, password_hash: null,
    last_login_at: now, metadata: { source: "supabase-auth", authProvider: "supabase" }, updated_at: now
  }) });
  await supabaseRest("app_profiles?on_conflict=profile_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({
    profile_id: pack.profile.id, account_id: pack.account.accountId, auth_user_id: authUser.id,
    email: pack.profile.email, name: pack.profile.name, permission: pack.profile.permission,
    handedness: pack.profile.handedness || "right", handicap: pack.profile.handicap || "", bag_json: pack.profile.bag || [],
    profile_json: pack.profile, updated_at: now
  }) });
  await supabaseRest("app_sync_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
    account_id: pack.account.accountId, profile_id: pack.profile.id, event_type: input && input.eventType || "supabase_auth", status: "synced", payload_json: { email: pack.account.email, auth_user_id: authUser.id }
  }) });
  return pack;
}
module.exports = { anonKey, email, hasAuth, json, role, supabaseAuth, supabaseRest, text, upsertAccount };
