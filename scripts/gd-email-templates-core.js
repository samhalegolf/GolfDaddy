/* Clarity outbound email - the single template renderer and the catalogue of what gets sent.
 *
 * Loaded two ways, and must stay portable between them:
 *   - Netlify functions, via require("../scripts/gd-email-templates-core.js")
 *   - browser, via <script> in index.html, as window.GDEmailTemplatesCore (Studio's
 *     Communications page renders live previews from it)
 *
 * Why one file. The wording, the branding and the send/suppress rules for outbound mail were
 * spread across functions/email-notification.js, functions/admin-user-invite.js and
 * scripts/clarity-email.js, each with its own hand-copied <table> layout - and the client's
 * copy was never even delivered, since the endpoint always rendered its own. Three copies of
 * one brand is how a logo change lands in two emails out of three, and - worse for the
 * operator - there was nowhere to LOOK to answer "what does Clarity email people, and why".
 * Both problems have the same fix: the templates and the reasons live in one place, and every
 * sender renders from it.
 *
 * Keep this file free of platform APIs (no fetch, no process.env, no localStorage, no window
 * beyond the export tail). Callers own delivery; this owns what the message says.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GDEmailTemplatesCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_SITE = "https://caddy.claritygolf.app";
  var DEFAULT_FROM = "Clarity Golf Systems <notifications@claritygolf.systems>";
  var LOGO_PATH = "/assets/brand/cg-logo-white-g.png?v=1e5a26e2";
  var APP_STORE_BADGE = "/download-on-the-app-store-apple-logo.svg";

  /* A "service" email describes a change to the recipient's own account access. It is sent
     regardless of the EMAIL_NOTIFICATIONS_ENABLED switch and regardless of the recipient's
     notification preference, because suppressing it would leave someone holding an account
     or an entitlement they were never told about. Everything else is an "activity" email and
     is opt-in at both levels. */
  var SERVICE_EVENT_TYPES = [
    "account_created",
    "account_created_comped",
    "password_recovery",
    "comped_access_granted",
    "sign_in_email_changed"
  ];

  /* ---------------------------------------------------------------------------
     The catalogue: every outbound email, what fires it, and what gates it.
     Studio's Communications page renders this verbatim - so a new sender that is
     not listed here is a sender nobody can audit. Keep them in step.
     --------------------------------------------------------------------------- */
  var CATALOGUE = [
    {
      id: "account_created",
      eventType: "account_created",
      label: "Set up your Clarity account",
      category: "service",
      recipient: "The new player or coach whose account was just created",
      trigger: "A coach or admin creates an account from Profile → Players → Create Player Account, or Booking invites a user.",
      gating: "Always sends. Service email: not subject to EMAIL_NOTIFICATIONS_ENABLED or the recipient's notification preference.",
      sender: "functions/admin-user-invite.js",
      cta: "A single-use Supabase recovery link that sets their password and signs them in.",
      sample: {
        recipientName: "Alex Fenwick",
        actorName: "Sam Hale",
        ctaUrl: DEFAULT_SITE + "/?claritySetPassword=1"
      }
    },
    {
      id: "account_created_comped",
      eventType: "account_created_comped",
      label: "Set up your account + comped access (one email)",
      category: "service",
      recipient: "The new player, when the account was created with comped access ticked",
      trigger: 'Create Player Account with "Include a comped month" ticked. Replaces the plain setup email — the comp is described in the same message, so the player gets one email, not two.',
      gating: "Always sends. Service email. Skipped only if the account creation itself failed.",
      sender: "functions/admin-user-invite.js",
      cta: "The same set-password link. Their access is already live when they arrive.",
      sample: {
        recipientName: "Alex Fenwick",
        actorName: "Sam Hale",
        periodLabel: "a month",
        expiresLabel: "3 October 2026",
        membership: true,
        ctaUrl: DEFAULT_SITE + "/?claritySetPassword=1"
      }
    },
    {
      id: "comped_access_granted",
      eventType: "comped_access_granted",
      label: "You've been given comped access",
      category: "service",
      recipient: "Whoever the pass was issued to, by email address",
      trigger: 'Studio → Commerce → Issue comped access, for an address that already has an account (or one being created by the pass itself). Untick "Email them about it" to issue silently.',
      gating: "Always sends when the tick is on. Service email. A send failure is reported but never rolls the pass back.",
      sender: "functions/payment-admin.js → functions/email-notification.js",
      cta: "Open Clarity, or a set-password link when the address has no account yet.",
      sample: {
        recipientName: "Alex Fenwick",
        actorName: "Clarity Golf",
        periodLabel: "a month",
        expiresLabel: "3 October 2026",
        membership: true,
        hasAccount: true
      }
    },
    {
      id: "password_recovery",
      eventType: "password_recovery",
      label: "Reset your Clarity password",
      category: "service",
      recipient: "Whoever asked for the reset",
      trigger: "Forgot password on the sign-in screen.",
      gating: "Always sends. Service email. Answers the same way whether or not the address has an account, so it cannot be used to enumerate users.",
      sender: "functions/auth-reset-password.js",
      cta: "A single-use Supabase recovery link.",
      sample: {
        recipientName: "Alex Fenwick",
        actorName: "Clarity Golf Systems",
        ctaUrl: DEFAULT_SITE + "/?clarityResetPassword=1"
      }
    },
    {
      id: "sign_in_email_changed",
      eventType: "sign_in_email_changed",
      label: "Your Clarity sign-in email has changed",
      category: "service",
      recipient: "Both the old and the new address",
      trigger: "A coach or admin changes the email a player signs in with.",
      gating: "Always sends, to both addresses. Service email — the old address has to be told, or an account move is indistinguishable from a takeover.",
      sender: "functions/account-change-email.js",
      cta: "Open Clarity.",
      /* The only sender that still owns its own layout, deliberately: it prints a
         previous/new address table and a "your password has not changed" security line, and
         the shared single-detail layout has nowhere to put either. Flagged so the preview does
         not quietly claim to be the real thing. */
      previewNote: "This sender keeps its own layout — it adds a previous/new address table and a security line the shared template has no slot for. The preview below shows the wording and branding, not that extra block.",
      sample: {
        recipientName: "Alex Fenwick",
        actorName: "Sam Hale",
        detail: "Your Clarity sign-in email was changed from alex.old@example.com to alex@example.com by Sam Hale."
      }
    },
    {
      id: "account_activity",
      eventType: "account_activity",
      label: "Connected-account activity",
      category: "activity",
      recipient: "A linked coach, or a linked player",
      trigger: "A bag, shot, profile or account save by someone you are linked to (scripts/clarity-email.js wraps those save functions).",
      gating: "Opt-in twice over: the server needs EMAIL_NOTIFICATIONS_ENABLED=1, AND the recipient needs email notifications on in Settings → Notifications, with the matching coach/player direction still enabled.",
      sender: "scripts/clarity-email.js → functions/email-notification.js",
      cta: "Open Clarity.",
      sample: {
        recipientName: "Alex Fenwick",
        actorName: "Sam Hale",
        title: "Sam Hale updated your bag",
        detail: "Sam Hale updated your bag. Open the app to review the latest profile data."
      }
    }
  ];

  function catalogue() { return CATALOGUE.map(function (entry) { return clone(entry); }); }
  function catalogueEntry(id) {
    for (var i = 0; i < CATALOGUE.length; i++) if (CATALOGUE[i].id === id) return clone(CATALOGUE[i]);
    return null;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function isServiceEventType(eventType) {
    return SERVICE_EVENT_TYPES.indexOf(String(eventType || "")) !== -1;
  }

  /* ---- small pure helpers, shared by every template ---- */

  function text(value, limit) {
    var input = String(value == null ? "" : value).trim();
    if (!limit) return input;
    return input.length > limit ? input.slice(0, limit) : input;
  }
  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function firstName(value) {
    return (String(value || "there").trim().split(/\s+/)[0] || "there").replace(/[^\w'-]/g, "") || "there";
  }
  function trimSite(value) {
    return String(value || DEFAULT_SITE).trim().replace(/\/+$/, "") || DEFAULT_SITE;
  }
  function siteHost(value) {
    return trimSite(value).replace(/^https?:\/\//, "");
  }
  function sentenceCase(value) {
    var input = String(value || "");
    return input ? input[0].toUpperCase() + input.slice(1) : input;
  }

  /* ---------------------------------------------------------------------------
     Copy. Every subject/title/detail in the product is written here, so the
     Communications page and the live send are reading the same words.
     --------------------------------------------------------------------------- */
  function compose(eventType, input) {
    input = input || {};
    var site = trimSite(input.siteUrl);
    var actorName = text(input.actorName, 120) || "Clarity Golf Systems";
    var periodLabel = text(input.periodLabel, 40) || "a month";
    var giftLabel = input.membership === false ? "full Clarity access" : "Clarity Membership";
    var expiresLabel = text(input.expiresLabel, 60);
    var expirySentence = expiresLabel ? " Your access runs until " + expiresLabel + " and won't auto-renew or ask for a card." : "";

    if (eventType === "account_created") {
      return {
        subject: "Set up your Clarity account",
        title: "Set up your Clarity account",
        detail: "Your Clarity Caddy account has been created by " + actorName
          + ". Use the secure button below to set your password. This link is unique to your account.",
        ctaLabel: "Set up your password"
      };
    }
    if (eventType === "account_created_comped") {
      /* Deliberately ONE message rather than a setup email plus a comp email a second apart.
         Two emails describing one event read as a mistake, and the second is the one that
         gets ignored - which is the one carrying the thing of value. */
      return {
        subject: "Your Clarity account is ready — with " + periodLabel + " on us",
        title: "Your Clarity account is ready",
        detail: actorName + " has set up your Clarity Caddy account and included " + periodLabel + " of "
          + giftLabel + " — no card, no auto-renewal. Set your password with the button below and your "
          + "access is live the moment you sign in." + expirySentence,
        ctaLabel: "Set your password & get started"
      };
    }
    if (eventType === "comped_access_granted") {
      if (input.hasAccount) {
        return {
          subject: "You've been given " + periodLabel + " of " + giftLabel,
          title: "You've been given " + periodLabel + " of " + giftLabel,
          detail: "Full access has been added to your Clarity account (this email address). There's nothing "
            + "to set up and nothing to pay - open the app and it's live." + expirySentence,
          ctaLabel: "Open Clarity"
        };
      }
      return {
        subject: sentenceCase(periodLabel) + " of " + giftLabel + " is waiting for you",
        title: "You've been given " + periodLabel + " of " + giftLabel,
        detail: "You've been set up with free full access to Clarity Caddy - no card, no auto-renewal. "
          + "It's tied to this email address: set your password below, then sign in on the app or at "
          + siteHost(site) + " and your access unlocks automatically."
          + (expiresLabel ? " Your access runs until " + expiresLabel + "." : ""),
        ctaLabel: "Set your password & get started"
      };
    }
    if (eventType === "password_recovery") {
      return {
        subject: "Reset your Clarity password",
        title: "Reset your Clarity password",
        detail: "Use the secure button below to choose a new password. This link is unique to your account "
          + "and can only be used once. If you did not ask for it, nothing has changed and you can ignore this email.",
        ctaLabel: "Choose a new password"
      };
    }
    if (eventType === "sign_in_email_changed") {
      return {
        subject: "Your Clarity sign-in email has changed",
        title: "Your Clarity sign-in email has changed",
        detail: text(input.detail, 1200) || "The email address you sign in to Clarity with has been changed by " + actorName + ".",
        ctaLabel: "Open Clarity"
      };
    }
    var title = text(input.title, 180) || "Your Clarity account was updated";
    return {
      subject: "Clarity update: " + title,
      title: title,
      detail: text(input.detail, 1200) || "Profile activity was saved in Clarity Caddy.",
      ctaLabel: text(input.ctaLabel, 80) || "Open Clarity"
    };
  }

  /* Fill in everything the layout needs, from a caller's partial input. Exposed on its own so
     the Studio preview can show exactly the message object a live send would build. */
  function buildMessage(eventType, input) {
    input = input || {};
    var site = trimSite(input.siteUrl);
    var copy = compose(eventType, input);
    return {
      eventType: String(eventType || "account_activity"),
      to: text(input.to, 240),
      recipientName: text(input.recipientName, 120) || "there",
      actorName: text(input.actorName, 120) || "Clarity Golf Systems",
      subject: text(input.subject, 140) || copy.subject,
      title: text(input.title, 180) || copy.title,
      detail: text(input.detail, 1200) || copy.detail,
      ctaLabel: text(input.ctaLabel, 80) || copy.ctaLabel,
      ctaUrl: text(input.ctaUrl, 900) || site,
      appStoreUrl: text(input.appStoreUrl, 900),
      logoUrl: text(input.logoUrl, 900) || site + LOGO_PATH,
      siteUrl: site
    };
  }

  /* ---- the one layout ---- */
  function render(message) {
    message = message || {};
    var site = trimSite(message.siteUrl);
    var logo = text(message.logoUrl) || site + LOGO_PATH;
    var recipientName = firstName(message.recipientName);
    var footer = isServiceEventType(message.eventType)
      ? "You are receiving this because it relates to your Clarity account access."
      : "You can change email notifications in Settings &gt; Notifications.";
    var storeCta = message.appStoreUrl
      ? "<p style=\"margin:14px 0 0\"><a href=\"" + escapeHTML(message.appStoreUrl) + "\" style=\"display:inline-flex;align-items:center;min-height:44px\" aria-label=\"Download Clarity Caddy on the App Store\"><img src=\"" + escapeHTML(site + APP_STORE_BADGE) + "\" alt=\"Download Clarity Caddy on the App Store\" width=\"160\" height=\"48\" style=\"display:block;width:160px;height:auto;border:0\"></a></p><p style=\"margin:8px 0 0;color:#b9c4bd;font-size:13px;line-height:1.4\">Download Clarity Caddy, then sign in with this email address.</p>"
      : "";

    var html = [
      "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>",
      "<body style=\"margin:0;background:#07100b;color:#f7faf7;font-family:Arial,Helvetica,sans-serif\">",
      "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#07100b;padding:28px 14px\"><tr><td align=\"center\">",
      "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:560px;background:#101b15;border:1px solid #24342c;border-radius:20px;overflow:hidden\">",
      "<tr><td style=\"padding:24px 24px 16px;background:#07100b\"><img src=\"" + escapeHTML(logo) + "\" width=\"44\" height=\"44\" alt=\"Clarity Golf\" style=\"vertical-align:middle;margin-right:12px\"><span style=\"font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#b9c4bd;font-weight:700\">Clarity Golf Systems</span></td></tr>",
      "<tr><td style=\"padding:24px\">",
      "<p style=\"margin:0 0 10px;color:#42b66a;font-weight:700\">Hi " + escapeHTML(recipientName) + ",</p>",
      "<h1 style=\"margin:0 0 12px;color:#fff;font-size:28px;line-height:1.05\">" + escapeHTML(message.title) + "</h1>",
      "<p style=\"margin:0 0 18px;color:#c8d1cc;font-size:16px;line-height:1.45\">" + escapeHTML(message.detail) + "</p>",
      "<p style=\"margin:0 0 22px;color:#8fa199;font-size:13px;line-height:1.4\">Update from " + escapeHTML(message.actorName) + ".</p>",
      "<a href=\"" + escapeHTML(message.ctaUrl) + "\" style=\"display:inline-block;background:#ff9f2f;color:#06110b;text-decoration:none;font-weight:800;border-radius:999px;padding:12px 18px\">" + escapeHTML(message.ctaLabel) + "</a>",
      storeCta,
      "</td></tr>",
      "<tr><td style=\"padding:16px 24px 24px;color:#708178;font-size:12px;line-height:1.45\">" + footer + "</td></tr>",
      "</table></td></tr></table></body></html>"
    ].join("");

    var body = [
      "Hi " + recipientName,
      "",
      message.title,
      "",
      message.detail,
      "",
      "Update from " + message.actorName + ".",
      "",
      message.ctaUrl
    ].concat(message.appStoreUrl
      ? ["", "Download Clarity Caddy and sign in with this email address:", message.appStoreUrl]
      : []).join("\n");

    return { subject: message.subject, html: html, text: body };
  }

  /* One call for a caller that has raw inputs and wants a sendable message. */
  function build(eventType, input) {
    var message = buildMessage(eventType, input);
    var rendered = render(message);
    return { message: message, subject: rendered.subject, html: rendered.html, text: rendered.text };
  }

  return {
    DEFAULT_SITE: DEFAULT_SITE,
    DEFAULT_FROM: DEFAULT_FROM,
    SERVICE_EVENT_TYPES: SERVICE_EVENT_TYPES.slice(),
    catalogue: catalogue,
    catalogueEntry: catalogueEntry,
    isServiceEventType: isServiceEventType,
    compose: compose,
    buildMessage: buildMessage,
    render: render,
    build: build
  };
});
