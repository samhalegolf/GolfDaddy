/* What this session is allowed to do with a round.
 *
 * The rangefinder - where you are, how far it is - needs no account and no
 * membership. App Store guideline 5.1.1(v) requires that features which are
 * not account based stay reachable without registering, and this one genuinely
 * is not: nothing in gps.js, distance.js, pin.js, basemap.js or painter.js
 * reads an account or an entitlement. Build 740 was rejected because the auth
 * gate locked them anyway.
 *
 * The bubble is free too (decided 19 Aug), driven by the engine's ghost bag.
 * That is the shop window: a player with no membership sees their dispersion
 * working, and pays to replace the ghost bag with their own club distances.
 * So app/js/bag.js asks this module before it lets anything be edited.
 *
 * What DOES belong to an account is everything that writes something the
 * player comes back to: the scorecard, the round record in Course Data, and
 * resume. Those stay gated, and this module is the one place that decides
 * which is which.
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

  /* Signals that write round history, and the plain-language thing each one
     is for. Everything absent from this list - FIX_RECEIVED, PLACED,
     BALL_MOVED, LOCK, UNLOCK, AIM_DRAGGED, hole navigation - IS the
     rangefinder and stays open. LOCK is deliberately not here: locking a shot
     is how you choose the point distances are measured from. */
  var GATED_SIGNALS = {
    SHOT_END: "log where your shots finish",
    FINISH_OPENED: "log where your shots finish",
    FINISH_LOGGED: "log where your shots finish",
    LOG_OPENED: "log where your shots finish",
    SCORE_SET: "keep score"
  };

  function rangefinderParam() {
    try { return new URLSearchParams(window.location.search).get("rangefinder") === "1"; }
    catch (e) { return false; }
  }

  function signedIn() {
    try { return !!(app.account && app.account.signedIn()); } catch (e) { return false; }
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
  function notice(what) {
    var bar = document.getElementById("accessNotice");
    var label = document.getElementById("accessNoticeLabel");
    var action = document.getElementById("accessNoticeAction");
    if (!bar || !label || !action) return;

    if (signedIn()) {
      label.textContent = "A Clarity membership is needed to " + what + ". Distances stay free.";
      action.textContent = "Membership";
      action.onclick = function () { window.location.href = "/?membership=1"; };
    } else {
      label.textContent = "Sign in to " + what + ". Distances stay free.";
      action.textContent = "Sign in";
      action.onclick = function () {
        hideNotice();
        if (typeof app.showRoute === "function") app.showRoute("signin");
        else window.location.href = "/";
      };
    }

    bar.classList.remove("hiddenState");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, NOTICE_MS);
  }

  app.access = {
    roundFeatures: roundFeatures,
    signedIn: signedIn,
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
