exports.handler = async function(event){
  if(event.httpMethod !== "POST"){
    return json(405, {error: "Method not allowed"});
  }

  var payload;
  try{
    payload = JSON.parse(event.body || "{}");
  }catch(error){
    return json(400, {error: "Invalid JSON"});
  }

  var to = email(payload.to);
  if(!to)return json(400, {error: "Recipient email is required"});

  var siteUrl = env("CLARITY_SITE_URL") || "https://clarity-caddie.netlify.app";
  var message = {
    to: to,
    recipientName: text(payload.recipientName, 120) || "there",
    actorName: text(payload.actorName, 120) || "Clarity",
    title: text(payload.title, 180) || "Your Clarity account was updated",
    detail: text(payload.detail, 1200),
    ctaLabel: text(payload.ctaLabel, 80) || "Open Clarity",
    ctaUrl: safeUrl(payload.ctaUrl, siteUrl),
    eventType: text(payload.eventType, 80) || "account_activity",
    logoUrl: safeUrl(payload.logoUrl, siteUrl) || new URL("/assets/brand/cg-logo-white-g.png", siteUrl).toString()
  };

  var rendered = renderEmail(message);
  var subject = text(payload.subject, 140) || subjectFor(message);
  var serviceEmail = isServiceEmail(message);

  if(!serviceEmail && env("EMAIL_NOTIFICATIONS_ENABLED") !== "1"){
    return json(202, {
      queued: true,
      provider: "disabled",
      setup: "Set EMAIL_NOTIFICATIONS_ENABLED=1 to send optional notification emails.",
      preview: {subject: subject, html: rendered.html, text: rendered.text}
    });
  }

  var resendKey = env("RESEND_API_KEY");
  if(!resendKey){
    return json(202, {
      queued: true,
      provider: "not_configured",
      setup: "Set RESEND_API_KEY and CLARITY_EMAIL_FROM in Netlify environment variables.",
      preview: {subject: subject, html: rendered.html, text: rendered.text}
    });
  }

  var from = env("CLARITY_EMAIL_FROM") || "Clarity Golf Systems <notifications@claritygolf.systems>";
  var response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + resendKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: from,
      to: [message.to],
      subject: subject,
      html: rendered.html,
      text: rendered.text
    })
  });

  var body = await response.json().catch(function(){return null;});
  if(!response.ok){
    return json(response.status, {error: "Email provider rejected the message", details: body});
  }

  return json(200, {sent: true, provider: "resend", id: body && body.id || null});
};

function env(name){
  return process.env[name] || "";
}

function text(value, limit){
  var input = String(value || "").trim();
  return input.length > limit ? input.slice(0, limit) : input;
}

function email(value){
  var input = text(value, 240).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : "";
}

function safeUrl(value, fallbackOrigin){
  if(!String(value || "").trim())return "";
  try{
    var url = new URL(String(value || ""), fallbackOrigin);
    return /^https?:$/.test(url.protocol) ? url.toString() : "";
  }catch(error){
    return "";
  }
}

function escapeHTML(value){
  return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch];
  });
}

function firstName(value){
  return (String(value || "there").trim().split(/\s+/)[0] || "there").replace(/[^\w'-]/g, "") || "there";
}

function subjectFor(message){
  if(message.eventType === "password_recovery")return "Reset your Clarity password";
  if(message.eventType === "account_created")return "Your Clarity account is ready";
  return "Clarity update: " + message.title;
}

function isServiceEmail(message){
  return ["account_created", "password_recovery"].indexOf(message.eventType) !== -1;
}

function renderEmail(message){
  var recipientName = firstName(message.recipientName);
  var footer = isServiceEmail(message)
    ? "You are receiving this because it relates to your Clarity account access."
    : "You can change email notifications in Settings &gt; Notifications.";
  var html = [
    "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>",
    "<body style=\"margin:0;background:#07100b;color:#f7faf7;font-family:Arial,Helvetica,sans-serif\">",
    "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#07100b;padding:28px 14px\"><tr><td align=\"center\">",
    "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:560px;background:#101b15;border:1px solid #24342c;border-radius:20px;overflow:hidden\">",
    "<tr><td style=\"padding:24px 24px 16px;background:#07100b\"><img src=\"" + escapeHTML(message.logoUrl) + "\" width=\"44\" height=\"44\" alt=\"Clarity Golf\" style=\"vertical-align:middle;margin-right:12px\"><span style=\"font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#b9c4bd;font-weight:700\">Clarity Golf Systems</span></td></tr>",
    "<tr><td style=\"padding:24px\"><p style=\"margin:0 0 10px;color:#42b66a;font-weight:700\">Hi " + escapeHTML(recipientName) + ",</p>",
    "<h1 style=\"margin:0 0 12px;color:#fff;font-size:28px;line-height:1.05\">" + escapeHTML(message.title) + "</h1>",
    "<p style=\"margin:0 0 18px;color:#c8d1cc;font-size:16px;line-height:1.45\">" + escapeHTML(message.detail) + "</p>",
    "<p style=\"margin:0 0 22px;color:#8fa199;font-size:13px;line-height:1.4\">Update from " + escapeHTML(message.actorName) + ".</p>",
    "<a href=\"" + escapeHTML(message.ctaUrl) + "\" style=\"display:inline-block;background:#ff9f2f;color:#06110b;text-decoration:none;font-weight:800;border-radius:999px;padding:12px 18px\">" + escapeHTML(message.ctaLabel) + "</a>",
    "</td></tr>",
    "<tr><td style=\"padding:16px 24px 24px;color:#708178;font-size:12px;line-height:1.45\">" + footer + "</td></tr>",
    "</table></td></tr></table></body></html>"
  ].join("");
  var body = [
    "Hi " + recipientName + ",",
    "",
    message.title,
    "",
    message.detail,
    "",
    "Update from " + message.actorName + ".",
    "",
    message.ctaUrl
  ].join("\n");
  return {html: html, text: body};
}

function json(statusCode, body){
  return {
    statusCode: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
