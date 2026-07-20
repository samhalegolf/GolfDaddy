/* Native shell bootstrap. Sole owner of native-vs-web platform detection and
   API origin resolution. Must load before every other script: later layers read
   window.GDNative, and the fetch patch has to be installed before any /api call.

   On web this is inert - isNative is false, apiOrigin is "", fetch is untouched,
   and every relative /api/* path resolves same-origin exactly as before. */
(function () {
  "use strict";

  /* Where the Netlify functions live when the app is not served from them.
     Bundled native builds load index.html from the local webview origin
     (capacitor://localhost or http://localhost), so relative /api/* would hit
     the webview itself and 404. */
  var API_ORIGIN = "https://caddy.claritygolf.app";

  function detectPlatform() {
    /* Capacitor injects its global before the first bundled script runs. Fall
       back to the scheme check so this still resolves if that ever changes. */
    var cap = window.Capacitor;
    if (cap && typeof cap.getPlatform === "function") {
      return cap.getPlatform();
    }
    if (location.protocol === "capacitor:") return "ios";
    return "web";
  }

  var platform = detectPlatform();
  var isNative = platform === "ios" || platform === "android";

  window.GDNative = {
    isNative: isNative,
    platform: platform,
    /* Empty on web so callers can concatenate unconditionally. */
    apiOrigin: isNative ? API_ORIGIN : ""
  };

  /* Mark the document early so CSS can reserve safe-area insets before paint,
     matching how gd-auth-reset-route-bootstrap sets its pre-paint classes. */
  var root = document.documentElement;
  if (root && isNative) {
    root.classList.add("gdNative", "gdNative-" + platform);
  }

  if (!isNative) return;

  /* Rewrite relative /api/* to the deployed origin. Patching fetch here keeps
     all 24 call sites across 13 files untouched - they stay relative, which is
     what the web build needs, and stay correct under the native shell. */
  var nativeFetch = window.fetch;
  if (typeof nativeFetch !== "function") return;

  window.fetch = function (input, init) {
    try {
      if (typeof input === "string" && input.indexOf("/api/") === 0) {
        input = API_ORIGIN + input;
      } else if (input && typeof input === "object" && typeof input.url === "string" && input.url.indexOf("/api/") === 0) {
        /* Request objects are immutable, so rebuild rather than assign. */
        input = new Request(API_ORIGIN + input.url, input);
      }
    } catch (err) {
      /* Never let rewriting break the call - fall through to the original. */
    }
    return nativeFetch.call(this, input, init);
  };
})();
