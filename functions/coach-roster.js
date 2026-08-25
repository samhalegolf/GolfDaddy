"use strict";

/* A coach's players, with their profiles, straight from the server.
 *
 * WHY THIS EXISTS
 *
 * The coach/player relationship was device-local. A coach's linked_player_ids
 * arrived on login, but nothing ever fetched the linked players' account rows
 * or their profiles - so the roster only ever showed players created on that
 * same device, and tapping one whose profile row was missing fell through to
 * the coach's own profile. account-profiles.js solves the same shape of problem
 * for your own profiles; this is the coach-facing half.
 *
 * BOTH LINK DIRECTIONS ARE AUTHORITATIVE
 *
 * coach.linked_player_ids and player.linked_coach_ids are written by different
 * flows (invite, invite-code, Booking) and drift apart in practice - six real
 * players carried linked_coach_ids pointing at a coach whose linked_player_ids
 * had never been updated. A link claimed by either side is a link.
 *
 * IDENTITY IS TAKEN FROM THE TOKEN, NEVER FROM THE BODY.
 *
 * Same rule as account-profiles.js and account-delete.js. A coach id in the
 * body would let anyone read anyone else's players.
 *
 * READ-ONLY BY CONSTRUCTION
 *
 * No write verbs. Repairing the drift in linked_player_ids is a migration, not
 * something a read path should do behind the caller's back.
 */

const { hasAuth, hasAuthWithServiceKey, json, supabaseAuth, supabaseRest } = require("./auth-utils");

const MAX_PLAYERS = 500;

function encodeFilter(value) { return encodeURIComponent(String(value || "")); }
function cleanId(value) { return String(value || "").trim(); }
function idList(value) { return Array.isArray(value) ? value.map(cleanId).filter(Boolean) : []; }

function inList(ids) {
  return "(" + ids.map(function (id) { return '"' + String(id).replace(/"/g, "") + '"'; }).join(",") + ")";
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }

  if (!hasAuth() || !hasAuthWithServiceKey()) {
    return json(503, { error: "Supabase is not configured", code: "auth_not_configured" });
  }

  const accessToken = String(body.accessToken || body.access_token || "").trim();
  if (!accessToken) {
    return json(401, { error: "Sign in again to load your players", code: "token_required" });
  }

  let authUser;
  try {
    authUser = await supabaseAuth("user", {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken }
    }, false);
  } catch (_error) {
    return json(401, { error: "Your session has expired. Sign in again.", code: "invalid_token" });
  }

  if (!authUser || !authUser.id) {
    return json(401, { error: "Your session has expired. Sign in again.", code: "invalid_token" });
  }

  const authUserId = String(authUser.id);
  const accountEmail = String(authUser.email || "").toLowerCase();

  let coachRow = null;
  try {
    const byAuthId = await supabaseRest(
      "app_accounts?select=account_id,role,profile_id,linked_player_ids&auth_user_id=eq." + encodeFilter(authUserId) + "&limit=1",
      { method: "GET" }
    );
    coachRow = Array.isArray(byAuthId) && byAuthId[0] || null;
    if (!coachRow && accountEmail) {
      const byEmail = await supabaseRest(
        "app_accounts?select=account_id,role,profile_id,linked_player_ids&email=eq." + encodeFilter(accountEmail) + "&limit=1",
        { method: "GET" }
      );
      coachRow = Array.isArray(byEmail) && byEmail[0] || null;
    }
  } catch (_error) {
    return json(502, { error: "Could not reach the account store. Try again.", code: "lookup_failed" });
  }

  const coachId = coachRow && cleanId(coachRow.account_id) || "";
  if (!coachId) {
    return json(200, { ok: true, coachAccountId: "", players: [] });
  }

  const coachRole = String(coachRow.role || "player").toLowerCase();
  if (coachRole !== "coach" && coachRole !== "admin") {
    return json(403, { error: "This account is not a coach", code: "not_a_coach" });
  }

  /* Forward direction: the ids this coach claims. Reverse direction: the
     accounts that claim this coach. The coach's own id appears in the forward
     list on at least one live account, so it is dropped explicitly. */
  let reverseRows = [];
  try {
    /* linked_coach_ids is jsonb, so this is the PostgREST "contains" operator
       against a one-element array: linked_coach_ids @> '["acct_..."]'. */
    const containsCoach = "cs." + JSON.stringify([coachId]);
    reverseRows = await supabaseRest(
      "app_accounts?select=account_id&linked_coach_ids=" + encodeURIComponent(containsCoach) + "&limit=" + MAX_PLAYERS,
      { method: "GET" }
    );
  } catch (_error) {
    reverseRows = [];
  }

  const ids = [];
  const seen = Object.create(null);
  idList(coachRow.linked_player_ids)
    .concat((Array.isArray(reverseRows) ? reverseRows : []).map(function (row) { return cleanId(row && row.account_id); }))
    .forEach(function (id) {
      if (!id || id === coachId || seen[id]) return;
      seen[id] = true;
      ids.push(id);
    });

  if (!ids.length) {
    return json(200, { ok: true, coachAccountId: coachId, players: [] });
  }

  let accountRows = [];
  try {
    accountRows = await supabaseRest(
      "app_accounts?select=account_id,profile_id,name,email,role,requires_password_setup,linked_coach_ids,created_by_coach_id,created_at,updated_at" +
        "&account_id=in." + encodeURIComponent(inList(ids.slice(0, MAX_PLAYERS))),
      { method: "GET" }
    );
  } catch (_error) {
    return json(502, { error: "Could not load your players. Try again.", code: "accounts_failed" });
  }

  const accounts = (Array.isArray(accountRows) ? accountRows : []).filter(function (row) {
    const role = String(row && row.role || "player").toLowerCase();
    return row && cleanId(row.account_id) !== coachId && role !== "coach" && role !== "admin";
  });

  if (!accounts.length) {
    return json(200, { ok: true, coachAccountId: coachId, players: [] });
  }

  /* profile_json holds the client-side profile object the app uploaded, so the
     bag and shot data round-trip; the flat columns are the fallback for rows
     written before profile_json existed. Same contract as account-profiles.js. */
  let profileRows = [];
  try {
    profileRows = await supabaseRest(
      "app_profiles?select=profile_id,account_id,name,handedness,handicap,permission,bag_json,profile_json,updated_at" +
        "&account_id=in." + encodeURIComponent(inList(accounts.map(function (row) { return cleanId(row.account_id); }))) +
        "&order=updated_at.desc",
      { method: "GET" }
    );
  } catch (_error) {
    profileRows = [];
  }

  const profilesByAccount = Object.create(null);
  (Array.isArray(profileRows) ? profileRows : []).forEach(function (row) {
    const key = cleanId(row && row.account_id);
    if (!key) return;
    if (!profilesByAccount[key]) profilesByAccount[key] = [];
    profilesByAccount[key].push(row);
  });

  const players = accounts.map(function (row) {
    const accountId = cleanId(row.account_id);
    const rows = profilesByAccount[accountId] || [];
    /* Prefer the profile the account points at. Accounts that accumulated
       duplicates otherwise resolve to whichever row sorted first. */
    const preferred = rows.find(function (item) { return cleanId(item.profile_id) === cleanId(row.profile_id); }) || rows[0] || null;
    return {
      account: {
        accountId,
        profileId: cleanId(row.profile_id),
        name: row.name || "",
        email: row.email || "",
        role: "player",
        requiresPasswordSetup: !!row.requires_password_setup,
        linkedCoachIds: idList(row.linked_coach_ids),
        createdByCoachId: row.created_by_coach_id || null,
        createdAt: row.created_at || "",
        updatedAt: row.updated_at || ""
      },
      profile: preferred,
      profileCount: rows.length
    };
  });

  return json(200, { ok: true, coachAccountId: coachId, players });
};
