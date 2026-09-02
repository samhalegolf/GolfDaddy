"use strict";

/* Change the email a player signs in with, on behalf of a coach or an admin.
 *
 * WHY THIS IS ITS OWN ENDPOINT
 *
 * auth-update-account.js changes YOUR OWN email and takes the user id straight
 * from your access token, which is exactly right for Settings and useless here:
 * the account being changed belongs to somebody else. account-sync.js only ever
 * writes the row of the device that called it, so a coach cannot reach a
 * player's row through it either. Every other route a coach had for "this
 * player's email is wrong" ended at admin-user-invite (creates a SECOND
 * account) or gd67RemoveProfile (destroys the first one). Both were wrong
 * answers to the same question.
 *
 * WHAT A CHANGE ACTUALLY IS
 *
 * The email is the login. Three stores hold it and all three move together or
 * the account splits in half:
 *
 *   1. Supabase Auth  - what the password is checked against at sign-in.
 *   2. app_accounts   - what upsertAccount()/findAccountByEmail() key on, and
 *                       what coach-roster and the rosters display.
 *   3. app_profiles   - the profile row and its profile_json copy.
 *
 * Auth goes first, because it is the one that can refuse (the address may
 * already belong to another user). If it refuses, nothing else has moved.
 *
 * IDENTITY AND PRIVILEGE COME FROM THE TOKEN, NEVER FROM THE BODY.
 *
 * Same rule as admin-user-invite.js, which this borrows resolveCaller() from.
 * Only the TARGET and the NEW ADDRESS are read from the body. A coach may move
 * a player they are actually linked to and nobody else; only an admin may touch
 * an account that is not their own player, and neither may quietly move a coach
 * or admin account - that is an escalation route, because whoever holds the
 * address holds the password-reset link.
 *
 * NOBODY CHANGES THEIR OWN EMAIL HERE.
 *
 * Settings already does that, with the re-login handling this endpoint has no
 * way to perform on a remote device. Refusing keeps the audit trail honest:
 * every row this writes is one person acting on another person's account.
 *
 * THE ACCOUNT HOLDER IS ALWAYS TOLD.
 *
 * Both addresses are written to - the new one because that is now the login,
 * the old one because a login moving without warning is indistinguishable from
 * a takeover. Neither send can roll the change back; a mail failure is reported
 * in the response, not converted into a half-applied change.
 */

const { email, hasAuth, hasAuthWithServiceKey, json, supabaseAuth, supabaseRest, text } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");
const { accountById, isStaffRole, resolveCaller } = require("./clarity-caller");

function env(name) { return process.env[name] || ""; }
function siteUrl() { return (env("CLARITY_SITE_URL") || env("APP_URL") || "https://caddy.claritygolf.app").replace(/\/+$/, ""); }
function encodeFilter(value) { return encodeURIComponent(String(value || "")); }
function cleanId(value) { return text(value, 120); }
function idList(value) { return Array.isArray(value) ? value.map(cleanId).filter(Boolean) : []; }
function escapeHTML(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}
function firstName(value) { return (String(value || "there").trim().split(/\s+/)[0] || "there").replace(/[^\w'-]/g, "") || "there"; }

function roleLabel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "admin") return "Admin";
  if (raw === "coach") return "Coach";
  return "Clarity";
}

/* The actor as the account holder will read it: a name they recognise, and the
   authority behind it. "your coach" rather than a bare blank when a service
   caller has no account row to name. */
function actorLabel(caller) {
  const account = caller && caller.account;
  const name = text(account && (account.name || account.email), 160);
  const label = roleLabel(account && account.role);
  if (name) return label === "Clarity" ? name : name + " (" + label + ")";
  return caller && caller.isAdmin ? "a Clarity admin" : "your coach";
}

/* ---------- email ---------- */

function emailShell(bodyRows) {
  const logoUrl = siteUrl() + "/assets/brand/cg-logo-white-g.png?v=1e5a26e2";
  return [
    "<!doctype html><html><body style=\"margin:0;background:#07100b;color:#f7faf7;font-family:Arial,Helvetica,sans-serif\">",
    "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#07100b;padding:28px 14px\"><tr><td align=\"center\">",
    "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:560px;background:#101b15;border:1px solid #24342c;border-radius:20px;overflow:hidden\">",
    "<tr><td style=\"padding:24px 24px 16px;background:#07100b\"><img src=\"" + escapeHTML(logoUrl) + "\" width=\"44\" height=\"44\" alt=\"Clarity Golf\" style=\"vertical-align:middle;margin-right:12px\"><span style=\"font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#b9c4bd;font-weight:700\">Clarity Golf Systems</span></td></tr>",
    bodyRows,
    "</table></td></tr></table></body></html>"
  ].join("");
}

function changeEmailHtml(input) {
  const rows = [
    "<tr><td style=\"padding:24px\"><p style=\"margin:0 0 10px;color:#42b66a;font-weight:700\">Hi " + escapeHTML(firstName(input.name)) + ",</p>",
    "<h1 style=\"margin:0 0 12px;color:#fff;font-size:28px;line-height:1.05\">" + escapeHTML(input.heading) + "</h1>",
    "<p style=\"margin:0 0 18px;color:#c8d1cc;font-size:16px;line-height:1.45\">" + escapeHTML(input.detail) + "</p>",
    "<table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" style=\"width:100%;border:1px solid #24342c;border-radius:14px;margin:0 0 18px\">",
    "<tr><td style=\"padding:12px 14px;color:#8fa199;font-size:13px\">Previous sign-in</td><td style=\"padding:12px 14px;color:#c8d1cc;font-size:14px\">" + escapeHTML(input.previousEmail) + "</td></tr>",
    "<tr><td style=\"padding:12px 14px;color:#8fa199;font-size:13px;border-top:1px solid #24342c\">New sign-in</td><td style=\"padding:12px 14px;color:#fff;font-size:14px;font-weight:700;border-top:1px solid #24342c\">" + escapeHTML(input.nextEmail) + "</td></tr>",
    "</table>",
    "<a href=\"" + escapeHTML(siteUrl()) + "\" style=\"display:inline-block;background:#ff9f2f;color:#06110b;text-decoration:none;font-weight:800;border-radius:999px;padding:12px 18px\">Open Clarity Caddy</a>",
    "<p style=\"margin:18px 0 0;color:#8fa199;font-size:13px;line-height:1.4\">Your password has not changed. If you were not expecting this, reply to this email or contact " + escapeHTML(input.actor) + " straight away.</p>",
    "</td></tr><tr><td style=\"padding:16px 24px 24px;color:#708178;font-size:12px;line-height:1.45\">You are receiving this because it relates to your Clarity account access.</td></tr>"
  ].join("");
  return emailShell(rows);
}

async function sendChangeEmail(to, input) {
  const resendKey = env("RESEND_API_KEY");
  if (!resendKey) return { sent: false, provider: "not_configured" };
  const from = env("CLARITY_EMAIL_FROM") || "Clarity Golf Systems <notifications@claritygolf.app>";
  const html = changeEmailHtml(input);
  const plain = [
    "Hi " + firstName(input.name) + ",",
    "",
    input.heading,
    "",
    input.detail,
    "",
    "Previous sign-in: " + input.previousEmail,
    "New sign-in: " + input.nextEmail,
    "",
    "Your password has not changed. If you were not expecting this, contact " + input.actor + " straight away.",
    "",
    siteUrl()
  ].join("\n");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + resendKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: input.subject, html, text: plain })
  });
  const body = await response.json().catch(function () { return null; });
  if (!response.ok) return { sent: false, provider: "resend", status: response.status, details: body };
  return { sent: true, provider: "resend", id: (body && body.id) || null };
}

/* ---------- lookups ---------- */

/* The Supabase Auth user behind an app_accounts row. auth_user_id is the direct
   answer; the email lookup is the fallback for rows written before that column
   was populated, and it looks up the OLD address because that is still what
   Auth holds at this point. */
async function authUserFor(row) {
  const stored = text(row && row.auth_user_id, 80);
  if (stored) return { id: stored };
  const rowEmail = email(row && row.email);
  if (!rowEmail) return null;
  const listing = await supabaseAuth("admin/users?email=" + encodeURIComponent(rowEmail), { method: "GET" }, true)
    .catch(function () { return null; });
  const users = Array.isArray(listing && listing.users) ? listing.users : (Array.isArray(listing) ? listing : []);
  const found = users.find(function (user) { return email(user && user.email) === rowEmail; });
  return found || null;
}

/* Every account already holding the address, whichever store holds it. Both are
   checked because they can disagree, and adopting an address that is live in
   either one merges two people into one login. */
async function addressTaken(nextEmail, targetAccountId) {
  const rows = await supabaseRest(
    "app_accounts?select=account_id,name,role,email&email=eq." + encodeFilter(nextEmail) + "&limit=2",
    { method: "GET" }
  ).catch(function () { return []; });
  const clash = (Array.isArray(rows) ? rows : []).find(function (row) {
    return cleanId(row && row.account_id) !== targetAccountId;
  });
  if (clash) return { taken: true, where: "app_accounts", role: clash.role || "player" };

  const listing = await supabaseAuth("admin/users?email=" + encodeURIComponent(nextEmail), { method: "GET" }, true)
    .catch(function () { return null; });
  const users = Array.isArray(listing && listing.users) ? listing.users : (Array.isArray(listing) ? listing : []);
  if (users.some(function (user) { return email(user && user.email) === nextEmail; })) {
    return { taken: true, where: "auth" };
  }
  return { taken: false };
}

/* A coach may move a player they actually coach. Both link directions count,
   for the same reason coach-roster.js counts both: the invite, the coach code
   and Booking each write a different half, and they drift. */
function coachOwnsPlayer(callerAccount, targetRow) {
  const coachId = cleanId(callerAccount && callerAccount.account_id);
  const targetId = cleanId(targetRow && targetRow.account_id);
  if (!coachId || !targetId) return false;
  if (idList(callerAccount && callerAccount.linked_player_ids).indexOf(targetId) !== -1) return true;
  return idList(targetRow && targetRow.linked_coach_ids).indexOf(coachId) !== -1;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { error: "Invalid JSON" }); }

  if (!hasAuth() || !hasAuthWithServiceKey()) {
    return json(503, { error: "Supabase is not configured", code: "auth_not_configured" });
  }

  let caller;
  try {
    caller = await resolveCaller(event, { actorAccountId: cleanId(body.actorAccountId || "") });
  } catch (error) {
    return json(error.status || 401, { error: error.message || "Sign in again", code: "token_invalid" });
  }
  if (!caller) return json(401, { error: "Sign in as a coach or admin to change a login email", code: "token_required" });
  if (!caller.isStaff) return json(403, { error: "Coach or admin access required", code: "not_staff" });

  const targetAccountId = cleanId(body.targetAccountId || body.accountId);
  if (!targetAccountId) return json(400, { error: "No account given", code: "account_required" });

  const nextEmail = email(body.email);
  if (!nextEmail) return json(400, { error: "Enter a valid email", code: "invalid_email" });

  let targetRow;
  try {
    targetRow = await accountById(targetAccountId);
  } catch (_error) {
    return json(502, { error: "Could not reach the account store. Try again.", code: "lookup_failed" });
  }
  if (!targetRow) return json(404, { error: "Account not found", code: "account_not_found" });

  const callerAccountId = cleanId(caller.actorAccountId);
  if (callerAccountId && callerAccountId === targetAccountId) {
    return json(400, {
      error: "Change your own email in Settings, so you can sign in again straight away.",
      code: "self_change"
    });
  }

  /* Whoever holds the address holds the password-reset link, so moving a coach
     or admin address is moving the keys to staff privilege. Admins keep that
     power; a coach never gets it, even over their own linked account. */
  if (isStaffRole(targetRow.role) && !caller.isAdmin) {
    return json(403, { error: "Only an admin can change a coach or admin login email", code: "staff_target" });
  }
  if (!caller.isAdmin && !coachOwnsPlayer(caller.account, targetRow)) {
    return json(403, { error: "That player is not on your roster", code: "not_your_player" });
  }

  const previousEmail = email(targetRow.email);
  if (previousEmail && previousEmail === nextEmail) {
    return json(200, {
      ok: true,
      changed: false,
      accountId: targetAccountId,
      email: nextEmail,
      previousEmail,
      message: "That is already the login email for this account."
    });
  }

  const taken = await addressTaken(nextEmail, targetAccountId);
  if (taken.taken) {
    return json(409, {
      error: "That email already has a Clarity account. Use a different address, or remove the other account first.",
      code: "email_in_use"
    });
  }

  /* Auth first. It is the store that can refuse, and a refusal here has to
     leave every other store untouched rather than half-moved. */
  let authUser = null;
  try {
    authUser = await authUserFor(targetRow);
  } catch (_error) {
    authUser = null;
  }

  let loginUpdated = false;
  if (authUser && authUser.id) {
    try {
      /* email_confirm marks the new address confirmed on the spot. Without it
         GoTrue parks the change in email_change until the holder clicks a
         confirmation link, which is precisely the state a coach fixing a typo
         cannot get their player out of - the player cannot read mail at the
         address that is wrong. Only user_metadata keys that are sent are
         touched, so name and role are left alone by omitting the field. */
      await supabaseAuth("admin/users/" + encodeURIComponent(authUser.id), {
        method: "PUT",
        body: JSON.stringify({ email: nextEmail, email_confirm: true })
      }, true);
      loginUpdated = true;
    } catch (error) {
      const conflict = error && (error.status === 409 || error.status === 422);
      return json(conflict ? 409 : (error.status || 502), {
        error: conflict
          ? "That email already has a Clarity account. Use a different address, or remove the other account first."
          : "Could not update the sign-in email. Nothing was changed.",
        code: conflict ? "email_in_use" : "auth_update_failed",
        details: (error && error.body) || null
      });
    }
  }

  const now = new Date().toISOString();

  /* metadata is a whole-column write everywhere else in this codebase, so it is
     read and merged rather than replaced - dropping severedCoachIds here would
     resurrect coach links the player's own device is still pushing. */
  const metadata = targetRow.metadata && typeof targetRow.metadata === "object" && !Array.isArray(targetRow.metadata)
    ? targetRow.metadata
    : {};
  const history = Array.isArray(metadata.emailChanges) ? metadata.emailChanges.slice(-9) : [];
  history.push({
    at: now,
    from: previousEmail || null,
    to: nextEmail,
    byAccountId: callerAccountId || null,
    byName: text(caller.account && caller.account.name, 160) || null,
    byRole: caller.isAdmin ? "admin" : "coach",
    via: caller.kind === "service" ? "service" : "app"
  });

  try {
    await supabaseRest("app_accounts?account_id=eq." + encodeFilter(targetAccountId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        email: nextEmail,
        auth_user_id: (authUser && authUser.id) || targetRow.auth_user_id || null,
        metadata: Object.assign({}, metadata, { emailChanges: history }),
        updated_at: now
      })
    });
  } catch (error) {
    /* Auth has already moved and the account row has not. Left alone that is a
       split account: the password is checked against one address and every
       roster reads the other. Put Auth back first - it is one call, and the
       holder ends up exactly where they started - and only alert if even that
       fails, because then the split is real and needs a human. */
    let rolledBack = false;
    if (loginUpdated && previousEmail && authUser && authUser.id) {
      try {
        await supabaseAuth("admin/users/" + encodeURIComponent(authUser.id), {
          method: "PUT",
          body: JSON.stringify({ email: previousEmail, email_confirm: true })
        }, true);
        rolledBack = true;
      } catch (_rollbackError) { rolledBack = false; }
    }
    if (rolledBack) {
      return json(502, {
        error: "Could not save the new email. Nothing was changed - the account still signs in with " + previousEmail + ".",
        code: "account_row_update_failed"
      });
    }
    await sendSystemAlert({
      eventType: "account_email_change_split",
      title: "Login email changed in Auth but not in app_accounts",
      detail: "The Supabase Auth email moved but the app_accounts row did not. The account is split until this is repaired.",
      accountEmail: nextEmail,
      context: { targetAccountId, previousEmail, nextEmail, status: error.status || null, details: error.body || error.message }
    });
    return json(502, {
      error: "The sign-in email changed but the account record did not. Support has been alerted.",
      code: "account_row_update_failed"
    });
  }

  /* The profile row carries its own copy of the email, and profile_json carries
     a third inside it. A profile left on the old address shows the old address
     everywhere the roster reads a profile. */
  let profileUpdated = false;
  try {
    const profiles = await supabaseRest(
      "app_profiles?select=profile_id,profile_json&account_id=eq." + encodeFilter(targetAccountId) + "&limit=20",
      { method: "GET" }
    );
    const rows = Array.isArray(profiles) ? profiles : [];
    for (const profileRow of rows) {
      const profileId = cleanId(profileRow && profileRow.profile_id);
      if (!profileId) continue;
      const profileJson = profileRow.profile_json && typeof profileRow.profile_json === "object" && !Array.isArray(profileRow.profile_json)
        ? Object.assign({}, profileRow.profile_json, { email: nextEmail, updatedAt: now })
        : profileRow.profile_json;
      await supabaseRest("app_profiles?profile_id=eq." + encodeFilter(profileId), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ email: nextEmail, profile_json: profileJson, updated_at: now })
      });
      profileUpdated = true;
    }
  } catch (_error) {
    /* Not fatal: the login and the account row - the two stores that decide who
       can sign in - are already consistent. Reported so a stale profile email
       cannot rot unnoticed. */
    await sendSystemAlert({
      eventType: "account_email_change_profile_stale",
      title: "Login email changed but a profile row kept the old address",
      detail: "app_accounts and Supabase Auth moved; app_profiles did not.",
      accountEmail: nextEmail,
      context: { targetAccountId, previousEmail, nextEmail }
    });
  }

  await supabaseRest("app_sync_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      account_id: targetAccountId,
      profile_id: cleanId(targetRow.profile_id) || null,
      event_type: "account_email_changed",
      status: "synced",
      payload_json: {
        previousEmail: previousEmail || null,
        email: nextEmail,
        byAccountId: callerAccountId || null,
        byRole: caller.isAdmin ? "admin" : "coach",
        loginUpdated,
        profileUpdated
      }
    })
  }).catch(function () { /* the audit row is a breadcrumb, not the change */ });

  const actor = actorLabel(caller);
  const holderName = text(targetRow.name, 160) || nextEmail.split("@")[0];
  const notified = { next: { sent: false }, previous: { sent: false } };

  try {
    notified.next = await sendChangeEmail(nextEmail, {
      name: holderName,
      actor,
      heading: "Your Clarity sign-in email has changed",
      detail: "Your Clarity Caddy login email was changed to " + nextEmail + " by " + actor + ". Sign in with this address from now on.",
      subject: "Your Clarity sign-in email has changed",
      previousEmail: previousEmail || "Not set",
      nextEmail
    });
  } catch (_error) { notified.next = { sent: false, provider: "error" }; }

  /* The old address is told too. A login that moves without warning is
     indistinguishable from a takeover, and the old address is the only one the
     holder can still be reached at if the new one is wrong. */
  if (previousEmail) {
    try {
      notified.previous = await sendChangeEmail(previousEmail, {
        name: holderName,
        actor,
        heading: "Your Clarity sign-in email has changed",
        detail: "The login email for your Clarity Caddy account was changed from " + previousEmail + " to " + nextEmail + " by " + actor + ". This address can no longer sign in.",
        subject: "Your Clarity sign-in email has changed",
        previousEmail,
        nextEmail
      });
    } catch (_error) { notified.previous = { sent: false, provider: "error" }; }
  }

  return json(200, {
    ok: true,
    changed: true,
    accountId: targetAccountId,
    profileId: cleanId(targetRow.profile_id) || "",
    email: nextEmail,
    previousEmail: previousEmail || "",
    loginUpdated,
    profileUpdated,
    notified,
    changedBy: { name: text(caller.account && caller.account.name, 160) || "", role: caller.isAdmin ? "admin" : "coach" }
  });
};
