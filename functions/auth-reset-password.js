"use strict";

const { email, hasAuthWithServiceKey, json, supabaseAuth } = require("./auth-utils");
const { sendSystemAlert } = require("./alert-utils");

function env(name) { return process.env[name] || ""; }
function toHeader(headers = {}, keys = []) {
  const map = {};
  Object.keys(headers || {}).forEach(function (key) {
    map[String(key || "").toLowerCase()] = headers[key];
  });
  for (const key of keys) {
    const value = map[key.toLowerCase()];
    if (value) return String(value).split(",")[0].trim();
  }
  return "";
}
function safeOrigin(event) {
  const headers = event && event.headers || {};
  const protocol = toHeader(headers, ["x-forwarded-proto", "x-forwarded-scheme"]) || "https";
  const host = toHeader(headers, ["x-forwarded-host", "host"]);
  if (host) return (protocol || "https").replace(/:$/, "") + "://" + host.replace(/^\/+/, "").replace(/\/+$/, "");
  const referer = toHeader(headers, ["referer", "origin"]);
  try { return new URL(referer || "").origin.replace(/\/+$/, ""); } catch (_error) { return ""; }
}
function configuredSiteUrl(event) {
  return (env("CLARITY_SITE_URL") || env("APP_URL") || env("URL") || safeOrigin(event) || "https://clarity-caddie.netlify.app").replace(/\/+$/, "");
}
function deliveryConfig() {
  const resendKey = env("RESEND_API_KEY");
  if (!resendKey) return null;
  return {
    resendKey,
    from: env("CLARITY_EMAIL_FROM") || "Clarity Golf Systems <notifications@claritygolf.systems>"
  };
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
    return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[char] || char;
  });
}

async function sendRecoveryEmail(delivery, emailAddress, link, requestedAt) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + delivery.resendKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: delivery.from,
      to: [emailAddress],
      subject: "Reset your Clarity password",
      html: [
        "<!doctype html><html><body style=\"margin:0;background:#07100b;color:#f7faf7;font-family:Arial,Helvetica,sans-serif\">",
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"padding:28px 14px;background:#07100b\">",
        "<tr><td align=\"center\">",
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;background:#101b15;border:1px solid #24342c;border-radius:20px;overflow:hidden\">",
        "<tr><td style=\"padding:24px 24px 16px;background:#07100b\"><p style=\"margin:0 0 12px;color:#b9c4bd;font-size:13px;letter-spacing:.14em;text-transform:uppercase;\">Clarity Golf</p>",
        "<h1 style=\"margin:0 0 12px;color:#fff;font-size:28px;line-height:1.05\">Reset your password</h1>",
        "<p style=\"margin:0 0 18px;color:#c8d1cc;font-size:16px;line-height:1.45\">Use the button below to set a new password. This link expires soon.</p>",
        "<p><a href=\"" + escapeHtml(link) + "\" style=\"display:inline-block;background:#ff9f2f;color:#06110b;text-decoration:none;font-weight:800;border-radius:999px;padding:12px 18px\">Set new password</a></p>",
        "<p style=\"margin-top:16px;color:#8fa199;font-size:12px;line-height:1.45\">Requested on " + requestedAt + ".</p>",
        "</td></tr></table></td></tr></table></body></html>"
      ].join(""),
      text: [
        "Reset your Clarity password",
        "",
        "Use the button below to set a new password. This link expires soon.",
        link
      ].join("\n")
    })
  });
  const body = await response.json().catch(function () { return null; });
  if (!response.ok) {
    const error = new Error((body && (body.message || body.error)) || "Email provider rejected the message");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch (_error) { return json(400, { error: "Invalid JSON", code: "invalid_json" }); }
  const accountEmail = email(payload.email);
  if (!accountEmail) return json(400, { error: "Enter a valid email", code: "invalid_email" });

  if (!hasAuthWithServiceKey()) return json(503, { error: "Supabase Auth is not configured", code: "auth_not_configured" });
  const delivery = deliveryConfig();
  if (!delivery) return json(503, { error: "Email delivery is not configured. Set RESEND_API_KEY in Netlify environment variables.", code: "email_not_configured" });

  try {
    const redirectTo = configuredSiteUrl(event) + "/?claritySetPassword=1";
    const reset = await supabaseAuth("admin/generate_link", { method: "POST", body: JSON.stringify({ type: "recovery", email: accountEmail, options: { redirect_to: redirectTo } }) }, true);
    const resetUrl = reset && (reset.action_link || reset.actionLink || (reset.properties && reset.properties.action_link) || "");
    if (!resetUrl) return json(502, { error: "Could not generate a password reset link.", code: "reset_link_failed" });
    await sendRecoveryEmail(delivery, accountEmail, resetUrl, new Date().toISOString());
    return json(200, { ok: true, code: "password_reset_sent", sent: true });
  } catch (error) {
    await sendSystemAlert({
      eventType: "auth_reset_password_failed",
      title: "Password reset request failed",
      detail: "A password reset request could not be sent.",
      accountEmail,
      context: { status: error.status || null, details: error.body || error.message || String(error) }
    });
    return json(error.status || 502, { error: error.message || "Could not send password reset email", code: "reset_request_failed", details: error.body || null });
  }
};
