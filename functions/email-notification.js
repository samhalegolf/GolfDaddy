const { email: authEmail, supabaseAuth, supabaseRest, upsertAccount } = require("./auth-utils");
const { appStoreUrl } = require("../clarity-caddy-app-store.js");
/* Wording, branding and the service/activity split all live in one place now - see the header
   of scripts/gd-email-templates-core.js. This file owns delivery and the Supabase side of an
   invite; it no longer owns a second copy of the layout. */
const templates = require("../scripts/gd-email-templates-core.js");

exports.handler = async function(event){
  if(event.httpMethod !== "POST")return json(405, {error: "Method not allowed"});

  var payload;
  try{ payload = JSON.parse(event.body || "{}"); }
  catch(error){ return json(400, {error: "Invalid JSON"}); }

  var to = email(payload.to);
  if(!to)return json(400, {error: "Recipient email is required"});

  var siteUrl = env("CLARITY_SITE_URL") || "https://caddy.claritygolf.app";
  var message = {
    to: to,
    recipientName: text(payload.recipientName, 120) || "there",
    actorName: text(payload.actorName, 120) || "Clarity",
    title: text(payload.title, 180) || "Your Clarity account was updated",
    detail: text(payload.detail, 1200),
    ctaLabel: text(payload.ctaLabel, 80) || "Open Clarity",
    ctaUrl: safeUrl(payload.ctaUrl, siteUrl),
    eventType: text(payload.eventType, 80) || "account_activity",
    appStoreUrl: "",
    logoUrl: safeUrl(payload.logoUrl, siteUrl) || new URL("/assets/brand/cg-logo-white-g.png?v=1e5a26e2", siteUrl).toString()
  };

  try{
    if(message.eventType === "account_created"){
      message.appStoreUrl = appStoreUrl();
      var invite = await createSetupLinkForAccount(message.to, message.recipientName, message.actorName, siteUrl);
      if(invite && invite.link){
        message.ctaLabel = "Set up your password";
        message.ctaUrl = invite.link;
        message.title = "Set up your Clarity account";
        message.detail = "Your Clarity Caddy account has been created by " + (message.actorName || "your coach") + ". Use the secure button below to set your password. This link is unique to your account.";
      }
      if(invite && invite.user && invite.user.id){
        await syncInvitedAccount(invite.user, payload, message);
      }
    }
  }catch(error){
    return json(error.status || 502, {error: "Could not prepare account email", details: error.body || error.message});
  }

  var rendered = renderEmail(message);
  var subject = text(payload.subject, 140) || subjectFor(message);
  var serviceEmail = isServiceEmail(message);

  if(!serviceEmail && env("EMAIL_NOTIFICATIONS_ENABLED") !== "1"){
    return json(202, {queued: true, provider: "disabled", setup: "Set EMAIL_NOTIFICATIONS_ENABLED=1 to send optional notification emails.", preview: {subject: subject, html: rendered.html, text: rendered.text}});
  }

  var resendKey = env("RESEND_API_KEY");
  if(!resendKey){
    return json(202, {queued: true, provider: "not_configured", setup: "Set RESEND_API_KEY and CLARITY_EMAIL_FROM in Netlify environment variables.", preview: {subject: subject, html: rendered.html, text: rendered.text}});
  }

  var from = env("CLARITY_EMAIL_FROM") || "Clarity Golf Systems <notifications@claritygolf.systems>";
  var response = await fetch("https://api.resend.com/emails", {method: "POST", headers: {"Authorization": "Bearer " + resendKey, "Content-Type": "application/json"}, body: JSON.stringify({from: from, to: [message.to], subject: subject, html: rendered.html, text: rendered.text})});
  var body = await response.json().catch(function(){return null;});
  if(!response.ok)return json(response.status, {error: "Email provider rejected the message", details: body});
  return json(200, {sent: true, provider: "resend", id: body && body.id || null});
};

function env(name){ return process.env[name] || ""; }
function text(value, limit){ var input = String(value || "").trim(); return input.length > limit ? input.slice(0, limit) : input; }
function email(value){ var input = text(value, 240).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : ""; }
function tempPassword(){ return "Clarity-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + "!"; }
function cleanId(value){ return text(value, 120).replace(/[^a-zA-Z0-9_:-]/g, ""); }
function unique(list){ var out = []; (Array.isArray(list) ? list : []).forEach(function(item){ item = cleanId(item); if(item && out.indexOf(item) === -1)out.push(item); }); return out; }

async function createSetupLinkForAccount(accountEmail, name, actorName, siteUrl){
  accountEmail = authEmail(accountEmail);
  if(!accountEmail)return {link: "", user: null};
  var user = null;
  try{
    var created = await supabaseAuth("admin/users", {method: "POST", body: JSON.stringify({email: accountEmail, password: tempPassword(), email_confirm: true, user_metadata: {name: name || accountEmail.split("@")[0], role: "player", invited: true, invited_by: actorName || "Clarity"}})}, true);
    user = created && (created.user || created) || null;
  }catch(error){
    if(error.status !== 400 && error.status !== 422)throw error;
  }
  var generated = await supabaseAuth("admin/generate_link", {method: "POST", body: JSON.stringify({type: "recovery", email: accountEmail, options: {redirect_to: String(siteUrl || "https://caddy.claritygolf.app").replace(/\/+$/, "") + "/?claritySetPassword=1"}})}, true);
  return {link: generated && (generated.action_link || generated.actionLink || generated.properties && generated.properties.action_link) || "", user: user};
}

async function syncInvitedAccount(authUser, payload, message){
  var creatorId = cleanId(payload.actorAccountId || "");
  var targetId = cleanId(payload.targetAccountId || "");
  var pack = await upsertAccount(authUser, {accountId: targetId, email: message.to, name: message.recipientName, role: "player", coachId: creatorId || null, eventType: "account_created_invite_synced"});
  var invitedId = pack && pack.account && pack.account.accountId || targetId;
  if(!creatorId || !invitedId || creatorId === invitedId)return pack;
  await linkAccounts(creatorId, invitedId);
  return pack;
}

async function linkAccounts(creatorId, invitedId){
  var creatorRows = await supabaseRest("app_accounts?select=account_id,linked_player_ids&account_id=eq." + encodeURIComponent(creatorId) + "&limit=1", {method: "GET"});
  var invitedRows = await supabaseRest("app_accounts?select=account_id,linked_coach_ids&account_id=eq." + encodeURIComponent(invitedId) + "&limit=1", {method: "GET"});
  var creator = Array.isArray(creatorRows) && creatorRows[0];
  var invited = Array.isArray(invitedRows) && invitedRows[0];
  if(creator){
    await supabaseRest("app_accounts?account_id=eq." + encodeURIComponent(creatorId), {method: "PATCH", headers: {Prefer: "return=minimal"}, body: JSON.stringify({linked_player_ids: unique([].concat(creator.linked_player_ids || [], [invitedId])), updated_at: new Date().toISOString()})});
  }
  if(invited){
    await supabaseRest("app_accounts?account_id=eq." + encodeURIComponent(invitedId), {method: "PATCH", headers: {Prefer: "return=minimal"}, body: JSON.stringify({linked_coach_ids: unique([].concat(invited.linked_coach_ids || [], [creatorId])), created_by_coach_id: creatorId, updated_at: new Date().toISOString()})});
  }
}

function safeUrl(value, fallbackOrigin){ if(!String(value || "").trim())return ""; try{ var url = new URL(String(value || ""), fallbackOrigin); return /^https?:$/.test(url.protocol) ? url.toString() : ""; }catch(error){ return ""; } }
function subjectFor(message){ return templates.compose(message.eventType, message).subject; }
function isServiceEmail(message){ return templates.isServiceEventType(message && message.eventType); }
function renderEmail(message){ return templates.render(message); }

function json(statusCode, body){ return {statusCode: statusCode, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}, body: JSON.stringify(body)}; }

/* ---------------------------------------------------------------------------
   Service senders used by other functions. Delivery only - every word they send
   comes from scripts/gd-email-templates-core.js, so Studio's Communications page
   is showing the real message rather than a second copy of it.
   --------------------------------------------------------------------------- */

/* One low-level send, so the Resend call, the from address and the failure shape are written
   once. A throw here is always email-only: by the time any of these run the account or the
   entitlement has been written, and it must not be rolled back or reported as un-done because
   a notification bounced. */
async function deliver(eventType, input, failureLabel){
  var resendKey = env("RESEND_API_KEY");
  if(!resendKey)return {sent: false, reason: "not_configured"};
  var built = templates.build(eventType, input);
  var from = env("CLARITY_EMAIL_FROM") || templates.DEFAULT_FROM;
  var response = await fetch("https://api.resend.com/emails", {method: "POST", headers: {"Authorization": "Bearer " + resendKey, "Content-Type": "application/json"}, body: JSON.stringify({from: from, to: [built.message.to], subject: built.subject, html: built.html, text: built.text})});
  var body = await response.json().catch(function(){ return null; });
  if(!response.ok){
    var failure = new Error(failureLabel);
    failure.status = response.status;
    failure.body = body;
    throw failure;
  }
  return {sent: true, id: body && body.id || null};
}

/* Comped-access notification, sent by payment-admin when an admin issues a comped membership
 * or promotional pass to an address on its own (NOT as part of creating the account - that is
 * sendAccountSetupEmail's comped variant, which says both things in one message).
 *
 * Two variants of the same copy, chosen by whether the address already has an account:
 *   - existing account: "it's already live on your account, open the app";
 *   - no account yet: the auth user is created here, via the same createSetupLinkForAccount
 *     the invite flow uses, and the CTA becomes their secure set-password link - so this
 *     email doubles as their first login. */
async function sendCompedAccessEmail(options){
  options = options || {};
  var to = email(options.to);
  if(!to)return {sent: false, reason: "invalid_email"};
  var siteUrl = env("CLARITY_SITE_URL") || templates.DEFAULT_SITE;
  var input = {
    to: to,
    siteUrl: siteUrl,
    recipientName: options.recipientName,
    actorName: options.issuedByName || "Clarity Golf",
    periodLabel: options.periodLabel,
    expiresLabel: options.expiresLabel,
    membership: options.membership !== false,
    hasAccount: !!options.hasAccount,
    ctaUrl: siteUrl,
    appStoreUrl: appStoreUrl()
  };
  if(!options.hasAccount){
    var invite = await createSetupLinkForAccount(to, options.recipientName, input.actorName, siteUrl);
    if(invite && invite.link)input.ctaUrl = invite.link;
  }
  return deliver("comped_access_granted", input, "Email provider rejected the comped-access message");
}

/* The account-setup email, sent by admin-user-invite when a coach or admin creates someone's
 * account. `comped` upgrades it in place rather than adding a second message: when an account
 * is created WITH a comped month, the player gets one email that sets their password and tells
 * them what they have, instead of two emails a second apart describing one event. */
async function sendAccountSetupEmail(options){
  options = options || {};
  var to = email(options.to);
  if(!to)return {sent: false, reason: "invalid_email"};
  if(!options.setupLink)return {sent: false, reason: "missing_setup_link"};
  var comped = options.comped || null;
  return deliver(comped ? "account_created_comped" : "account_created", {
    to: to,
    siteUrl: env("CLARITY_SITE_URL") || templates.DEFAULT_SITE,
    recipientName: options.recipientName,
    actorName: options.actorName || "your coach",
    ctaUrl: options.setupLink,
    appStoreUrl: appStoreUrl(),
    periodLabel: comped && comped.periodLabel,
    expiresLabel: comped && comped.expiresLabel,
    membership: comped ? comped.membership !== false : undefined
  }, "Email provider rejected the account setup message");
}

exports.sendCompedAccessEmail = sendCompedAccessEmail;
exports.sendAccountSetupEmail = sendAccountSetupEmail;
