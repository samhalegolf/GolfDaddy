"use strict";

/* Take one player off a coach's roster. This is an UNLINK, not a delete.
 *
 * WHY THIS EXISTS
 *
 * Removing a player from the Players list used to call the admin account
 * delete, which destroys the account, the profile, the bag and the shot data.
 * A coach ending a coaching relationship is not asking for any of that - the
 * player keeps their account and their golf. This endpoint cuts the link and
 * touches nothing else.
 *
 * BOTH DIRECTIONS, OR IT DOES NOT HOLD
 *
 * coach-roster.js treats a link claimed by EITHER side as a link:
 * coach.linked_player_ids forward, player.linked_coach_ids reverse. Clearing
 * one side leaves the player in the roster on the next refresh, so both rows
 * are written here. The client cannot do the reverse half itself - the player's
 * row belongs to another account, and account-sync only ever writes your own.
 *
 * IDENTITY IS TAKEN FROM THE TOKEN, NEVER FROM THE BODY.
 *
 * Same rule as coach-roster.js and account-profile-delete.js. A coach id in the
 * body would let anyone rearrange anyone else's roster.
 *
 * IT NEVER DELETES ANYTHING.
 *
 * No row is removed, no account is touched beyond the two id arrays and
 * created_by_coach_id, which is dropped only when it names this coach so no
 * later flow can read it back as a live pairing. Deleting an account is
 * account-delete.js's job and asks for far more confirmation than this.
 *
 * RE-LINKING STILL WORKS, BOTH WAYS.
 *
 * The tombstone this leaves on the player's row (see below) suppresses only the
 * REVERSE claim arriving from that player's device. A player who enters the
 * coach's code again clears it explicitly - gdAccountConnectCoachByCode stamps
 * restoreCoachIds, which account-sync honours. A coach who adds the player back
 * writes the FORWARD claim, which the tombstone never touches and which is on
 * its own enough for coach-roster.js to list them.
 */

const { hasAuth, hasAuthWithServiceKey, json, supabaseAuth, supabaseRest } = require("./auth-utils");

function encodeFilter(value) { return encodeURIComponent(String(value || "")); }
function cleanId(value) { return String(value || "").trim(); }
function idList(value) {
  return Array.isArray(value) ? value.map(cleanId).filter(Boolean) : [];
}
function without(list, id) {
  const drop = cleanId(id);
  return idList(list).filter(function (item) { return item !== drop; });
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
    return json(401, { error: "Sign in again to change your players", code: "token_required" });
  }

  /* Only the TARGET comes from the body, and only under an unambiguous name.
     The caller's own identity is the token's, never the body's. */
  const playerAccountId = cleanId(body.playerAccountId || body.player_account_id);
  if (!playerAccountId) {
    return json(400, { error: "No player given", code: "player_required" });
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
      "app_accounts?select=account_id,role,linked_player_ids&auth_user_id=eq." + encodeFilter(authUserId) + "&limit=1",
      { method: "GET" }
    );
    coachRow = Array.isArray(byAuthId) && byAuthId[0] || null;
    if (!coachRow && accountEmail) {
      const byEmail = await supabaseRest(
        "app_accounts?select=account_id,role,linked_player_ids&email=eq." + encodeFilter(accountEmail) + "&limit=1",
        { method: "GET" }
      );
      coachRow = Array.isArray(byEmail) && byEmail[0] || null;
    }
  } catch (_error) {
    return json(502, { error: "Could not reach the account store. Try again.", code: "lookup_failed" });
  }

  const coachId = coachRow && cleanId(coachRow.account_id) || "";
  if (!coachId) {
    return json(404, { error: "No account found for this sign-in", code: "account_not_found" });
  }

  const coachRole = String(coachRow.role || "player").toLowerCase();
  if (coachRole !== "coach" && coachRole !== "admin") {
    return json(403, { error: "This account is not a coach", code: "not_a_coach" });
  }

  if (playerAccountId === coachId) {
    return json(400, { error: "That is your own account", code: "self_unlink" });
  }

  const now = new Date().toISOString();

  /* Forward half: the coach's own row. Written even when the id is not in the
     list, because the reverse half below may still be claiming the link. */
  let forwardChanged = false;
  try {
    const nextPlayerIds = without(coachRow.linked_player_ids, playerAccountId);
    forwardChanged = nextPlayerIds.length !== idList(coachRow.linked_player_ids).length;
    if (forwardChanged) {
      await supabaseRest(
        "app_accounts?account_id=eq." + encodeFilter(coachId),
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ linked_player_ids: nextPlayerIds, updated_at: now })
        }
      );
    }
  } catch (_error) {
    return json(502, { error: "Could not update your player list. Try again.", code: "coach_update_failed" });
  }

  /* Reverse half: the player's row. Read first so the coach id is stripped out
     of whatever is actually stored rather than overwritten with a guess - the
     player may be linked to other coaches, and those links are not this
     request's to drop. */
  let playerRow = null;
  try {
    const rows = await supabaseRest(
      "app_accounts?select=account_id,role,linked_coach_ids,created_by_coach_id,metadata&account_id=eq." + encodeFilter(playerAccountId) + "&limit=1",
      { method: "GET" }
    );
    playerRow = Array.isArray(rows) && rows[0] || null;
  } catch (_error) {
    return json(502, { error: "Could not load that player. Try again.", code: "lookup_failed" });
  }

  if (!playerRow) {
    /* The forward link is already gone and there is no row to clear. The caller
       wanted the player off the roster, so this is success. */
    return json(200, { ok: true, unlinked: forwardChanged, playerAccountId, coachAccountId: coachId });
  }

  try {
    const nextCoachIds = without(playerRow.linked_coach_ids, coachId);
    const dropCreator = cleanId(playerRow.created_by_coach_id) === coachId;
    /* THE TOMBSTONE. Clearing the array is not enough on its own.
     *
     * The player's phone still holds this coach in its own linked_coach_ids,
     * and account-sync pushes that array on every startup - so the link the
     * coach just cut came straight back on the player's next launch, and the
     * coach watched the removed player reappear. account-sync reads this list
     * and refuses to write back anything named in it. */
    const metadata = playerRow.metadata && typeof playerRow.metadata === "object" && !Array.isArray(playerRow.metadata)
      ? playerRow.metadata
      : {};
    const severed = idList(metadata.severedCoachIds);
    const nextSevered = severed.indexOf(coachId) === -1 ? severed.concat([coachId]) : severed;

    await supabaseRest(
      "app_accounts?account_id=eq." + encodeFilter(playerAccountId),
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(Object.assign(
          {
            linked_coach_ids: nextCoachIds,
            metadata: Object.assign({}, metadata, { severedCoachIds: nextSevered }),
            updated_at: now
          },
          dropCreator ? { created_by_coach_id: null } : {}
        ))
      }
    );
  } catch (_error) {
    return json(502, { error: "Could not update that player. Try again.", code: "player_update_failed" });
  }

  return json(200, {
    ok: true,
    unlinked: true,
    playerAccountId,
    coachAccountId: coachId
  });
};
