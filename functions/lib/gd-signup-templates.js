"use strict";

/* The Studio-managed email templates, server side.
 *
 * One place that knows how to read and write them, so the senders that need one - the coach
 * invite, the self-signup welcome, the coach-update notice and the Admin -> Users resend -
 * cannot drift into four ideas of what Clarity says. Studio edits the content;
 * scripts/gd-email-templates-core.js still owns the shell, the escaping and the final HTML,
 * and nothing here builds markup.
 *
 * The read is deliberately unfailable. A row that has never been written, a settings read
 * that errors, a field an admin cleared - all of them fall through to the code defaults in
 * the core, field by field. A welcome email is the first thing a customer sees; a blank one
 * is worse than a stale one.
 *
 * This file also owns the coach-update throttle, because "may I send this" is the same kind
 * of question as "what does it say" and both are asked by the same senders. */

const templates = require("../../scripts/gd-email-templates-core.js");
const { supabaseRest, text } = require("../auth-utils");

const KEYS = templates.EDITABLE_TEMPLATE_KEYS.slice();
/* Keys these shipped under before Coach Invite and Sign Up Welcome were separated. The
   migration renames the stored rows, but an environment where it has not run yet must still
   find an admin's saved copy rather than silently reverting them to the shipped default. */
const LEGACY_KEYS = { coach_invite_basic: ["player_signup_basic", "player_welcome"], coach_invite_comped: ["player_signup_comped"] };
const COACH_UPDATE_KEY = "coach_updated_account";
const THROTTLE_MINUTES = templates.COACH_UPDATE_THROTTLE_MINUTES;

function normaliseKey(key) { return templates.resolveTemplateKey(String(key || "").trim()); }
/* Which welcome template a coach-created account gets. The only input is whether the
   entitlement was actually written. */
function keyForComped(comped) { return templates.coachInviteKey(!!comped); }
function sanitise(key, input) {
  return templates.signupTemplate(normaliseKey(key), input && typeof input === "object" ? input : {});
}

/* Reads the stored row and hands back a complete template no matter what came back.
   `isDefault` and `error` are reported so Studio can say which of "never edited" and "could
   not be read" the admin is looking at - they need different responses. */
async function loadTemplate(key) {
  key = normaliseKey(key);
  const candidates = [key].concat(LEGACY_KEYS[key] || []);
  let row = null;
  let error = "";
  try {
    const rows = await supabaseRest(
      "caddy_email_templates?select=template_key,content_json,updated_at,updated_by_auth_user_id&template_key=in."
        + encodeURIComponent("(" + candidates.join(",") + ")"),
      { method: "GET" }
    );
    const list = Array.isArray(rows) ? rows : [];
    /* Current key first, then each legacy key in the order they were superseded. */
    for (const candidate of candidates) {
      row = list.find((r) => r.template_key === candidate) || null;
      if (row) break;
    }
  } catch (err) {
    error = (err && err.message) || "Template could not be read";
  }
  return {
    templateKey: key,
    template: sanitise(key, row && row.content_json),
    updatedAt: (row && row.updated_at) || null,
    updatedBy: (row && row.updated_by_auth_user_id) || null,
    isDefault: !row,
    error
  };
}

async function saveTemplate(key, input, actorAuthUserId) {
  key = normaliseKey(key);
  const template = sanitise(key, input);
  await supabaseRest("caddy_email_templates?on_conflict=template_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      template_key: key,
      content_json: template,
      updated_at: new Date().toISOString(),
      updated_by_auth_user_id: actorAuthUserId || null
    })
  });
  return { templateKey: key, template };
}

/* The safe variable set, resolved from canonical server-side facts only. Anything the browser
   claimed about the player never reaches here. */
function variablesFor(input) {
  input = input || {};
  const name = text(input.recipientName, 160) || text(input.email, 240) || "Player";
  const site = String(input.siteUrl || templates.DEFAULT_SITE).replace(/\/+$/, "");
  return Object.assign({
    firstName: (name.split(/\s+/)[0] || "there").replace(/[^\w'-]/g, "") || "there",
    fullName: name,
    email: text(input.email, 240),
    coachName: text(input.actorName, 120) || "Clarity Golf",
    appUrl: site,
    appStoreUrl: text(input.appStoreUrl, 900) || "",
    playStoreUrl: text(input.playStoreUrl, 900) || ""
  }, templates.accessVariables(input.comped));
}

/* Claim the right to send one coach-update email to this address.
 *
 * True means "you, and nobody else, may send now". False means one went out inside the
 * window and this one is DROPPED - not deferred, not queued. A coach saving a bag, then a
 * profile, then some shot data is one thing that happened to the player; three emails about
 * it is how a useful notification becomes something people filter.
 *
 * The atomicity lives in claim_caddy_email_throttle: the check and the claim are one
 * statement, so two saves a millisecond apart cannot both pass. A read-then-send here would
 * leave exactly that race.
 *
 * If the claim itself errors, the answer is NO. An unreachable throttle must not degrade into
 * an unthrottled sender - the whole point of this is that the volume has a ceiling. */
async function claimCoachUpdateSlot(recipientEmail, options) {
  options = options || {};
  const address = String(recipientEmail || "").trim().toLowerCase();
  if (!address) return { allowed: false, reason: "invalid_email" };
  const minutes = Number.isFinite(options.minutes) && options.minutes >= 0 ? options.minutes : THROTTLE_MINUTES;
  try {
    const claimed = await supabaseRest("rpc/claim_caddy_email_throttle", {
      method: "POST",
      body: JSON.stringify({ p_recipient_email: address, p_template_key: COACH_UPDATE_KEY, p_window_minutes: minutes })
    });
    const allowed = claimed === true || (Array.isArray(claimed) && claimed[0] === true);
    return allowed ? { allowed: true } : { allowed: false, reason: "throttled", windowMinutes: minutes };
  } catch (err) {
    return { allowed: false, reason: "throttle_unavailable", detail: (err && err.message) || "throttle check failed" };
  }
}

module.exports = {
  KEYS, LEGACY_KEYS, COACH_UPDATE_KEY, THROTTLE_MINUTES,
  normaliseKey, keyForComped, sanitise, loadTemplate, saveTemplate, variablesFor, claimCoachUpdateSlot
};
