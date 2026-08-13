(function () {
  "use strict";

  /**
   * "Open in Clarity Caddy" — the arrival end of the Booking deep link.
   *
   * Booking sends the coach here as:
   *
   *     https://caddy.claritygolf.app/?clarityPlayer=<shared auth user id>
   *
   * The URL is a pointer, never a grant. Everything below runs against the
   * signed-in coach's own account state, and switching to the player's profile
   * still goes through gdAccountViewProfile, which throws unless that player is
   * in this coach's linked list. A stranger pasting the same URL sees nothing.
   *
   * The shared auth user id is used rather than email, so this keeps working if
   * a player changes their address.
   */

  var PARAM = "clarityPlayer";
  var MAX_WAIT_MS = 12000;
  var POLL_MS = 250;

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function requestedPlayerId() {
    return safe(function () {
      return new URLSearchParams(window.location.search || "").get(PARAM) || "";
    }, "");
  }

  /** Drops the parameter so a refresh, or a shared screenshot, is not a re-entry. */
  function clearParam() {
    safe(function () {
      var url = new URL(window.location.href);
      url.searchParams.delete(PARAM);
      window.history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
    });
  }

  function accountsApi() {
    return window.GolfDaddyAccounts || window.ClarityCaddieAccounts || null;
  }

  function allAccounts(api) {
    var state = safe(function () { return api.state(); }, null);
    return (state && Array.isArray(state.accounts)) ? state.accounts : [];
  }

  function matchesPlayer(account, wanted) {
    if (!account) return false;
    var lower = String(wanted).toLowerCase();
    return (
      String(account.supabaseUserId || "").toLowerCase() === lower ||
      String(account.authUserId || "").toLowerCase() === lower ||
      String(account.accountId || "").toLowerCase() === lower
    );
  }

  function notify(message) {
    if (safe(function () { return typeof window.gdToast === "function"; }, false)) {
      safe(function () { window.gdToast(message); });
      return;
    }
    // No toast available this early in boot; the console is better than silence.
    if (window.console && console.info) console.info("[clarity] " + message);
  }

  function openPlayer(wanted) {
    var api = accountsApi();
    if (!api) return false;

    var coach = safe(function () { return api.current(); }, null);
    if (!coach) return false;

    var player = allAccounts(api).filter(function (account) {
      return matchesPlayer(account, wanted);
    })[0];

    if (!player) {
      // Their linked players may not have synced to this device yet. Say so
      // rather than implying the player does not exist.
      notify("That player is not on this device yet. Open your player list to sync, then try again.");
      clearParam();
      return true;
    }

    try {
      api.viewProfile(player.profileId);
    } catch (error) {
      // gdAccountViewProfile throws when the coach is not linked to the player.
      // That is the access check doing its job.
      notify("You are not linked to that player in Clarity Caddy.");
      clearParam();
      return true;
    }

    safe(function () {
      if (window.GolfDaddyShell && typeof window.GolfDaddyShell.profile === "function") {
        window.GolfDaddyShell.profile();
      }
    });
    clearParam();
    return true;
  }

  function start() {
    var wanted = requestedPlayerId();
    if (!wanted) return;

    // The accounts API is published at the end of gd-app-core's boot, and a
    // session restore may still be in flight after that. Poll briefly rather
    // than racing it.
    var startedAt = Date.now();
    var timer = window.setInterval(function () {
      if (openPlayer(wanted) || Date.now() - startedAt > MAX_WAIT_MS) {
        window.clearInterval(timer);
      }
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
