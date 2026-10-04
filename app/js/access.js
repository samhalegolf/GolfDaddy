/* What this session is allowed to do with a round.
 *
 * The rangefinder - where you are, how far it is - needs no account and no
 * membership. App Store guideline 5.1.1(v) requires that features which are
 * not account based stay reachable without registering, and this one genuinely
 * is not: nothing in gps.js, distance.js, pin.js, basemap.js or painter.js
 * reads an account or an entitlement. Build 740 was rejected because the auth
 * gate locked them anyway.
 *
 * The bubble is free too (decided 19 Aug), driven by the engine's ghost bag -
 * and so is the bag itself (decided 30 Aug). Setting your own club distances
 * was the one thing this module gated that a player could see working for
 * free; it is not gated any longer, and app/js/bag.js no longer asks. Its
 * canEdit() asks only whether there is a profile to write the clubs into.
 *
 * What DOES belong to an account is everything that writes something the
 * player comes back to: the scorecard, the round record in Course Data, and
 * logging where shots finish (green focus in every form - boot.js hands the
 * Marshal this module's roundFeatures as canLogShots). Those stay gated, and
 * this module is the one place that decides which is which. Resume is NOT
 * one of them any more (17 Sep): it is a local note of where you were up to,
 * read back by the picker's Continue Round pill, and a guest who backs out to
 * the picker needs it as much as a member does.
 *
 * Two ways to land in rangefinder-only mode:
 *   - no account at all               -> always, whatever the URL says
 *   - ?rangefinder=1 from the picker  -> signed in, no active membership
 *
 * The no-account rule is re-checked live rather than trusted from the URL, so
 * a hand-typed link cannot turn the gate off. The reverse is not true and does
 * not need to be: the picker only appends the param after the paid check has
 * already failed, and marshal effects in boot.js refuse to persist anything
 * regardless, so the worst a forged URL achieves is a free rangefinder.
 */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var NOTICE_MS = 7000;

  /* Signals that write round history, and which feature each one is for:
     "logShots" or "keepScore", the two things the notice below names.
     Everything absent from this list - FIX_RECEIVED, PLACED,
     BALL_MOVED, LOCK, UNLOCK, AIM_DRAGGED, hole navigation - IS the
     rangefinder and stays open. LOCK is deliberately not here: locking a shot
     is how you choose the point distances are measured from. */
  var GATED_SIGNALS = {
    SHOT_END: "logShots",
    FINISH_OPENED: "logShots",
    FINISH_LOGGED: "logShots",
    LOG_OPENED: "logShots",
    SCORE_SET: "keepScore",
    /* The holding screen writes par the moment it opens, so reaching it is
       keeping score whether or not the stepper is ever touched. */
    HOLE_COMPLETED: "keepScore",
    SCORE_STEP: "keepScore"
  };

  function rangefinderParam() {
    try { return new URLSearchParams(window.location.search).get("rangefinder") === "1"; }
    catch (e) { return false; }
  }

  function signedIn() {
    try { return !!(app.account && app.account.signedIn()); } catch (e) { return false; }
  }

  /* Offline course packages are the paid boundary. Keep this lightweight on the GPS page:
     the root shell has already refreshed these caches, and the store entitlement cache is
     itself refreshed on native boot. This mirrors ClarityPayments.hasActiveAccess() without
     loading the whole payments/settings UI into the round surface. */
  function offlineDownloads() {
    var accountSignedIn = signedIn();
    if (accountSignedIn) {
      try {
        var accounts = JSON.parse(localStorage.getItem("gd_accounts_v1") || "null") || {};
        var rows = Array.isArray(accounts.accounts) ? accounts.accounts : [];
        var active = rows.find(function (row) { return row && row.accountId === accounts.activeId; }) || null;
        var role = String(active && active.role || "").trim().toLowerCase();
        if (role === "admin" || role === "coach") return true;
      } catch (e) {}

      /* The backend payment cache belongs to the signed-in account. Do not trust a stale
         active:true after sign-out; a native store entitlement below is the one paid state
         deliberately allowed to survive without an account. */
      try {
        var payment = JSON.parse(localStorage.getItem("clarity:payments:status:v1") || "null");
        if (payment && payment.active) return true;
      } catch (e) {}
    }

    try {
      var store = JSON.parse(localStorage.getItem("clarity:store-entitlement:v1") || "null");
      if (!store || !store.active) return false;
      if (!store.expiresAt) return true;
      var expiry = new Date(store.expiresAt).getTime();
      return Number.isFinite(expiry) && expiry > Date.now();
    } catch (e) { return false; }
  }

  /* True when this session may use the scored-round features. */
  function roundFeatures() {
    return signedIn() && !rangefinderParam();
  }

  var noticeTimer = null;

  function hideNotice() {
    var bar = document.getElementById("accessNotice");
    if (bar) bar.classList.add("hiddenState");
  }

  /* One bar, two audiences: a guest needs an account, a signed-in player
     without a membership needs a plan. Telling them apart matters - sending a
     signed-in player to a sign-in form is the kind of dead end that gets an
     app rejected in the first place. */
  var NOTICE_KEYS = {
    logShots: { guest: "access.signInLogShots", member: "access.memberLogShots" },
    keepScore: { guest: "access.signInKeepScore", member: "access.memberKeepScore" }
  };

  function notice(feature) {
    var keys = NOTICE_KEYS[feature] || NOTICE_KEYS.keepScore;
    var i18n = window.GDI18n;
    var bar = document.getElementById("accessNotice");
    var label = document.getElementById("accessNoticeLabel");
    var action = document.getElementById("accessNoticeAction");
    if (!bar || !label || !action) return;

    if (signedIn()) {
      i18n.set(label, keys.member);
      i18n.set(action, "access.membership");
      action.onclick = function () { window.location.href = "/?membership=1"; };
    } else {
      i18n.set(label, keys.guest);
      i18n.set(action, "common.signIn");
      action.onclick = function () {
        hideNotice();
        if (typeof app.showRoute === "function") app.showRoute("signin");
        else window.location.href = "/";
      };
    }

    action.classList.remove("hiddenState");
    bar.classList.remove("hiddenState");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, NOTICE_MS);
  }

  /* Course preparation/save failures use the same unobtrusive top bar but are not scored-round
     gates. In particular, a free signed-in player may VIEW a fetched package online; only
     writing it into the offline library is paid. */
  function courseIssue(kind) {
    var i18n = window.GDI18n;
    var bar = document.getElementById("accessNotice");
    var label = document.getElementById("accessNoticeLabel");
    var action = document.getElementById("accessNoticeAction");
    if (!bar || !label || !action) return;

    action.classList.add("hiddenState");
    action.onclick = null;
    if (kind === "guest-signup-required") {
      i18n.set(label, "access.freeAccountCourseMaps");
      i18n.set(action, "access.freeAccount");
      action.classList.remove("hiddenState");
      action.onclick = function () { window.location.href = "/?login=1"; };
    } else if (kind === "account-verification-unavailable") {
      i18n.set(label, "access.accountCheckFailed");
      i18n.set(action, "access.tryAgain");
      action.classList.remove("hiddenState");
      action.onclick = function () { window.location.reload(); };
    } else if (kind === "storage") {
      i18n.set(label, "access.offlineStorageFull");
    } else {
      i18n.set(label, "access.mapServerBusy");
    }

    bar.classList.remove("hiddenState");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, kind === "guest-signup-required" ? 12000 : NOTICE_MS);
  }

  app.access = {
    roundFeatures: roundFeatures,
    signedIn: signedIn,
    offlineDownloads: offlineDownloads,
    courseIssue: courseIssue,
    /* Returns false AND explains itself, so callers stay one line. */
    signalAllowed: function (name) {
      if (!GATED_SIGNALS[name] || roundFeatures()) return true;
      notice(GATED_SIGNALS[name]);
      return false;
    },
    prompt: notice,
    hidePrompt: hideNotice
  };

  document.addEventListener("DOMContentLoaded", function () {
    var dismiss = document.getElementById("accessNoticeDismiss");
    if (dismiss) dismiss.addEventListener("click", hideNotice);
  });
})();
