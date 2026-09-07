"use strict";

/* The Studio-managed welcome templates, server side.
 *
 * One place that knows how to read and write a welcome template, so the three senders that
 * need one - the signup endpoint, the generic notification endpoint and the Admin -> Users
 * resend - cannot drift into three ideas of what "the welcome email" says. Studio edits the
 * content; scripts/gd-email-templates-core.js still owns the shell, the escaping and the
 * final HTML, and nothing here builds markup.
 *
 * The read is deliberately unfailable. A row that has never been written, a settings read
 * that errors, a field an admin cleared - all of them fall through to the code defaults in
 * the core, field by field. A signup email is the first thing a customer sees; a blank one
 * is worse than a stale one. */

const templates = require("../../scripts/gd-email-templates-core.js");
const { supabaseRest, text } = require("../auth-utils");

const KEYS = templates.SIGNUP_TEMPLATE_KEYS.slice();
/* The key the first version of this shipped under. It still resolves to Basic Sign Up so an
   older caller, or a stored row nobody has migrated, cannot fall through to un-editable copy. */
const LEGACY_KEY = "player_welcome";

function normaliseKey(key) {
  const input = String(key || "").trim();
  if (templates.isSignupTemplateKey(input)) return input;
  return KEYS[0];
}
function keyForComped(comped) { return templates.signupTemplateKey(!!comped); }

function sanitise(key, input) {
  return templates.signupTemplate(normaliseKey(key), input && typeof input === "object" ? input : {});
}

/* Reads the stored row and hands back a complete template no matter what came back. `isDefault`
   and `error` are reported so Studio can say which of "never edited" and "could not be read"
   the admin is looking at - they need different responses. */
async function loadTemplate(key) {
  key = normaliseKey(key);
  let row = null;
  let error = "";
  try {
    const wanted = key === KEYS[0] ? "(" + key + "," + LEGACY_KEY + ")" : "(" + key + ")";
    const rows = await supabaseRest(
      "caddy_email_templates?select=template_key,content_json,updated_at,updated_by_auth_user_id&template_key=in." + encodeURIComponent(wanted),
      { method: "GET" }
    );
    const list = Array.isArray(rows) ? rows : [];
    row = list.find((r) => r.template_key === key) || list.find((r) => r.template_key === LEGACY_KEY) || null;
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
    appStoreUrl: text(input.appStoreUrl, 900) || ""
  }, templates.accessVariables(input.comped));
}

module.exports = { KEYS, LEGACY_KEY, normaliseKey, keyForComped, sanitise, loadTemplate, saveTemplate, variablesFor };
