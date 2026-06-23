"use strict";

const {
  email,
  encodeFilter,
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");
const { sendSystemAlert } = require("./alert-utils");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed", synced: false });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON", synced: false });
  }

  const action = text(payload.action || "upsert_account", 80);
  if (!hasSupabase()) {
    await sendSystemAlert({
      eventType: "supabase_not_configured",
      title: "Supabase is not configured",
      detail: "An account action was blocked because Supabase environment variables are missing.",
      accountEmail: payload && payload.account && payload.account.email,
      context: { action }
    });
    return json(503, { configured: false, synced: false, error: "Supabase is not configured. Account was not confirmed." });
  }

  try {
    if (action === "upsert_account" || action === "create_account" || action === "update_account" || action === "login_check") {
      const result = await upsertAccount(payload, action);
      return json(200, result);
    }
    if (action === "diagnostics") {
      const result = await diagnostics(payload);
      return json(200, result);
    }
    return json(400, { error: "Unsupported account sync action", synced: false });
  } catch (error) {
    await sendSystemAlert({
      eventType: "supabase_account_sync_failed",
      title: "Supabase account sync failed",
      detail: "An account/profile write or check failed. The app should not treat this account as confirmed until this is fixed.",
      accountEmail: payload && payload.account && payload.account.email,
      context: { action, status: error.status || null, details: error.body || error.message || String(error) }
    });
    return json(error.status || 502, {
      configured: true,
      synced: false,
      error: "Could not confirm account in Supabase",
      details: error.body || error.message || String(error)
    });
  }
};

async function upsertAccount(payload, action) {
  const account = payload.account || {};
  const profile = payload.profile || {};
  const accountId = text(account.accountId || account.id || account.account_id || payload.accountId, 120);
  const profileId = text(account.profileId || account.profile_id || profile.id || profile.profileId || profile.profile_id || payload.profileId || (accountId ? "profile_" + accountId : ""), 120);
  const accountEmail = email(account.email || profile.email || payload.email);
  const name = text(account.name || profile.name || nameFromEmail(accountEmail) || "Clarity Player", 160);
  const role = normalRole(account.role || profile.accountPermission || profile.permission);
  const now = new Date().toISOString();

  if (!accountId) throw badRequest("Account id is required");
  if (!accountEmail) throw badRequest("Valid account email is required");

  const duplicate = await supabaseFetch(
    "app_accounts?select=account_id,email&email=eq." + encodeFilter(accountEmail) + "&account_id=neq." + encodeFilter(accountId) + "&limit=1",
    { method: "GET" }
  );
  if (Array.isArray(duplicate) && duplicate.length) {
    const error = new Error("Email already exists in Supabase");
    error.status = 409;
    error.body = { error: "That email already has a Supabase account record." };
    throw error;
  }

  await supabaseFetch("app_accounts?on_conflict=account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      account_id: accountId,
      profile_id: profileId,
      email: accountEmail,
      name,
      role,
      created_by_coach_id: text(account.createdByCoachId || account.created_by_coach_id, 120) || null,
      linked_coach_ids: Array.isArray(account.linkedCoachIds) ? account.linkedCoachIds : (Array.isArray(account.linked_coach_ids) ? account.linked_coach_ids : []),
      linked_player_ids: Array.isArray(account.linkedPlayerIds) ? account.linkedPlayerIds : (Array.isArray(account.linked_player_ids) ? account.linked_player_ids : []),
      requires_password_setup: !!(account.requiresPasswordSetup || account.requires_password_setup),
      auth_user_id: uuidOrNull(account.supabaseUserId || account.authUserId || account.auth_user_id),
      password_salt: null,
      password_hash: null,
      last_login_at: dateOrNull(account.lastLoginAt || account.last_login_at),
      metadata: stripUnsafe({
        source: "clarity-caddie-web",
        action,
        syncedFromBrowserAt: now,
        createdAt: account.createdAt || account.created_at || null,
        updatedAt: account.updatedAt || account.updated_at || null,
        profileWasDerived: !(account.profileId || account.profile_id || profile.id || profile.profileId || profile.profile_id || payload.profileId)
      }),
      updated_at: now
    })
  });

  await supabaseFetch("app_profiles?on_conflict=profile_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      profile_id: profileId,
      account_id: accountId,
      auth_user_id: uuidOrNull(account.supabaseUserId || account.authUserId || account.auth_user_id || profile.supabaseUserId || profile.authUserId || profile.auth_user_id),
      email: accountEmail,
      name,
      permission: normalPermission(profile.accountPermission || profile.permission || role),
      handedness: text(profile.handedness, 40) || "right",
      handicap: text(profile.handicap || profile.hcp, 80),
      bag_json: Array.isArray(profile.bag) ? profile.bag : [],
      profile_json: stripUnsafe(profile),
      updated_at: now
    })
  });

  await supabaseFetch("app_sync_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      account_id: accountId,
      profile_id: profileId,
      event_type: action,
      status: "synced",
      payload_json: { accountEmail, role, reason: text(payload.reason, 120), clientTime: payload.clientTime || null }
    })
  });

  return {
    configured: true,
    synced: true,
    accountId,
    profileId,
    accountEmail,
    checkedAt: now
  };
}

async function diagnostics(payload) {
  const accountId = text(payload.accountId, 120);
  const accountEmail = email(payload.email || payload.accountEmail);
  const result = { configured: true, synced: true, checkedAt: new Date().toISOString(), account: null, profile: null, entitlements: [] };
  if (accountId || accountEmail) {
    const accountFilters = [];
    if (accountId) accountFilters.push("account_id.eq." + encodeFilter(accountId));
    if (accountEmail) accountFilters.push("email.eq." + encodeFilter(accountEmail));
    const accounts = await supabaseFetch("app_accounts?select=*&or=(" + accountFilters.join(",") + ")&limit=1", { method: "GET" });
    result.account = Array.isArray(accounts) && accounts[0] || null;
    const profileId = result.account && result.account.profile_id;
    if (profileId) {
      const profiles = await supabaseFetch("app_profiles?select=*&profile_id=eq." + encodeFilter(profileId) + "&limit=1", { method: "GET" });
      result.profile = Array.isArray(profiles) && profiles[0] || null;
    }
  }
  return result;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.body = { error: message };
  return error;
}

function normalRole(value) {
  const raw = String(value || "player").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (raw === "admin") return "admin";
  if (raw === "coach") return "coach";
  if (raw === "subscribed" || raw === "subscriber" || raw === "subscribedplayer") return "subscribedPlayer";
  return "player";
}

function normalPermission(value) {
  const role = normalRole(value);
  if (role === "admin") return "admin";
  if (role === "coach") return "coach";
  return role === "subscribedPlayer" ? "subscribed" : "player";
}

function nameFromEmail(value) {
  const clean = email(value);
  if (!clean) return "";
  const local = clean.split("@")[0].replace(/[._-]+/g, " ").trim();
  return local ? local.replace(/\b\w/g, c => c.toUpperCase()) : "";
}

function uuidOrNull(value) {
  const raw = text(value, 80);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
}

function dateOrNull(value) {
  const raw = text(value, 80);
  return raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

function stripUnsafe(value) {
  const copy = JSON.parse(JSON.stringify(value || {}));
  delete copy.password;
  delete copy.passwordConfirm;
  delete copy.password_hash;
  delete copy.passwordSalt;
  return copy;
}
