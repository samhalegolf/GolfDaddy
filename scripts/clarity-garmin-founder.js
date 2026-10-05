/* Garmin Founder: the offer for players who bring a Garmin.
 *
 * Any signed-in player whose phone has talked to the Clarity Caddy app on a
 * Garmin watch becomes a Garmin Founder, for good. What that unlocks is listed
 * in one place, GARMIN_FOUNDER_FEATURES in clarity-payments.js. This file does
 * the other two jobs:
 *
 *   1. CLAIM. Once a Garmin is selected, reachable and has Clarity Caddy
 *      installed, tell functions/garmin-founder.js. That writes a permanent
 *      row against the account. It is remembered per account on this phone, so
 *      the endpoint is asked once, not every launch.
 *
 *   2. FEEDBACK. Note when the watch was actually used in a round (a message
 *      came back from it), and the next time the player is on the home shell,
 *      ask once how it went, with a button straight into the feedback form. The
 *      same form is always reachable from Settings > Garmin Watch.
 *
 * Loaded in both shells. The play shell (app/index.html) is where the watch
 * talks, so it records use and claims. The home shell (index.html) has the
 * settings page and the feedback form, so it claims and asks.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/garmin-founder";
  var CLAIMED_KEY = "clarity:garmin-founder:v1";   /* { [accountId]: sinceIso } */
  var USE_KEY = "clarity:garmin-use:v1";           /* { usedAt, askedAt, deviceModel } */
  /* After the first ask, ask again only after a further round on the watch and
     at least this long since the last ask. */
  var ASK_AGAIN_MS = 14 * 24 * 60 * 60 * 1000;

  /* Set when the account first becomes a Garmin Founder; cleared once the
     welcome has been shown. The play shell has no toast, so a claim made there
     is welcomed on the home shell. */
  var WELCOME_KEY = "clarity:garmin-founder:welcome";

  var claiming = false;
  var useNotedThisPage = false;

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function L(key, vars) { return window.GDI18n.t(key, vars); }

  function readJson(key, fallback) {
    return safe(function () { return JSON.parse(localStorage.getItem(key) || "null") || fallback; }, fallback);
  }

  function writeJson(key, value) {
    safe(function () { localStorage.setItem(key, JSON.stringify(value)); });
  }

  function plugin() {
    return safe(function () {
      var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeRoundBridge;
      return p && typeof p.garminState === "function" ? p : null;
    }, null);
  }

  function platform() {
    return safe(function () { return window.Capacitor.getPlatform(); }, "") || "";
  }

  function signedIn() {
    return safe(function () { return !!(window.ClaritySupabaseAuth && window.ClaritySupabaseAuth.session()); }, false);
  }

  /* Read from the shared accounts store rather than GolfDaddyAccounts, which
     only the home shell loads. */
  function accountId() {
    return safe(function () {
      var store = JSON.parse(localStorage.getItem("gd_accounts_v1") || "null") || {};
      return String(store.activeId || "");
    }, "");
  }

  function claimedFor(id) {
    return !!(id && readJson(CLAIMED_KEY, {})[id]);
  }

  function rememberClaim(id, since) {
    var claimed = readJson(CLAIMED_KEY, {});
    claimed[id] = since || new Date().toISOString();
    writeJson(CLAIMED_KEY, claimed);
  }

  /* A Garmin counts as connected when it is the chosen watch, it is in reach,
     and it says Clarity Caddy is installed on it. A watch that was only picked
     in Garmin Connect, or that has never had the app, does not. */
  function garminConnected(state) {
    return !!(state && state.selectedDevice && state.reachable && state.appInstalled === true);
  }

  function readGarminState() {
    var p = plugin();
    if (!p) return Promise.resolve(null);
    return Promise.resolve(safe(function () { return p.garminState(); }, null)).catch(function () { return null; });
  }

  async function claim(state) {
    var id = accountId();
    if (claiming || !id || !signedIn() || claimedFor(id)) return false;
    /* Already on the account (another phone, or a reinstall): nothing to ask. */
    var known = safe(function () { return window.ClarityPayments.status().garminFounder; }, null);
    if (known && known.active) { rememberClaim(id, known.since); return false; }

    claiming = true;
    try {
      var token = await window.ClaritySupabaseAuth.freshAccessToken();
      if (!token) return false;
      var device = (state && state.selectedDevice) || {};
      var response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ platform: platform(), deviceModel: device.model || "" })
      });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok || !body.garminFounder || !body.garminFounder.active) return false;
      /* The account may have changed while the request was out. */
      if (accountId() !== id) return false;
      rememberClaim(id, body.garminFounder.since);
      if (body.created) {
        safe(function () { localStorage.setItem(WELCOME_KEY, "1"); });
        showWelcome();
      }
      /* Re-read access so the Starter Bubble opens now, then redraw the
         Garmin page with the new status. */
      var refreshed = safe(function () { return window.ClarityPayments && window.ClarityPayments.refresh({ silent: true }); }, null);
      Promise.resolve(refreshed).catch(function () {}).then(function () {
        safe(function () { if (window.ClarityGarmin) window.ClarityGarmin.render(); });
      });
      return true;
    } catch (error) {
      return false;
    } finally {
      claiming = false;
    }
  }

  function showWelcome() {
    if (typeof window.toast !== "function") return;
    if (safe(function () { return localStorage.getItem(WELCOME_KEY); }, null) !== "1") return;
    safe(function () { localStorage.removeItem(WELCOME_KEY); });
    safe(function () { window.toast(L("garminFounder.welcome")); });
  }

  /* Look at the watch and claim if it qualifies. Safe to call often. */
  function check() {
    if (!plugin() || !signedIn() || claimedFor(accountId())) return Promise.resolve(false);
    return readGarminState().then(function (state) {
      return garminConnected(state) ? claim(state) : false;
    });
  }

  /* ------------------------------------------------------------- feedback */

  /* Called when a message arrives from a watch. On iOS the Apple Watch uses
     the same events, so it only counts when the Garmin is the one in reach. */
  function noteUse() {
    if (useNotedThisPage) return;
    readGarminState().then(function (state) {
      if (!garminConnected(state) || useNotedThisPage) return;
      useNotedThisPage = true;
      var use = readJson(USE_KEY, {});
      use.usedAt = new Date().toISOString();
      use.deviceModel = (state.selectedDevice && state.selectedDevice.model) || use.deviceModel || "";
      writeJson(USE_KEY, use);
      claim(state);
    });
  }

  function shouldAsk() {
    var use = readJson(USE_KEY, {});
    var usedAt = Date.parse(use.usedAt || "");
    if (!Number.isFinite(usedAt)) return false;
    var askedAt = Date.parse(use.askedAt || "");
    if (!Number.isFinite(askedAt)) return true;
    return usedAt > askedAt && Date.now() - askedAt >= ASK_AGAIN_MS;
  }

  function markAsked() {
    var use = readJson(USE_KEY, {});
    use.askedAt = new Date().toISOString();
    writeJson(USE_KEY, use);
  }

  function openFeedback() {
    var use = readJson(USE_KEY, {});
    safe(function () {
      window.ClaritySupport.open({ topic: "garmin", deviceModel: use.deviceModel || "" });
    });
    return false;
  }

  function closeAsk() {
    var node = document.getElementById("clarityGarminAsk");
    if (node) node.remove();
  }

  /* One small sheet, in the support form's own styling. Answering either way
     counts as asked. */
  function ask() {
    if (document.getElementById("clarityGarminAsk") || !window.ClaritySupport) return;
    markAsked();
    var overlay = document.createElement("div");
    overlay.id = "clarityGarminAsk";
    overlay.className = "claritySupportOverlay open";
    overlay.innerHTML = [
      '<div class="claritySupportSheet" role="dialog" aria-modal="true" aria-labelledby="clarityGarminAskTitle">',
      '<div class="claritySupportHead"><div>',
      '<strong id="clarityGarminAskTitle" data-i18n="garminFounder.askTitle"></strong>',
      '<span data-i18n="garminFounder.askBody"></span>',
      "</div></div>",
      '<div class="claritySupportActions">',
      '<button type="button" data-garmin-ask="later" data-i18n="garminFounder.askLater"></button>',
      '<button type="button" class="primary" data-garmin-ask="send" data-i18n="garminFounder.askSend"></button>',
      "</div></div>"
    ].join("");
    document.body.append(overlay);
    window.GDI18n.apply(overlay);
    overlay.addEventListener("click", function (event) {
      var action = event.target && event.target.getAttribute && event.target.getAttribute("data-garmin-ask");
      if (event.target === overlay || action === "later") closeAsk();
      if (action === "send") { closeAsk(); openFeedback(); }
    });
  }

  /* Home shell only: that is where the form lives and where a player lands
     after a round. Waits for boot to settle so it never opens over a loader. */
  function maybeAsk() {
    if (!window.ClaritySupport || !shouldAsk()) return;
    if (document.hidden) return;
    ask();
  }

  /* ------------------------------------------------------------- wiring */

  function listenToWatch() {
    var p = plugin();
    if (!p || typeof p.addListener !== "function") return;
    ["watchCommand", "watchMapInventory", "watchPlayerInventory"].forEach(function (name) {
      safe(function () { p.addListener(name, noteUse); });
    });
    safe(function () { p.addListener("watchState", function () { check(); }); });
  }

  function start() {
    if (!plugin()) return;
    listenToWatch();
    setTimeout(check, 1500);
    setTimeout(function () { showWelcome(); maybeAsk(); }, 2500);
    window.addEventListener("clarity:session-changed", function () { check(); });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { check(); maybeAsk(); }
    });
  }

  window.ClarityGarminFounder = {
    check: check,
    openFeedback: openFeedback,
    /* Exposed for tests. */
    _garminConnected: garminConnected,
    _shouldAsk: shouldAsk
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
