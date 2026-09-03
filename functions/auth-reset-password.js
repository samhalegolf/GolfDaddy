"use strict";

const { email, hasAuthWithServiceKey, findAccountByEmail, json, supabaseAuth } = require("./auth-utils");
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
function ensureDeliveryConfigured() {
  const resendKey = env("RESEND_API_KEY");
  const from = env("CLARITY_EMAIL_FROM");
  if (!resendKey) return null;
  if (!from) return null;
  return { resendKey, from: from };
}
/* The layout and the wording come from scripts/gd-email-templates-core.js, like every other
   Clarity email. This used to carry its own <table> - a second brand to keep in step, and one
   the Studio Communications preview could only approximate. `requestedAt` is appended to the
   body rather than templated separately: it is the one fact this send has that the shared copy
   does not. */
const templates = require("../scripts/gd-email-templates-core.js");

async function sendRecoveryEmail(delivery, emailAddress, link, requestedAt) {
  const built = templates.build("password_recovery", {
    to: emailAddress,
    siteUrl: env("CLARITY_SITE_URL") || templates.DEFAULT_SITE,
    actorName: "Clarity Golf Systems",
    ctaUrl: link
  });
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + delivery.resendKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: delivery.from,
      to: [emailAddress],
      subject: built.subject,
      html: built.html,
      text: built.text + "\n\nRequested on " + requestedAt + "."
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
  const delivery = ensureDeliveryConfigured();
  if (!delivery) return json(503, { error: "Email delivery is not configured. Set RESEND_API_KEY and CLARITY_EMAIL_FROM.", code: "email_not_configured" });

  try {
    const existing = await findAccountByEmail(accountEmail);
    if (!existing) return json(404, { error: "No Clarity account found for this email.", code: "account_not_found" });
    const origin = safeOrigin(event) || "https://caddy.claritygolf.app";
    const redirectTo = origin + "/?claritySetPassword=1";
    const reset = await supabaseAuth("admin/generate_link", { method: "POST", body: JSON.stringify({ type: "recovery", email: accountEmail, options: { redirect_to: redirectTo } }) }, true);
    const resetUrl = reset && (reset.action_link || (reset.properties && reset.properties.action_link) || "");
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
