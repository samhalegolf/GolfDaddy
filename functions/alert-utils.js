"use strict";

const { getStore } = require("@netlify/blobs");

function env(name) {
  return process.env[name] || "";
}

function text(value, limit) {
  const input = String(value || "").trim();
  return input.length > limit ? input.slice(0, limit) : input;
}

function adminEmail() {
  return text(env("CLARITY_ALERT_EMAIL") || env("CLARITY_DEBUG_REPORT_TO") || env("SUPPORT_ALERT_EMAIL"), 240).toLowerCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function siteUrl() {
  return (env("CLARITY_SITE_URL") || env("APP_URL") || env("URL") || "https://clarity-caddie.netlify.app").replace(/\/+$/, "");
}

async function shouldSend(key, minutes) {
  const throttleMinutes = Number(minutes || env("CLARITY_ALERT_THROTTLE_MINUTES") || 45);
  const ttlMs = (Number.isFinite(throttleMinutes) && throttleMinutes > 0 ? throttleMinutes : 45) * 60 * 1000;
  try {
    const store = getStore("clarity-system-alerts");
    const safeKey = String(key || "general").replace(/[^a-z0-9_.:-]+/gi, "_").slice(0, 180);
    const existing = await store.get(safeKey, { type: "json" }).catch(() => null);
    if (existing && existing.sentAt && Date.now() - new Date(existing.sentAt).getTime() < ttlMs) return false;
    await store.setJSON(safeKey, { sentAt: new Date().toISOString() });
    return true;
  } catch (error) {
    return true;
  }
}

async function sendSystemAlert(input) {
  const to = adminEmail();
  if (!isEmail(to)) return { sent: false, reason: "missing_admin_email" };
  const resendKey = env("RESEND_API_KEY");
  if (!resendKey) return { sent: false, reason: "missing_resend_key" };

  const eventType = text(input && input.eventType, 80) || "system_alert";
  const title = text(input && input.title, 160) || "Clarity backend alert";
  const detail = text(input && input.detail, 2000) || "A backend action needs attention.";
  const accountEmail = text(input && input.accountEmail, 240);
  const context = input && input.context ? input.context : {};
  const throttleKey = eventType + ":" + (accountEmail || text(input && input.key, 100) || "global");
  const allowed = await shouldSend(throttleKey, input && input.throttleMinutes);
  if (!allowed) return { sent: false, reason: "throttled" };

  const from = env("CLARITY_EMAIL_FROM") || "Clarity Golf Systems <notifications@claritygolf.systems>";
  const subject = "Clarity alert: " + title;
  const dashboard = siteUrl();
  const contextText = JSON.stringify(context, null, 2).slice(0, 4000);
  const html = [
    "<div style=\"font-family:Arial,Helvetica,sans-serif;background:#07100b;color:#f7faf7;padding:24px\">",
    "<div style=\"max-width:620px;margin:0 auto;background:#101b15;border:1px solid #24342c;border-radius:18px;padding:22px\">",
    "<p style=\"color:#ff9f2f;font-weight:700;margin:0 0 8px\">Clarity Golf Systems</p>",
    "<h1 style=\"margin:0 0 12px;color:#fff\">" + escapeHTML(title) + "</h1>",
    "<p style=\"color:#c8d1cc;line-height:1.45\">" + escapeHTML(detail) + "</p>",
    accountEmail ? "<p><strong>Account:</strong> " + escapeHTML(accountEmail) + "</p>" : "",
    "<pre style=\"white-space:pre-wrap;background:#07100b;border-radius:12px;padding:12px;color:#b9c4bd\">" + escapeHTML(contextText) + "</pre>",
    "<p><a href=\"" + escapeHTML(dashboard) + "\" style=\"color:#ff9f2f\">Open Clarity</a></p>",
    "</div></div>"
  ].join("");
  const body = [title, "", detail, "", accountEmail ? "Account: " + accountEmail : "", "", contextText, "", dashboard].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + resendKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from, to: [to], subject, html, text: body })
  });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) return { sent: false, reason: "provider_rejected", details: responseBody };
  return { sent: true, id: responseBody && responseBody.id || null };
}

function escapeHTML(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

module.exports = { sendSystemAlert };
