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
  /* PNG, not the SVG the web pages use. Gmail - the client most of these land in - does not
     render SVG in email at all, so the badge was simply missing for most recipients. These are
     rasterised at 3x the display width so they stay sharp on a phone. */
  /* Both rendered at the same HEIGHT with each badge's own width, because a row of badges is
     read off its baseline - a shared width with drifting heights is what looks wrong. The
     widths are each asset's true aspect ratio at 47px, so neither official badge is stretched.
     Assets are rasterised at 3x that for retina. */
  var BADGE_HEIGHT = 47;
  var APP_STORE_BADGE = { path: "/assets/brand/app-store-badge.png", width: 159, label: "Download Clarity Caddy on the App Store" };
  var PLAY_STORE_BADGE = { path: "/assets/brand/google-play-badge.png", width: 158, label: "Get Clarity Caddy on Google Play" };

  /* A "service" email describes a change to the recipient's own account access. It is sent
     regardless of the EMAIL_NOTIFICATIONS_ENABLED switch and regardless of the recipient's
     notification preference, because suppressing it would leave someone holding an account
     or an entitlement they were never told about. Everything else is an "activity" email and
     is opt-in at both levels. */
  var SERVICE_EVENT_TYPES = [
    "account_created",
    "account_created_comped",
    "password_recovery",
    "player_welcome",
    "player_signup_basic",
    "player_signup_comped",
    "coach_invite_basic",
    "coach_invite_comped",
    "player_signup_welcome",
    "comped_access_granted",
    "sign_in_email_changed"
  ];

  /* ---------------------------------------------------------------------------
     The Studio-managed templates.

     Four independent messages, not one with switches. Which one goes out is never a setting:
     it is decided by what actually happened - who created the account, and whether comped
     access was really issued. They are expected to diverge, so none of them is defined as
     "another one plus a paragraph".

       coach_invite_basic     a coach or admin created the account. No comped access.
       coach_invite_comped    same, but comped access WAS successfully issued.
       player_signup_welcome  the player signed themselves up. No coach, no setup link -
                              they already chose their own password, so "set your password"
                              and {{coachName}} would both be lies.
       coach_updated_account  a coach changed something on a player's account. Throttled to
                              one per player per 30 minutes, server-side.

     Studio edits the CONTENT. The shell, the escaping and the final HTML stay here.
     --------------------------------------------------------------------------- */
  var TEMPLATE_GROUP_WELCOME = "Welcome Emails";
  var TEMPLATE_GROUP_UPDATES = "Account Updates";
  var EDITABLE_TEMPLATE_KEYS = ["coach_invite_basic", "coach_invite_comped", "player_signup_welcome", "coach_updated_account"];
  /* The keys these shipped under before Coach Invite and Sign Up Welcome were separated.
     An older stored row, or an older caller, still resolves rather than falling through to
     un-editable copy. */
  var LEGACY_TEMPLATE_KEYS = {
    player_welcome: "coach_invite_basic",
    player_signup_basic: "coach_invite_basic",
    player_signup_comped: "coach_invite_comped",
    account_created: "coach_invite_basic",
    account_created_comped: "coach_invite_comped"
  };
  /* account_activity is deliberately NOT mapped here. It still carries player -> coach
     updates and the Settings test email, and collapsing it into coach_updated_account would
     tell a coach that their coach had updated their account. The client names
     coach_updated_account explicitly for the one direction that means it. */
  /* How often coach_updated_account may reach one player. Deliberately not a queue: a coach
     saving a bag, then a profile, then some shot data is ONE thing that happened to the
     player, and three emails describing it is how a useful notification becomes noise people
     filter. Everything inside the window is dropped, not deferred - a delayed duplicate is
     still a duplicate. */
  var COACH_UPDATE_THROTTLE_MINUTES = 30;

  var TEMPLATE_VARIABLES = [
    { key: "firstName", note: "Alex" },
    { key: "fullName", note: "Alex Fenwick" },
    { key: "email", note: "the address the email went to" },
    { key: "coachName", note: "whoever created the account or made the change" },
    { key: "appUrl", note: "caddy.claritygolf.app" },
    { key: "appStoreUrl", note: "the App Store listing" },
    { key: "playStoreUrl", note: "the Google Play listing" },
    { key: "accessType", note: "comped invite only - \"a month of Clarity Membership\"" },
    { key: "accessUntil", note: "comped invite only - the date the access ends" }
  ];

  function isEditableTemplateKey(key) {
    return EDITABLE_TEMPLATE_KEYS.indexOf(String(key || "")) !== -1;
  }
  /* One place that turns anything a caller might hold - a current key, a key from before the
     split, a stale event type - into a key that exists. */
  function resolveTemplateKey(key) {
    var input = String(key || "");
    if (isEditableTemplateKey(input)) return input;
    return LEGACY_TEMPLATE_KEYS[input] || EDITABLE_TEMPLATE_KEYS[0];
  }
  /* Which welcome template a coach-created account gets. The ONLY input is whether the
     entitlement was actually written. */
  function coachInviteKey(comped) {
    return comped ? "coach_invite_comped" : "coach_invite_basic";
  }

  /* ---------------------------------------------------------------------------
     The catalogue: every outbound email, what fires it, and what gates it.
     Studio's Communications page renders this verbatim - so a new sender that is
     not listed here is a sender nobody can audit. Keep them in step.
     --------------------------------------------------------------------------- */
  var CATALOGUE = [
    {
      id: "coach_invite_basic",
      eventType: "coach_invite_basic",
      templateKey: "coach_invite_basic",
      group: TEMPLATE_GROUP_WELCOME,
      label: "Coach Invite — Standard",
      editable: true,
      category: "service",
      recipient: "A player whose account was created FOR them by a coach or admin, without comped access.",
      trigger: "Profile → Players → Create Player Account with the comp tick off. Also the template Admin → Users → Send/Resend Welcome uses for a player with no comped entitlement.",
      gating: "Always sends once the account creation step has succeeded. Service email: not subject to EMAIL_NOTIFICATIONS_ENABLED or the recipient's notification preference.",
      sender: "functions/admin-user-invite.js → functions/email-notification.js, functions/caddy-admin-welcome-email.js",
      cta: "A one-use Supabase set-password link when the player has no login yet; otherwise the destination set on the template, falling back to Clarity.",
      sample: { recipientName: "Alex Fenwick", actorName: "Sam Hale", accountState: "existing", variables: sampleVariables(false) }
    },
    {
      id: "coach_invite_comped",
      eventType: "coach_invite_comped",
      templateKey: "coach_invite_comped",
      group: TEMPLATE_GROUP_WELCOME,
      label: "Coach Invite — Comped",
      editable: true,
      category: "service",
      recipient: "A player whose account was created FOR them by a coach or admin, WITH comped Caddy access.",
      trigger: 'Create Player Account with "Include a comped month" ticked, and only after the entitlement was actually written. Also the template Admin → Users → Resend Welcome uses for a player holding comped access.',
      gating: "Always sends, but only once comped access has been issued successfully. If the entitlement write fails the player gets the standard Coach Invite instead and the admin is told the comp did not happen — nobody is emailed access they do not have.",
      sender: "functions/admin-user-invite.js → functions/email-notification.js, functions/caddy-admin-welcome-email.js",
      cta: "The same set-password link for a new login; otherwise the destination set on the template. Their access is already live when they arrive.",
      sample: { recipientName: "Alex Fenwick", actorName: "Sam Hale", accountState: "needs_setup", ctaUrl: DEFAULT_SITE + "/?claritySetPassword=1", variables: sampleVariables(true) }
    },
    {
      id: "player_signup_welcome",
      eventType: "player_signup_welcome",
      templateKey: "player_signup_welcome",
      group: TEMPLATE_GROUP_WELCOME,
      label: "Sign Up Welcome",
      editable: true,
      category: "service",
      recipient: "Someone who signed themselves up. Nobody invited them and they already chose their own password.",
      trigger: "Self-serve sign-up on the sign-in screen (/api/auth-signup).",
      gating: "Always sends once the account exists. Service email.",
      sender: "scripts/clarity-email.js → functions/email-notification.js",
      cta: "The destination set on the template, falling back to Clarity. No set-password link — they already have a password.",
      sample: { recipientName: "Alex Fenwick", actorName: "Clarity Golf", accountState: "existing", variables: sampleVariables(false) }
    },
    {
      id: "coach_updated_account",
      eventType: "coach_updated_account",
      templateKey: "coach_updated_account",
      group: TEMPLATE_GROUP_UPDATES,
      label: "Coach Updated Your Account",
      editable: true,
      category: "optional",
      recipient: "A player, when a coach linked to them saves a change to their bag, shot data or profile.",
      trigger: "The first such save. Deliberately vague about WHAT changed — one email can cover half an hour of saves, so naming a single one would be right only by luck.",
      gating: "Throttled to one per player per " + COACH_UPDATE_THROTTLE_MINUTES + " minutes, claimed atomically server-side. Everything inside the window is DROPPED, never queued — a delayed duplicate is still a duplicate. The player can turn it off in Settings → Notifications; unlike the other activity mail it is not held back by EMAIL_NOTIFICATIONS_ENABLED, so it works without a server flag being set.",
      sender: "scripts/clarity-email.js → functions/email-notification.js",
      cta: "The destination set on the template, falling back to Clarity.",
      sample: { recipientName: "Alex Fenwick", actorName: "Sam Hale", accountState: "existing", variables: sampleVariables(false) }
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
  /* Two different questions that used to share one list.
     isServiceEventType decides the FOOTER: "this relates to your account access" is only
     honest for mail the recipient cannot switch off. bypassesActivitySwitch decides whether
     the server-wide EMAIL_NOTIFICATIONS_ENABLED flag can suppress it.
     coach_updated_account answers yes to the second and no to the first: it ships working
     without an env var being set, and it still tells the reader where to turn it off. */
  function bypassesActivitySwitch(eventType) {
    return isServiceEventType(eventType) || String(eventType || "") === "coach_updated_account";
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

  /* ---- the two Studio-managed welcome templates ----

     Code-level defaults, deliberately. A Studio row that has never been written, a settings
     read that fails, or a field an admin cleared must all still produce the email that was
     going out before any of this existed - never a blank message to a customer. Every getter
     below falls back field by field, not template by template, so one emptied box cannot
     take the rest of the message with it. */

  /* No greeting line in any default body: render() already prints "Hi <first name>," above
     the headline, and the first version of this template repeated it. {{firstName}} is still
     available to an admin who wants it somewhere else. */
  function defaultSignupTemplate(key) {
    key = resolveTemplateKey(key);

    if (key === "coach_invite_comped") {
      /* Descended from the account_created_comped copy: one message that covers BOTH the
         password step and the comp, because two emails a second apart describing one event
         read as a mistake - and the second one, the one carrying the thing of value, is the
         one that gets ignored. */
      return {
        subject: "Your Clarity account is ready — with {{accessType}} on us",
        headline: "Your Clarity account is ready",
        body: "{{coachName}} has set up your Clarity Caddy account and included {{accessType}} — no card, and it does not auto-renew.\n\nYour access runs until {{accessUntil}}.\n\nClarity Caddy is a golf GPS built around the way you actually play. Use the button below to get started — your access is live the moment you sign in.\n\nClarity Golf",
        ctaLabel: "Get started",
        ctaUrl: ""
      };
    }

    if (key === "player_signup_welcome") {
      /* The one template with no coach in it. This player signed themselves up, chose their
         own password and was invited by nobody, so anything about "your coach" or "set your
         password" would be describing an event that did not happen to them. */
      return {
        subject: "Welcome to Clarity Caddy",
        headline: "Welcome to Clarity Caddy",
        body: "Thanks for signing up.\n\nClarity Caddy is a golf GPS built around the way you actually play — start by building your bag, then let your practice data sharpen it.\n\nYour account is ready and your password is already set. Sign in on the app and everything is there.\n\nClarity Golf",
        ctaLabel: "Open Clarity",
        ctaUrl: ""
      };
    }

    if (key === "coach_updated_account") {
      /* Deliberately generic about WHAT changed. One of these covers up to 30 minutes of a
         coach's saves, so naming a single thing - "updated your bag" - would be wrong the
         moment they also changed something else, and right only by luck. Say that something
         changed and send them to the place they can see it. */
      return {
        subject: "{{coachName}} updated your Clarity account",
        headline: "Your coach updated your account",
        body: "{{coachName}} has updated some information on your Clarity Caddy account.\n\nOpen the app and you will have the latest — everything syncs to your device when you sign in.\n\nClarity Golf",
        ctaLabel: "Open Clarity",
        ctaUrl: ""
      };
    }

    return {
      subject: "Welcome to Clarity Caddy",
      headline: "Welcome to Clarity Caddy",
      body: "Clarity Caddy is a golf GPS built around the way you actually play.\n\nYour account gives you a place to build your bag, bring your practice data into your game, and use Clarity on the course.\n\nUse the button below to get started.\n\nClarity Golf",
      ctaLabel: "Open Clarity",
      ctaUrl: ""
    };
  }

  /* A template destination is a plain link an admin typed, so it is held to the same rule as
     any other untrusted URL: absolute http(s) or nothing. A javascript: or data: destination
     in a branded email from our own domain is the one thing this editor must not be able to
     produce. Empty is fine and means "use the automatic destination". */
  function safeCtaUrl(value) {
    var input = text(value, 900);
    if (!input) return "";
    return /^https?:\/\/[^\s]+$/i.test(input) ? input : "";
  }

  function signupTemplate(key, input) {
    input = input || {};
    key = resolveTemplateKey(key);
    var fallback = defaultSignupTemplate(key);
    return {
      templateKey: key,
      subject: text(input.subject, 140) || fallback.subject,
      headline: text(input.headline, 180) || fallback.headline,
      body: text(input.body, 4000) || fallback.body,
      ctaLabel: text(input.ctaLabel, 80) || fallback.ctaLabel,
      ctaUrl: safeCtaUrl(input.ctaUrl)
    };
  }

  /* Kept because the first welcome template shipped under this name and the stored row, the
     endpoint and the tests all still reach for it. Basic Sign Up is what it always was. */
  function defaultWelcomeTemplate() { return defaultSignupTemplate("player_signup_basic"); }
  function welcomeTemplate(input) { return signupTemplate("player_signup_basic", input); }

  function substituteVariables(value, variables) {
    return String(value == null ? "" : value).replace(/{{\s*([a-zA-Z][a-zA-Z0-9]*)\s*}}/g, function (_all, key) {
      return Object.prototype.hasOwnProperty.call(variables || {}, key) ? String(variables[key] == null ? "" : variables[key]) : "";
    });
  }

  /* Body substitution has one extra rule the single-line fields do not need: a line that
     exists ONLY to state a fact we do not have is dropped rather than printed half-empty.
     "Your access runs until {{accessUntil}}." with no date is a bug the customer reads, and
     the alternative - forbidding the variable in the default copy - loses the expiry line the
     comped email has always carried. A line survives unless it contained at least one
     variable and every one of them resolved to an empty string. */
  function substituteBody(value, variables) {
    var lines = String(value == null ? "" : value).split(/\r?\n/);
    var kept = lines.filter(function (line) {
      var tokens = line.match(/{{\s*[a-zA-Z][a-zA-Z0-9]*\s*}}/g);
      if (!tokens) return true;
      for (var i = 0; i < tokens.length; i++) if (substituteVariables(tokens[i], variables) !== "") return true;
      return false;
    }).map(function (line) { return substituteVariables(line, variables); });
    /* Dropping a line leaves the blank line that separated it, so close the gap - otherwise
       a missing expiry shows up as a hole in the paragraph spacing. And never let the drop
       rule empty the whole message. */
    var out = kept.join("\n").replace(/\n{3,}/g, "\n\n");
    return out.trim() ? out : substituteVariables(value, variables);
  }

  function sampleVariables(comped) {
    var base = {
      firstName: "Alex", fullName: "Alex Fenwick", email: "player@example.com",
      coachName: "Sam Hale", appUrl: DEFAULT_SITE, appStoreUrl: ""
    };
    if (comped) { base.accessType = "a month of Clarity Membership"; base.accessUntil = "3 October 2026"; }
    return base;
  }

  /* What a comp actually is, in the words the email uses. Built from the entitlement that was
     written - periodLabel and expiresLabel come back from writeCompedEntitlement - so the
     message can only describe access that exists. */
  function accessVariables(comped) {
    if (!comped) return { accessType: "", accessUntil: "" };
    var giftLabel = comped.membership === false ? "full Clarity access" : "Clarity Membership";
    var periodLabel = text(comped.periodLabel, 40);
    return {
      accessType: periodLabel ? periodLabel + " of " + giftLabel : giftLabel,
      accessUntil: text(comped.expiresLabel, 60)
    };
  }

  function signupCopy(eventType, input) {
    input = input || {};
    var key = resolveTemplateKey(eventType);
    var template = signupTemplate(key, input.welcomeTemplate);
    var variables = input.variables || {};
    /* The comped template is only ever selected once access has actually been issued, so
       accessType is known. Floor it anyway: a message that says "included  \u2014 no card" is a
       worse failure than one that is slightly vague about which comp it was. */
    if (key === "coach_invite_comped" && !text(variables.accessType)) {
      variables = Object.assign({}, variables, { accessType: "full Clarity access" });
    }
    /* A one-use set-password link cannot be typed into a settings box, so when the send has
       one it beats the template destination, and the button says what the link actually
       does. Everywhere else the admin's destination is honoured. */
    var needsSetup = input.accountState === "needs_setup";
    return {
      subject: substituteVariables(template.subject, variables),
      title: substituteVariables(template.headline, variables),
      detail: substituteBody(template.body, variables),
      ctaLabel: needsSetup ? "Set up your password & get started" : substituteVariables(template.ctaLabel, variables),
      ctaUrl: needsSetup ? text(input.ctaUrl, 900) || trimSite(input.siteUrl)
        : safeCtaUrl(substituteVariables(template.ctaUrl, variables)) || text(input.ctaUrl, 900) || trimSite(input.siteUrl)
    };
  }
  function welcomeCopy(input) { return signupCopy("player_signup_basic", input); }

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

    /* Every Studio-managed event type renders from a stored template, including the keys
       these shipped under before Coach Invite and Sign Up Welcome were separated - an old
       caller must not fall through to un-editable copy. */
    if (isEditableTemplateKey(eventType) || Object.prototype.hasOwnProperty.call(LEGACY_TEMPLATE_KEYS, eventType)) {
      return signupCopy(eventType, input);
    }

    /* account_created and account_created_comped used to have hard-coded branches here. They
       are now the Coach Invite templates and resolve above, via LEGACY_TEMPLATE_KEYS - which
       is what stops an old caller quietly getting copy no admin can edit. */
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
      /* A signup template can carry its own destination, so the composed ctaUrl is
         preferred over the caller's raw one - signupCopy has already decided between
         a secure link, the template destination and the site. */
      ctaUrl: text(copy.ctaUrl, 900) || text(input.ctaUrl, 900) || site,
      appStoreUrl: text(input.appStoreUrl, 900),
      playStoreUrl: text(input.playStoreUrl, 900),
      logoUrl: text(input.logoUrl, 900) || site + LOGO_PATH,
      siteUrl: site
    };
  }

  /* The download row.
   *
   * A table rather than inline-block: Outlook renders the body through Word, which ignores
   * inline-block and stacks the badges with no control over the gap. Explicit width AND
   * height on every img, because a client that blocks images still has to lay out a box the
   * right shape - and because the Apple asset is intrinsically SQUARE, so the old
   * width:160px;height:auto rendered a 160x160 tile with the badge adrift in the middle of it,
   * silently overriding the height="48" sitting right next to it.
   *
   * Both stores or neither is not the rule: whichever URLs the caller has are shown, so a
   * platform that is not live yet simply does not appear. */
  function storeBadge(url, badge, site) {
    return '<a href="' + escapeHTML(url) + '" style="display:block;text-decoration:none" aria-label="' + escapeHTML(badge.label) + '">'
      + '<img src="' + escapeHTML(site + badge.path) + '" alt="' + escapeHTML(badge.label) + '"'
      + ' width="' + badge.width + '" height="' + BADGE_HEIGHT + '"'
      + ' style="display:block;width:' + badge.width + 'px;height:' + BADGE_HEIGHT + 'px;border:0"></a>';
  }
  function storeBadges(message, site) {
    var cells = [];
    if (message.appStoreUrl) cells.push(storeBadge(message.appStoreUrl, APP_STORE_BADGE, site));
    if (message.playStoreUrl) cells.push(storeBadge(message.playStoreUrl, PLAY_STORE_BADGE, site));
    if (!cells.length) return "";
    return '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0 0"><tr>'
      + cells.map(function (cell, index) {
          return '<td style="padding:0 ' + (index < cells.length - 1 ? "10" : "0") + 'px 0 0">' + cell + "</td>";
        }).join("")
      + "</tr></table>"
      + '<p style="margin:8px 0 0;color:#b9c4bd;font-size:13px;line-height:1.4">Download Clarity Caddy, then sign in with this email address.</p>';
  }

  /* ---- the one layout ---- */
  function render(message) {
    message = message || {};
    var site = trimSite(message.siteUrl);
    var logo = text(message.logoUrl) || site + LOGO_PATH;
    var recipientName = firstName(message.recipientName);
    /* Editable welcome copy is plain text, never HTML. Preserve its intentional
       paragraph breaks only after escaping, so an admin cannot turn a template
       field into markup. */
    var detailHtml = escapeHTML(message.detail).replace(/\r?\n/g, "<br>");
    var footer = isServiceEventType(message.eventType)
      ? "You are receiving this because it relates to your Clarity account access."
      : "You can change email notifications in Settings &gt; Notifications.";
    var storeCta = storeBadges(message, site);

    var html = [
      /* charset first, and before anything else in <head>. The copy is full of em dashes and
         curly quotes; without this a client that does not inherit the transport encoding
         renders them as "a\u20ac\u201d" mojibake, which is exactly how the comped invite read in
         preview. It has to be inside the first 1024 bytes to be honoured, so it leads. */
      "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>",
      "<body style=\"margin:0;background:#07100b;color:#f7faf7;font-family:Arial,Helvetica,sans-serif\">",
      "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#07100b;padding:28px 14px\"><tr><td align=\"center\">",
      "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:560px;background:#101b15;border:1px solid #24342c;border-radius:20px;overflow:hidden\">",
      "<tr><td style=\"padding:24px 24px 16px;background:#07100b\"><img src=\"" + escapeHTML(logo) + "\" width=\"44\" height=\"44\" alt=\"Clarity Golf\" style=\"vertical-align:middle;margin-right:12px\"><span style=\"font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#b9c4bd;font-weight:700\">Clarity Golf Systems</span></td></tr>",
      "<tr><td style=\"padding:24px\">",
      "<p style=\"margin:0 0 10px;color:#42b66a;font-weight:700\">Hi " + escapeHTML(recipientName) + ",</p>",
      "<h1 style=\"margin:0 0 12px;color:#fff;font-size:28px;line-height:1.05\">" + escapeHTML(message.title) + "</h1>",
      "<p style=\"margin:0 0 18px;color:#c8d1cc;font-size:16px;line-height:1.45\">" + detailHtml + "</p>",
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
    ].concat(message.appStoreUrl || message.playStoreUrl
      ? ["", "Download Clarity Caddy and sign in with this email address:"]
        .concat(message.appStoreUrl ? ["App Store: " + message.appStoreUrl] : [])
        .concat(message.playStoreUrl ? ["Google Play: " + message.playStoreUrl] : [])
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
    EDITABLE_TEMPLATE_KEYS: EDITABLE_TEMPLATE_KEYS.slice(),
    TEMPLATE_GROUP_WELCOME: TEMPLATE_GROUP_WELCOME,
    TEMPLATE_GROUP_UPDATES: TEMPLATE_GROUP_UPDATES,
    COACH_UPDATE_THROTTLE_MINUTES: COACH_UPDATE_THROTTLE_MINUTES,
    TEMPLATE_VARIABLES: TEMPLATE_VARIABLES.map(function (v) { return { key: v.key, note: v.note }; }),
    catalogue: catalogue,
    catalogueEntry: catalogueEntry,
    isServiceEventType: isServiceEventType,
    bypassesActivitySwitch: bypassesActivitySwitch,
    compose: compose,
    defaultWelcomeTemplate: defaultWelcomeTemplate,
    welcomeTemplate: welcomeTemplate,
    defaultSignupTemplate: defaultSignupTemplate,
    signupTemplate: signupTemplate,
    resolveTemplateKey: resolveTemplateKey,
    isEditableTemplateKey: isEditableTemplateKey,
    coachInviteKey: coachInviteKey,
    accessVariables: accessVariables,
    sampleVariables: sampleVariables,
    safeCtaUrl: safeCtaUrl,
    substituteVariables: substituteVariables,
    welcomeCopy: welcomeCopy,
    buildMessage: buildMessage,
    render: render,
    build: build
  };
});
