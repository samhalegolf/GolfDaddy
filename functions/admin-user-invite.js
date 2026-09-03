"use strict";

const { email, hasAuth, json, role, supabaseAuth, supabaseRest, text, upsertAccount } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");
const { isStaffRole, resolveCaller } = require("./clarity-caller");
const { sendAccountSetupEmail } = require("./email-notification");
const { hasSupabase, writeCompedEntitlement } = require("./payment-utils");

function env(name) { return process.env[name] || ""; }
function siteUrl() { return (env("CLARITY_SITE_URL") || env("APP_URL") || "https://caddy.claritygolf.app").replace(/\/+$/, ""); }
function tempPassword() { return "Clarity-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + "!"; }
function cleanId(value) { return text(value, 120).replace(/[^a-zA-Z0-9_:-]/g, ""); }
function unique(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function(item) {
    item = cleanId(item);
    if (item && out.indexOf(item) === -1) out.push(item);
  });
  return out;
}

/* The setup email itself lives in functions/email-notification.js, rendering from
   scripts/gd-email-templates-core.js. This file used to carry its own hand-copied <table>
   layout - a third copy of the same brand, which is how a logo or footer change lands in two
   emails out of three. `comped` picks the variant that says "account ready AND here's your
   month" in ONE message rather than firing a second email a second later. */
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
  const generated = await supabaseAuth("admin/generate_link", { method: "POST", body: JSON.stringify({ type: "recovery", email: accountEmail, options: { redirect_to: siteUrl() + "/?claritySetPassword=1&clarityAccountSetup=1" } }) }, true);
  const link = generated && (generated.action_link || generated.actionLink || generated.properties && generated.properties.action_link);
  if (!link || !/^https?:\/\//.test(String(link))) throw new Error("Supabase did not return a setup link");
  return String(link);
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
  if (!accountEmail) return json(400, { error: "Enter a valid email" });

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
    const authUser = await createOrFindUser(accountEmail, name, accountRole);
    const pack = await upsertAccount(authUser, { accountId: targetAccountId, email: accountEmail, name, role: accountRole, coachId: actorAccountId || null, eventType: "admin_user_invite" });
    const playerId = pack && pack.account && pack.account.accountId || targetAccountId;
    const linkResult = accountRole === "player" ? await linkAccounts(actorAccountId, playerId) : { linked: false };
    if (linkResult.linked && pack && pack.account) {
      pack.account.linkedCoachIds = unique([].concat(pack.account.linkedCoachIds || [], [actorAccountId]));
      pack.account.createdByCoachId = pack.account.createdByCoachId || actorAccountId;
    }
    const link = await setupLink(accountEmail);

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

    const emailResult = await sendEmail(accountEmail, name, actorName, link, comped);
    return json(200, { ok: true, invited: true, linked: linkResult.linked, email: accountEmail, emailResult, comped: !!comped, compError, account: pack.account, profile: pack.profile });
  } catch (error) {
    await sendSystemAlert({ eventType: "admin_user_invite_failed", title: "Clarity account invite failed", detail: "A user invite could not create a setup-password link.", accountEmail, context: { status: error.status || null, details: error.body || error.message } });
    return json(error.status || 502, { error: error.message || "Could not invite user", details: error.body || null });
  }
};
