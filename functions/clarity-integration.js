"use strict";

/**
 * The one deliberate seam between Clarity Booking and Clarity Caddy.
 *
 * Booking administers the coaching relationship; Caddy administers the golf
 * product. This endpoint is the narrow bridge: Booking can make sure a
 * coach-player relationship exists here, issue a pass, and read back enough
 * status to render a card. It deliberately does NOT let Booking manage
 * subscriptions, billing, or entitlement rules -- Caddy stays the source of
 * truth for all of that.
 *
 * Callers are either a signed-in coach/admin (bearer token) or Booking's server
 * (shared service secret). See clarity-caller.js.
 *
 * Actions:
 *   ensureRelationship  { coachAccountId|coachEmail, playerAuthUserId|playerEmail }
 *   issuePass           { playerAuthUserId|playerEmail, passType, issuedBy }
 *   playerStatus        { playerAuthUserId|playerEmail }
 */

const {
  MONTH_PASS_KEY,
  MONTH_PASS_HOURS,
  email,
  encodeFilter,
  json,
  hasSupabase,
  monthPassWindow,
  readPaidAccess,
  supabaseFetch,
  text
} = require("./payment-utils");
const { resolveCaller } = require("./clarity-caller");

/* Booking may only issue passes Caddy has agreed to expose. Memberships and
   anything billing-shaped stay out: those are Caddy's to manage. */
const ISSUABLE_PASS_TYPES = { month_pass: true };

function cleanId(value) {
  return text(value, 120).replace(/[^a-zA-Z0-9_:-]/g, "");
}

function unique(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (item) {
    const clean = cleanId(item);
    if (clean && out.indexOf(clean) === -1) out.push(clean);
  });
  return out;
}

/**
 * Finds a Caddy account by shared auth user id first, email second.
 *
 * The auth user id is the permanent link between the two systems. Email is a
 * fallback for accounts that predate the shared-auth work and have not signed
 * in since, and it is only ever used to find an existing row -- never to
 * create one.
 */
async function findAccount(authUserId, accountEmail) {
  const cleanAuthUserId = text(authUserId, 80);
  if (cleanAuthUserId) {
    const rows = await supabaseFetch(
      "app_accounts?select=*&auth_user_id=eq." + encodeFilter(cleanAuthUserId) + "&limit=1",
      { method: "GET" }
    ).catch(function () { return []; });
    const found = Array.isArray(rows) ? rows[0] : null;
    if (found) return found;
  }
  const cleanEmail = email(accountEmail);
  if (cleanEmail) {
    const rows = await supabaseFetch(
      "app_accounts?select=*&email=eq." + encodeFilter(cleanEmail) + "&limit=1",
      { method: "GET" }
    ).catch(function () { return []; });
    return Array.isArray(rows) ? rows[0] || null : null;
  }
  return null;
}

/**
 * Additive, idempotent. Running it twice changes nothing, and it never removes
 * a player from another coach: a player is an account that coaches have
 * relationships with, not something a coach owns.
 */
async function ensureRelationship(payload, caller) {
  const coachAccount = await findAccount(
    payload.coachAuthUserId,
    payload.coachEmail
  ) || (payload.coachAccountId ? await accountRow(payload.coachAccountId) : null)
    || (caller.kind === "user" ? caller.account : null);

  const playerAccount = await findAccount(payload.playerAuthUserId, payload.playerEmail);

  if (!coachAccount || !coachAccount.account_id) {
    return json(404, { ok: false, error: "coach_not_found", message: "That coach does not have a Clarity Caddy account." });
  }
  if (!playerAccount || !playerAccount.account_id) {
    return json(404, { ok: false, error: "player_not_found", message: "That player does not have a Clarity Caddy account yet." });
  }

  const coachId = cleanId(coachAccount.account_id);
  const playerId = cleanId(playerAccount.account_id);
  if (!coachId || !playerId || coachId === playerId) {
    return json(400, { ok: false, error: "invalid_relationship" });
  }

  const now = new Date().toISOString();
  const coachPlayers = unique([].concat(coachAccount.linked_player_ids || [], [playerId]));
  const playerCoaches = unique([].concat(playerAccount.linked_coach_ids || [], [coachId]));
  const alreadyLinked =
    (coachAccount.linked_player_ids || []).indexOf(playerId) !== -1 &&
    (playerAccount.linked_coach_ids || []).indexOf(coachId) !== -1;

  if (!alreadyLinked) {
    await supabaseFetch("app_accounts?account_id=eq." + encodeFilter(coachId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ linked_player_ids: coachPlayers, updated_at: now })
    });
    await supabaseFetch("app_accounts?account_id=eq." + encodeFilter(playerId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        linked_coach_ids: playerCoaches,
        /* Provenance only -- who first brought this player in. It is never used
           to gate access, so it must not be overwritten by a second coach. */
        created_by_coach_id: playerAccount.created_by_coach_id || coachId,
        updated_at: now
      })
    });
  }

  return json(200, {
    ok: true,
    linked: true,
    changed: !alreadyLinked,
    coachAccountId: coachId,
    playerAccountId: playerId,
    coachCount: playerCoaches.length
  });
}

async function accountRow(accountId) {
  const clean = cleanId(accountId);
  if (!clean) return null;
  const rows = await supabaseFetch(
    "app_accounts?select=*&account_id=eq." + encodeFilter(clean) + "&limit=1",
    { method: "GET" }
  ).catch(function () { return []; });
  return Array.isArray(rows) ? rows[0] || null : null;
}

/**
 * Issues a pass. Caddy remains the source of truth: this writes one
 * user_entitlements row and returns the resulting access state. Booking stores
 * only what it needs to show a card.
 */
async function issuePass(payload, caller) {
  const passType = text(payload.passType, 60) || MONTH_PASS_KEY;
  if (!ISSUABLE_PASS_TYPES[passType]) {
    return json(400, {
      ok: false,
      error: "unsupported_pass_type",
      message: "That pass type cannot be issued through the Booking integration."
    });
  }

  const playerAccount = await findAccount(payload.playerAuthUserId, payload.playerEmail);
  if (!playerAccount || !playerAccount.account_id) {
    return json(404, { ok: false, error: "player_not_found", message: "That player does not have a Clarity Caddy account yet." });
  }

  const window = monthPassWindow(Date.now());
  const issuedBy = text(payload.issuedBy, 160) ||
    (caller.account && caller.account.email) ||
    "clarity_booking";

  await supabaseFetch("user_entitlements", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: playerAccount.account_id,
      account_email: playerAccount.email || null,
      profile_id: playerAccount.profile_id || null,
      entitlement_type: passType,
      product_key: passType,
      status: "active",
      starts_at: window.starts_at,
      expires_at: window.expires_at,
      entitlement_reason: "booking_coach_issued",
      usage_count: 0,
      metadata: {
        source: "clarity_booking",
        pass_type: passType,
        duration_hours: MONTH_PASS_HOURS,
        issued_by: issuedBy,
        issued_via: caller.kind === "service" ? "booking_service" : "caddy_user",
        coach_account_id: caller.actorAccountId || null
      }
    })
  });

  const access = await readPaidAccess({
    accountId: playerAccount.account_id,
    accountEmail: playerAccount.email,
    profileId: playerAccount.profile_id
  }).catch(function () { return null; });

  return json(200, {
    ok: true,
    issued: true,
    passType,
    playerAccountId: playerAccount.account_id,
    startsAt: window.starts_at,
    expiresAt: window.expires_at,
    access: access ? { active: !!access.active, expiresAt: access.expiresAt || null } : null
  });
}

/**
 * Everything the Booking player profile needs to render its Caddy card, and
 * nothing more. Account existence and paid access are separate states, so both
 * are reported separately.
 */
async function playerStatus(payload, caller) {
  const playerAccount = await findAccount(payload.playerAuthUserId, payload.playerEmail);
  if (!playerAccount || !playerAccount.account_id) {
    return json(200, { ok: true, connected: false, access: "none", coachLinked: false });
  }

  const access = await readPaidAccess({
    accountId: playerAccount.account_id,
    accountEmail: playerAccount.email,
    profileId: playerAccount.profile_id
  }).catch(function () { return null; });

  const coachId = cleanId(caller.actorAccountId || "");
  const coachLinked = !!(
    coachId && (playerAccount.linked_coach_ids || []).indexOf(coachId) !== -1
  );

  return json(200, {
    ok: true,
    connected: true,
    playerAccountId: playerAccount.account_id,
    playerAuthUserId: playerAccount.auth_user_id || null,
    coachLinked,
    coachCount: (playerAccount.linked_coach_ids || []).length,
    access: access && access.active ? (access.access || "pass") : "free",
    active: !!(access && access.active),
    expiresAt: (access && access.expiresAt) || null
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed", allowed: ["POST"] });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch (_error) { return json(400, { error: "Invalid JSON" }); }

  let caller;
  try {
    caller = await resolveCaller(event, {
      actorAccountId: payload.coachAccountId || payload.actorAccountId || ""
    });
  } catch (error) {
    return json(error.status || 401, { error: error.message || "Sign in again", code: "token_invalid" });
  }
  if (!caller) {
    return json(401, { error: "Authentication required", code: "token_required" });
  }
  if (!caller.isStaff) {
    return json(403, { error: "Coach or admin access required" });
  }

  try {
    if (payload.action === "ensureRelationship") return await ensureRelationship(payload, caller);
    if (payload.action === "issuePass") return await issuePass(payload, caller);
    if (payload.action === "playerStatus") return await playerStatus(payload, caller);
    return json(400, { error: "Unknown action", allowed: ["ensureRelationship", "issuePass", "playerStatus"] });
  } catch (error) {
    return json(error.status || 502, {
      ok: false,
      error: "integration_failed",
      message: error.message || "Clarity integration request failed"
    });
  }
};
