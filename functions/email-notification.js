const { email: authEmail, supabaseAuth, supabaseRest, upsertAccount } = require("./auth-utils");

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
    logoUrl: safeUrl(payload.logoUrl, siteUrl) || new URL("/assets/brand/cg-logo-white-g.png?v=f3bf5530", siteUrl).toString()
  };

  try{
    if(message.eventType === "account_created"){
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
function escapeHTML(value){ return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]; }); }
function firstName(value){ return (String(value || "there").trim().split(/\s+/)[0] || "there").replace(/[^\w'-]/g, "") || "there"; }
function subjectFor(message){ if(message.eventType === "password_recovery")return "Reset your Clarity password"; if(message.eventType === "account_created")return "Set up your Clarity account"; return "Clarity update: " + message.title; }
function isServiceEmail(message){ return ["account_created", "password_recovery"].indexOf(message.eventType) !== -1; }

function renderEmail(message){
  var recipientName = firstName(message.recipientName);
  var footer = isServiceEmail(message) ? "You are receiving this because it relates to your Clarity account access." : "You can change email notifications in Settings &gt; Notifications.";
  var html = ["<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>","<body style=\"margin:0;background:#07100b;color:#f7faf7;font-family:Arial,Helvetica,sans-serif\"><table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#07100b;padding:28px 14px\"><tr><td align=\"center\"><table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:560px;background:#101b15;border:1px solid #24342c;border-radius:20px;overflow:hidden\"><tr><td style=\"padding:24px 24px 16px;background:#07100b\"><img src=\"" + escapeHTML(message.logoUrl) + "\" width=\"44\" height=\"44\" alt=\"Clarity Golf\" style=\"vertical-align:middle;margin-right:12px\"><span style=\"font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#b9c4bd;font-weight:700\">Clarity Golf Systems</span></td></tr><tr><td style=\"padding:24px\"><p style=\"margin:0 0 10px;color:#42b66a;font-weight:700\">Hi " + escapeHTML(recipientName) + ",</p><h1 style=\"margin:0 0 12px;color:#fff;font-size:28px;line-height:1.05\">" + escapeHTML(message.title) + "</h1><p style=\"margin:0 0 18px;color:#c8d1cc;font-size:16px;line-height:1.45\">" + escapeHTML(message.detail) + "</p><p style=\"margin:0 0 22px;color:#8fa199;font-size:13px;line-height:1.4\">Update from " + escapeHTML(message.actorName) + ".</p><a href=\"" + escapeHTML(message.ctaUrl) + "\" style=\"display:inline-block;background:#ff9f2f;color:#06110b;text-decoration:none;font-weight:800;border-radius:999px;padding:12px 18px\">" + escapeHTML(message.ctaLabel) + "</a></td></tr><tr><td style=\"padding:16px 24px 24px;color:#708178;font-size:12px;line-height:1.45\">" + footer + "</td></tr></table></td></tr></table></body></html>"].join("");
  var body = ["Hi " + recipientName, "", message.title, "", message.detail, "", "Update from " + message.actorName + ".", "", message.ctaUrl].join("\n");
  return {html: html, text: body};
}

function json(statusCode, body){ return {statusCode: statusCode, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}, body: JSON.stringify(body)}; }
