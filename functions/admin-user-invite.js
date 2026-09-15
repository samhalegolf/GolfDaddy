"use strict";

const { claimCanonicalPlayer, email, findAccountByAuthUserId, findAccountById, hasAuth, json, role, supabaseAuth, supabaseRest, text, upsertAccount } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");
const { isStaffRole, resolveCaller } = require("./clarity-caller");
const { sendAccountSetupEmail } = require("./email-notification");
const { hasSupabase, writeCompedEntitlement } = require("./payment-utils");
const { buildSetupLink } = require("./lib/gd-setup-link.js");

function env(name) { return process.env[name] || ""; }
function siteUrl() { return (env("CLARITY_SITE_URL") || env("APP_URL") || "https://caddy.claritygolf.app").replace(/\/+$/, ""); }
function tempPassword() { return "Clarity-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + "!"; }
function cleanId(value) { return text(value, 120).replace(/[^a-zA-Z0-9_:-]/g, ""); }
function newId(prefix) { return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9); }
function unique(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function(item) {
    item = cleanId(item);
    if (item && out.indexOf(item) === -1) out.push(item);
  });
  return out;
}

/* This file decides WHICH welcome email is sent; it never decides what it says.
 *
 * `comped` is the whole decision: passed, the player gets the Comped Sign Up template, and it
 * is only ever passed once writeCompedEntitlement has actually returned a pass. Passed as
 * null - including when the comp was requested but failed - they get Basic Sign Up. That is
 * the only way the message can be trusted: an email that says access was included, sent to
 * someone who holds none, is worse than no email at all.
 *
 * Still ONE message either way. The copy comes from the Studio-managed template, resolved in
 * functions/email-notification.js and rendered by scripts/gd-email-templates-core.js. This
 * file used to carry its own hand-copied <table> layout - a third copy of the same brand,
 * which is how a logo or footer change lands in two emails out of three. */
async function sendEmail(to, name, actorName, setupLink, comped) {
  return sendAccountSetupEmail({ to, recipientName: name, actorName, setupLink, comped });
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
  // claritySetPassword drives the password-set flow (well-tested trigger);
  // clarityAccountSetup marks this as a NEW-account setup so the UI shows setup
  // wording ("Set up account") and telemetry uses the account-setup reason,
  // instead of the generic reset wording an invited user was getting.
  //
  // redirect_to is still sent, because it is what Supabase uses if we fall back to its
  // action_link. buildSetupLink prefers a link on our OWN domain so the tap opens the app
  // instead of a browser - see functions/lib/gd-setup-link.js.
  const generated = await supabaseAuth("admin/generate_link", { method: "POST", body: JSON.stringify({ type: "recovery", email: accountEmail, options: { redirect_to: siteUrl() + "/?claritySetPassword=1&clarityAccountSetup=1" } }) }, true);
  const built = buildSetupLink(generated, siteUrl(), { claritySetPassword: 1, clarityAccountSetup: 1 });
  if (!built.link || !/^https?:\/\//.test(String(built.link))) throw new Error("Supabase did not return a setup link");
  return String(built.link);
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

async function createProfileOnly(caller, body) {
  const coachId = cleanId(caller && caller.actorAccountId);
  if (!coachId) { const error = new Error("Coach account is not ready"); error.status = 409; throw error; }
  const accountId = newId("acct");
  const profileId = newId("profile");
  const now = new Date().toISOString();
  const name = text(body.name, 160) || "New Player";
  const profile = {
    id: profileId,
    accountId,
    supabaseUserId: "",
    name,
    email: "",
    permission: "player",
    accountPermission: "player",
    mode: "player",
    handedness: "right",
    handicap: "",
    hcp: "",
    bag: [],
    onboardingComplete: false,
    setupStage: "shot_data_first",
    createdAt: now,
    updatedAt: now
  };
  const account = {
    accountId,
    profileId,
    supabaseUserId: "",
    name,
    email: "",
    role: "player",
    authProvider: "profile_only",
    linkedCoachIds: [coachId],
    linkedPlayerIds: [],
    createdByCoachId: coachId,
    requiresPasswordSetup: false,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null
  };
  await supabaseRest("app_accounts?on_conflict=account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      account_id: accountId, profile_id: profileId, auth_user_id: null, email: null, name, role: "player",
      created_by_coach_id: coachId, linked_coach_ids: [coachId], linked_player_ids: [], requires_password_setup: false,
      metadata: { source: "coach-profile-only", setupStage: "shot_data_first" }, created_at: now, updated_at: now
    })
  });
  await supabaseRest("app_profiles?on_conflict=profile_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      profile_id: profileId, account_id: accountId, auth_user_id: null, email: null, name, permission: "player",
      handedness: "right", handicap: "", bag_json: [], profile_json: profile, updated_at: now
    })
  });
  await linkAccounts(coachId, accountId);
  await claimCanonicalPlayer(null, { accountId, profileId, name, email: "" });
  return { account, profile };
}

async function targetProfile(targetAccountId, caller) {
  if (!targetAccountId) return null;
  const account = await findAccountById(targetAccountId);
  if (!account) { const error = new Error("Player profile not found"); error.status = 404; throw error; }
  const coachId = cleanId(caller && caller.actorAccountId);
  const linked = unique(account.linked_coach_ids).indexOf(coachId) !== -1 || unique(caller && caller.account && caller.account.linked_player_ids).indexOf(targetAccountId) !== -1;
  if (!caller.isAdmin && !linked) { const error = new Error("That player is not linked to this coach"); error.status = 403; throw error; }
  if (account.auth_user_id) { const error = new Error("That profile already has a login"); error.status = 409; throw error; }
  const rows = await supabaseRest("app_profiles?select=*&profile_id=eq." + encodeURIComponent(account.profile_id) + "&limit=1", { method: "GET" });
  return { account, profile: Array.isArray(rows) && rows[0] || null };
}

async function claimInvitedPlayer(authUser, input) {
  let accountId = cleanId(input.accountId);
  let profileId = cleanId(input.profileId);
  const existingForAuth = await findAccountByAuthUserId(authUser && authUser.id);
  if (existingForAuth && accountId && existingForAuth.account_id !== accountId) {
    const error = new Error("That email already belongs to another Clarity account"); error.status = 409; throw error;
  }
  if (existingForAuth && !accountId) {
    accountId = cleanId(existingForAuth.account_id);
    profileId = cleanId(existingForAuth.profile_id);
  }
  if (accountId) {
    const rows = await supabaseRest("caddy_players?select=id,auth_user_id&account_id=eq." + encodeURIComponent(accountId) + "&limit=1", { method: "GET" });
    const player = Array.isArray(rows) && rows[0] || null;
    if (player) {
      if (player.auth_user_id && player.auth_user_id !== authUser.id) {
        const error = new Error("That profile is already claimed by another login"); error.status = 409; throw error;
      }
      await supabaseRest("caddy_players?id=eq." + encodeURIComponent(player.id), {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ auth_user_id: authUser.id, normalized_email: input.email, display_name: input.name, profile_id: profileId, updated_at: new Date().toISOString() })
      });
      return { accountId, profileId };
    }
  }
  const claimed = await claimCanonicalPlayer(authUser, input);
  return { accountId: claimed.accountId, profileId: claimed.profileId };
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
  const targetAccountId = cleanId(body.targetAccountId || body.accountId || "");
  /* An unticked checkbox is simply absent from the request, so anything that is not an
     affirmative value means "no comp" - never a default-on. */
  const compRequested = body.compedMonth === true || body.compedMonth === "true" || body.compedMonth === "on" || body.compedMonth === 1 || body.compedMonth === "1";
  const compHours = Number(body.compedHours);

  /* This endpoint creates Supabase Auth users, sends account-setup emails from
     the Clarity domain, and writes coach-player relationships. It used to take
     the actor straight from the request body with no verification at all, so
     anyone who knew the URL could invite any address and attach themselves as
     coach to any player. The caller is now established from a Supabase bearer
     token (a signed-in coach or admin) or the shared service secret (Booking's
     server), and the actor is whoever that resolves to -- not whoever the body
     claims. */
  let caller;
  try {
    caller = await resolveCaller(event, { actorAccountId: cleanId(body.actorAccountId || body.coachAccountId || "") });
  } catch (error) {
    return json(error.status || 401, { error: error.message || "Sign in again", code: "token_invalid" });
  }
  if (!caller) return json(401, { error: "Sign in as a coach or admin to invite a user", code: "token_required" });
  if (!caller.isStaff) return json(403, { error: "Coach or admin access required" });
  /* Only an admin may mint another coach or admin. A coach inviting someone can
     only create a player. */
  if (isStaffRole(accountRole) && !caller.isAdmin) {
    return json(403, { error: "Only an admin can invite a coach or admin account" });
  }
  /* Comping is an admin power, the same as Studio → Commerce. A coach may create a player;
     only an admin may hand out access that would otherwise be paid for. Refused loudly rather
     than dropped silently, so nobody believes they gave someone a month they did not. */
  if (compRequested && !caller.isAdmin) {
    return json(403, { error: "Only an admin can include comped access with a new account", code: "comp_admin_only" });
  }
  if (compRequested && !hasSupabase()) {
    return json(503, { error: "Entitlements are not configured, so comped access cannot be included", code: "entitlements_not_configured" });
  }
  const actorAccountId = cleanId(caller.actorAccountId || "");

  try {
    if (body.profileOnly === true) {
      const draft = await createProfileOnly(caller, body);
      return json(200, { ok: true, profileOnly: true, account: draft.account, profile: draft.profile });
    }
    if (!accountEmail) return json(400, { error: "Enter a valid email" });
    const draft = await targetProfile(targetAccountId, caller);
    const authUser = await createOrFindUser(accountEmail, name, accountRole);
    const submittedProfile = body.profileJson && typeof body.profileJson === "object" && !Array.isArray(body.profileJson) ? body.profileJson : null;
    const preservedProfile = submittedProfile || (draft && draft.profile && draft.profile.profile_json && typeof draft.profile.profile_json === "object" ? draft.profile.profile_json : {});
    const profileId = draft && draft.account && cleanId(draft.account.profile_id) || "";
    const canonical = await claimInvitedPlayer(authUser, { accountId: targetAccountId, profileId, email: accountEmail, name });
    const pack = await upsertAccount(authUser, {
      accountId: canonical.accountId, profileId: canonical.profileId, email: accountEmail, name, role: accountRole,
      coachId: actorAccountId || null, eventType: draft ? "coach_profile_completed" : "admin_user_invite",
      profileJson: preservedProfile, bag: Array.isArray(body.bag) ? body.bag : (draft && draft.profile && draft.profile.bag_json)
    });
    const playerId = pack && pack.account && pack.account.accountId || targetAccountId;
    const linkResult = accountRole === "player" ? await linkAccounts(actorAccountId, playerId) : { linked: false };
    if (linkResult.linked && pack && pack.account) {
      pack.account.linkedCoachIds = unique([].concat(pack.account.linkedCoachIds || [], [actorAccountId]));
      pack.account.createdByCoachId = pack.account.createdByCoachId || actorAccountId;
    }
    /* Order matters: the entitlement is written BEFORE the email goes out, so the message can
       state the real expiry date and the access is already live when they follow the link.
       A comp that fails to write downgrades the email to the plain setup version rather than
       promising a month that does not exist - and says so in the response, because the admin
       who ticked the box is the one who has to know. */
    let comped = null;
    let compError = "";
    if (compRequested) {
      try {
        const pass = await writeCompedEntitlement({
          accountEmail,
          accountId: playerId || "",
          durationHours: Number.isFinite(compHours) && compHours > 0 ? compHours : undefined,
          note: text(body.compedNote, 500) || "Included with account creation",
          issuedBy: (caller.account && caller.account.email) || actorName,
          issuedVia: "create_player_account"
        });
        comped = { periodLabel: pass.periodLabel, expiresLabel: pass.expiresLabel, membership: pass.membership };
      } catch (error) {
        compError = error && error.message ? error.message : "Comped access could not be issued";
        await sendSystemAlert({ eventType: "admin_user_invite_comp_failed", title: "Comped access failed on account creation", detail: "The account was created but the comped entitlement was not written.", accountEmail, context: { details: compError } });
      }
    }

    let emailResult = null;
    let emailError = "";
    try {
      const link = await setupLink(accountEmail);
      emailResult = await sendEmail(accountEmail, name, actorName, link, comped);
    } catch (error) {
      /* Account/profile creation is already complete. An email-provider or setup-link
         failure must not hide that usable profile from the coach or force a refresh;
         return the created rows and report the invitation as the separate failure it is. */
      emailError = error && error.message ? error.message : "Setup email could not be sent";
      await sendSystemAlert({ eventType: "admin_user_invite_email_failed", title: "Clarity profile created but setup email failed", detail: "The player profile is ready, but its setup email was not sent.", accountEmail, context: { details: error && (error.body || error.message) } });
    }
    return json(200, { ok: true, invited: !emailError, linked: linkResult.linked, email: accountEmail, emailResult, emailError, comped: !!comped, compError, account: pack.account, profile: pack.profile });
  } catch (error) {
    await sendSystemAlert({ eventType: "admin_user_invite_failed", title: "Clarity account invite failed", detail: "A user invite could not create a setup-password link.", accountEmail, context: { status: error.status || null, details: error.body || error.message } });
    return json(error.status || 502, { error: error.message || "Could not invite user", details: error.body || null });
  }
};
