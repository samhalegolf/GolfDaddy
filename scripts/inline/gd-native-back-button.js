/* Android hardware back button. Sole owner of the native back gesture.
 *
 * Android's convention is that back unwinds one level and exits from the root.
 * Without this the button exits the app from anywhere, losing an in-progress
 * round - the single worst thing it could do in a GPS app.
 *
 * GDShell.back() already encodes the app's real back semantics (module closes,
 * course picker returns home, GPS defers to the play runtime), so this resolves
 * what is on top and then delegates rather than reimplementing any of it.
 *
 * Inert on web and on iOS, which has no hardware back button. */
(function () {
  "use strict";

  /* Full-screen overlays that sit outside shell routing and must be dismissed
     before the shell route is considered. Ordered most-recent-first. */
  var OVERLAYS = [
    { selector: "#clarityReferralLanding", close: function () {
      if (window.ClarityPayments && typeof window.ClarityPayments.closeReferralLanding === "function") {
        window.ClarityPayments.closeReferralLanding();
        return true;
      }
      var el = document.getElementById("clarityReferralLanding");
      if (el && el.parentNode) { el.parentNode.removeChild(el); return true; }
      return false;
    } }
  ];

  function isNativeAndroid() {
    return !!(window.GDNative && window.GDNative.isNative && window.GDNative.platform === "android");
  }

  function appPlugin() {
    var cap = window.Capacitor;
    return cap && cap.Plugins && cap.Plugins.App ? cap.Plugins.App : null;
  }

  function dismissOverlay() {
    for (var i = 0; i < OVERLAYS.length; i += 1) {
      var entry = OVERLAYS[i];
      if (document.querySelector(entry.selector)) {
        try { if (entry.close()) return true; } catch (_e) {}
      }
    }
    return false;
  }

  /* A panel left open while the shell thinks it is on another route - closing it
     is still the right response to back, and it beats exiting the app. */
  function closeStrayPanel() {
    var open = document.querySelector(".modulePanel.open, .panel.open");
    if (!open) return false;
    open.classList.remove("open");
    return true;
  }

  function shellRoute() {
    try {
      var state = window.GDShell && typeof window.GDShell.getState === "function"
        ? window.GDShell.getState() : null;
      return state && state.route ? String(state.route) : "";
    } catch (_e) {
      return "";
    }
  }

  function handleBack() {
    if (dismissOverlay()) return;

    var route = shellRoute();

    /* Root routes. 'auth' counts as root: there is nowhere to go back to when
       signed out, and trapping the user there would be worse than exiting. */
    if (route === "home" || route === "auth" || !route) {
      if (closeStrayPanel()) return;
      var api = appPlugin();
      if (api && typeof api.exitApp === "function") api.exitApp();
      return;
    }

    try {
      window.GDShell.back({ source: "native-back-button" });
    } catch (_e) {
      /* If the shell throws, closing something is still better than exiting. */
      if (!closeStrayPanel()) {
        var fallback = appPlugin();
        if (fallback && typeof fallback.exitApp === "function") fallback.exitApp();
      }
    }
  }

  function install() {
    var api = appPlugin();
    if (!api || typeof api.addListener !== "function") return false;
    api.addListener("backButton", handleBack);
    return true;
  }

  window.GDNativeBackButton = {
    /* Exposed so the behaviour can be exercised without a hardware key. */
    handleBack: handleBack,
    installed: false
  };

  if (!isNativeAndroid()) return;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      window.GDNativeBackButton.installed = install();
    }, { once: true });
  } else {
    window.GDNativeBackButton.installed = install();
  }
})();
