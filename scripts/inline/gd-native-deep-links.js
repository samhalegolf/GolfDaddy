/* Deep link handling for the native shells.
 *
 * Password reset and account setup emails link to
 * https://caddy.claritygolf.app/?claritySetPassword=1. On the web that URL IS
 * the page, so location.search carries the parameters and everything works.
 *
 * In the app it does not. Bundled assets load from https://localhost, so a
 * verified App Link opens the app at the LOCAL origin with an empty query
 * string, and the incoming URL arrives separately as an event. Without this the
 * app would open, show the normal signed-out screen, and silently drop the
 * reset - which looks like the link not working.
 *
 * Two arrival paths, both needed:
 *   cold start  - the app was not running; App.getLaunchUrl() has the URL
 *   warm start  - the app was already running; the appUrlOpen event fires
 *
 * The parameters are copied onto the local URL and the page is reloaded, so
 * every existing check that reads location.search keeps working untouched.
 * Reloading rather than re-dispatching is deliberate: the reset route is read by
 * a pre-paint bootstrap and by several modules during startup, and re-running
 * that reliably is not something a re-dispatch can promise.
 */
(function () {
  "use strict";

  /* Only parameters that mean something to this app. Copying an arbitrary query
     string from an external link onto our own URL would let a crafted link put
     whatever it liked into the app's startup state. */
  var ALLOWED_PARAMS = [
    "claritySetPassword",
    "setPassword",
    "clarityResetPassword",
    "resetPassword",
    "clarityAccountSetup",
    "accountSetup",
    "referral",
    "referralToken"
  ];
  var HANDLED_GUARD = "gd_deep_link_handled_v1";

  function safe(fn, fallback) {
    try { return fn(); } catch (_e) { return fallback; }
  }

  function isNative() {
    return !!(window.GDNative && window.GDNative.isNative);
  }

  function appPlugin() {
    var cap = window.Capacitor;
    return cap && cap.Plugins && cap.Plugins.App ? cap.Plugins.App : null;
  }

  /* Returns the allowed parameters from an incoming URL, or null if it carries
     nothing we act on - in which case the app just opens normally. */
  function actionableParams(rawUrl) {
    return safe(function () {
      if (!rawUrl) return null;
      var url = new URL(String(rawUrl));
      var found = new URLSearchParams();
      ALLOWED_PARAMS.forEach(function (name) {
        var value = url.searchParams.get(name);
        if (value !== null) found.set(name, value);
      });
      /* Supabase recovery links carry their token in the fragment, which is not
         part of search and would be lost if only the query were copied. */
      var hash = String(url.hash || "");
      var carriesToken = /access_token=|type=recovery/.test(hash);
      var query = found.toString();
      if (!query && !carriesToken) return null;
      return { query: query, hash: carriesToken ? hash : "" };
    }, null);
  }

  function apply(parts, reason) {
    if (!parts) return false;
    /* One handling per launch. Without this, an appUrlOpen that arrives during
       startup could reload into a state that fires it again. */
    var already = safe(function () { return sessionStorage.getItem(HANDLED_GUARD); }, null);
    var signature = reason + ":" + parts.query + parts.hash;
    if (already === signature) return false;
    safe(function () { sessionStorage.setItem(HANDLED_GUARD, signature); });

    var target = location.pathname + (parts.query ? "?" + parts.query : "") + (parts.hash || "");
    safe(function () { history.replaceState(null, "", target); });
    safe(function () { location.reload(); });
    return true;
  }

  function handleUrl(rawUrl, reason) {
    var parts = actionableParams(rawUrl);
    if (!parts) return false;
    return apply(parts, reason);
  }

  async function start() {
    if (!isNative()) return;
    var api = appPlugin();
    if (!api) return;

    /* Warm start: the app was already open when the link was tapped. */
    safe(function () {
      if (typeof api.addListener !== "function") return;
      api.addListener("appUrlOpen", function (event) {
        safe(function () { handleUrl(event && event.url, "open"); });
      });
    });

    /* Cold start: the app was launched by the link. */
    try {
      if (typeof api.getLaunchUrl === "function") {
        var launch = await api.getLaunchUrl();
        if (launch && launch.url) handleUrl(launch.url, "launch");
      }
    } catch (_e) {
      /* A missing launch URL is the normal case - the app was opened from its
         icon. Never fatal. */
    }
  }

  window.GDDeepLinks = {
    params: function () { return ALLOWED_PARAMS.slice(); },
    /* Exposed so the behaviour can be exercised without a real link. */
    handleUrl: handleUrl,
    actionableParams: actionableParams
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { safe(start); }, { once: true });
  } else {
    safe(start);
  }
})();
