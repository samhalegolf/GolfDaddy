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
  const localAccountId = text(account.accountId || account.id || account.account_id || payload.accountId, 120);
  const localProfileId = text(account.profileId || account.profile_id || profile.id || profile.profileId || profile.profile_id || payload.profileId || (localAccountId ? "profile_" + localAccountId : ""), 120);
  const accountEmail = email(account.email || profile.email || payload.email);
  const name = text(account.name || profile.name || nameFromEmail(accountEmail) || "Clarity Player", 160);
  const role = normalRole(account.role || profile.accountPermission || profile.permission);
  const now = new Date().toISOString();

  if (!localAccountId) throw badRequest("Account id is required");
  if (!accountEmail) throw badRequest("Valid account email is required");

  // If this email already has a Supabase record under a different account id
  // (new device/browser, cleared storage), adopt the existing record instead of
  // rejecting with 409. Email is the identity; the server ids win.
  let accountId = localAccountId;
  let profileId = localProfileId;
  let merged = false;
  const existing = await supabaseFetch(
    "app_accounts?select=account_id,profile_id,email&email=eq." + encodeFilter(accountEmail) + "&account_id=neq." + encodeFilter(localAccountId) + "&limit=1",
    { method: "GET" }
  );
  if (Array.isArray(existing) && existing.length) {
    accountId = text(existing[0].account_id, 120) || localAccountId;
    profileId = text(existing[0].profile_id, 120) || localProfileId;
    merged = true;
  }

  /* COACH LINKS THE COACH ALREADY CUT MUST NOT COME BACK UP THIS PIPE.
   *
   * linked_coach_ids is pushed from whatever the device holds, and this runs on
   * every startup. When a coach removes a player (coach-unlink-player.js), only
   * the server rows change - the player's phone still has the coach in its
   * local list, and its next launch wrote the link straight back. The coach
   * watched the player they removed reappear in the roster the following day,
   * which reads as "the remove button is broken" all over again.
   *
   * So the unlink leaves a tombstone on the player's row and this filters
   * against it. A deliberate re-link is the one thing that lifts it: the player
   * entering the coach's code stamps restoreCoachIds, which is an explicit act
   * on this device rather than the same stale array arriving again.
   */
  /* THE DEVICE DOES NOT OWN THE EMAIL ONCE THE SERVER HAS ONE.
   *
   * This runs on every startup and pushes whatever the phone holds. When a
   * coach or an admin changes a player's login (account-change-email.js), only
   * the server rows move - the player's phone still has the old address, and
   * its next launch wrote that straight back over the new one. Supabase Auth
   * keeps the new address either way, so the account ends up signing in with
   * one address while every roster and every findAccountByEmail() lookup reads
   * the other: the split that endpoint takes such care to avoid, re-created
   * here a launch later.
   *
   * So a stored email wins. Every route that legitimately sets one - login,
   * signup, restore, Settings, the staff change - is server-side and writes the
   * row itself; this pipe has never been the place an address changes. The
   * device learns the new one from the accountEmail echoed back below. */
  const storedEmail = await storedAccountEmail(accountId);
  const effectiveEmail = storedEmail || accountEmail;

  const severed = await severedCoachIds(accountId);
  const restore = idList(account.restoreCoachIds || account.restore_coach_ids).filter(id => severed.includes(id));
  const stillSevered = severed.filter(id => !restore.includes(id));
  const linkedCoachIds = idList(account.linkedCoachIds || account.linked_coach_ids)
    .filter(id => !stillSevered.includes(id));

  await supabaseFetch("app_accounts?on_conflict=account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      account_id: accountId,
      profile_id: profileId,
      email: effectiveEmail,
      name,
      role,
      created_by_coach_id: text(account.createdByCoachId || account.created_by_coach_id, 120) || null,
      linked_coach_ids: linkedCoachIds,
      linked_player_ids: Array.isArray(account.linkedPlayerIds) ? account.linkedPlayerIds : (Array.isArray(account.linked_player_ids) ? account.linked_player_ids : []),
      requires_password_setup: !!(account.requiresPasswordSetup || account.requires_password_setup),
      auth_user_id: uuidOrNull(account.supabaseUserId || account.authUserId || account.auth_user_id),
      password_salt: null,
      password_hash: null,
      last_login_at: dateOrNull(account.lastLoginAt || account.last_login_at),
      metadata: stripUnsafe({
        /* Carried forward, never rebuilt from the client: this whole row is an
           upsert, so a key that is not written here is a key that is gone. */
        severedCoachIds: stillSevered,
        source: "clarity-caddie-web",
        action,
        syncedFromBrowserAt: now,
        createdAt: account.createdAt || account.created_at || null,
        updatedAt: account.updatedAt || account.updated_at || null,
        profileWasDerived: !(account.profileId || account.profile_id || profile.id || profile.profileId || profile.profile_id || payload.profileId),
        mergedFromLocalAccountId: merged ? localAccountId : null
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
      email: effectiveEmail,
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
      payload_json: {
        accountEmail: effectiveEmail,
        role,
        reason: text(payload.reason, 120),
        clientTime: payload.clientTime || null,
        /* Diagnostic breadcrumb from the client: which session identity fields
           changed to trigger this sync, with before/after values. Size-capped
           via JSON round-trip of a small object; nothing here is trusted. */
        sessionChange: payload.sessionChange && typeof payload.sessionChange === "object"
          ? {
              fields: Array.isArray(payload.sessionChange.fields) ? payload.sessionChange.fields.slice(0, 5).map((f) => text(f, 40)) : [],
              reason: text(payload.sessionChange.reason, 60),
              from: payload.sessionChange.from && typeof payload.sessionChange.from === "object" ? payload.sessionChange.from : null,
              to: payload.sessionChange.to && typeof payload.sessionChange.to === "object" ? payload.sessionChange.to : null
            }
          : null
      }
    })
  });

  return {
    configured: true,
    synced: true,
    accountId,
    profileId,
    /* The server's address, not the pushed one. clarity-cloud-sync adopts it,
       which is how a device whose login was changed for it finds out. */
    accountEmail: effectiveEmail,
    emailChanged: effectiveEmail !== accountEmail,
    pushedEmail: effectiveEmail !== accountEmail ? accountEmail : undefined,
    merged,
    localAccountId: merged ? localAccountId : undefined,
    localProfileId: merged ? localProfileId : undefined,
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

function idList(value) {
  return Array.isArray(value) ? value.map(item => text(item, 120)).filter(Boolean) : [];
}

/* The address the server already holds for this account, or "" when there is no
   row yet. Read before every account write for the same reason severedCoachIds
   is: this is an upsert of client-held state, and the client cannot know that
   somebody changed the account out from under it. */
async function storedAccountEmail(accountId) {
  if (!accountId) return "";
  let rows = [];
  try {
    rows = await supabaseFetch(
      "app_accounts?select=email&account_id=eq." + encodeFilter(accountId) + "&limit=1",
      { method: "GET" }
    );
  } catch (_error) {
    /* A lookup failure must not cost the caller their sync. Falling through to
       the pushed address is what this did for its whole life before the staff
       email change existed, so the failure mode is the old behaviour, not a
       lost account. */
    return "";
  }
  return Array.isArray(rows) && rows[0] ? email(rows[0].email) : "";
}

/* The coach links this account's own row says were cut. Read straight before
   every account write, because the write replaces the row's metadata wholesale
   and the client has no idea the tombstone exists. */
async function severedCoachIds(accountId) {
  if (!accountId) return [];
  let rows = [];
  try {
    rows = await supabaseFetch(
      "app_accounts?select=metadata&account_id=eq." + encodeFilter(accountId) + "&limit=1",
      { method: "GET" }
    );
  } catch (_error) {
    /* A lookup failure must not cost the caller their sync. The cost of
       guessing wrong here is one resurrected coach link, not a lost account. */
    return [];
  }
  const metadata = Array.isArray(rows) && rows[0] && rows[0].metadata || null;
  return metadata && typeof metadata === "object" ? idList(metadata.severedCoachIds) : [];
}

function stripUnsafe(value) {
  const copy = JSON.parse(JSON.stringify(value || {}));
  delete copy.password;
  delete copy.passwordConfirm;
  delete copy.password_hash;
  delete copy.passwordSalt;
  return copy;
}
